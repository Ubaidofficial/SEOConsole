import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db, openDb } from '../src/lib/server/db';
import { SITE_TABS, SITE_TAB_GROUPS } from '../src/lib/explain';
import { PAGE_ICON, TAB_ICON, TAB_TONE } from '../src/lib/icons';
import { TEXT_OPS, describePattern, textFilter } from '../src/lib/textfilter';
import { MENU_PERIODS, PERIOD_KEYS, QUICK_PERIODS, periodKey } from '../src/lib/periods';
import { alertTrends, listAlerts, runAlertRules } from '../src/lib/server/alerts';
import { addDays } from '../src/lib/server/dates';

/** The shared look: page headers, icons, filters, shortcuts and the alert cards' small charts. */

describe('icons', () => {
	it('every site tab has an icon, and every group in the More menu a colour', () => {
		for (const [t] of SITE_TABS) expect(TAB_ICON[t], `tab ${t || '(overview)'}`).toBeTruthy();
		for (const [caption] of SITE_TAB_GROUPS) expect(TAB_TONE[caption], caption).toMatch(/^(blue|amber|green|violet|gray)$/);
		for (const p of ['/', '/chat', '/actions', '/alerts', '/portfolio', '/connect', '/team']) expect(PAGE_ICON[p], p).toBeTruthy();
	});
	it('the top bar keeps four everyday links and moves the rest into the Workspace menu', () => {
		const layout = readFileSync('src/routes/+layout.svelte', 'utf8');
		const top = layout.slice(layout.indexOf('const links = ['), layout.indexOf('] as const;', layout.indexOf('const links = [')));
		expect(top.match(/\['\//g)?.length).toBe(4);
		const ws = layout.slice(layout.indexOf('const workspace = ['));
		for (const p of ['/portfolio', '/sitemaps', '/connect', '/agents', '/accounts', '/team']) expect(ws, p).toContain(`['${p}'`);
	});
});

describe('page headers', () => {
	const pages = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? pages(join(dir, n)) : n === '+page.svelte' ? [join(dir, n)] : []));
	it('every site tab opens with the shared header, named after its tab', () => {
		for (const [t, label] of SITE_TABS) {
			if (t === '') continue; // Overview: the site's own header and KPI cards
			const f = `src/routes/sites/[id]${t}/+page.svelte`;
			const src = readFileSync(f, 'utf8');
			expect(src, f).toMatch(new RegExp(`<PageHeader\\b[^>]*\\btab="${t}"`));
			expect(src.includes(`title="${label}"`) || src.includes('title="Request indexing"'), `${f} title`).toBe(true);
		}
	});
	it('the everyday top-level pages use it too', () => {
		for (const f of ['actions', 'alerts', 'portfolio', 'connect', 'team', 'agents', 'accounts', 'sitemaps', 'updates', 'digest']) expect(readFileSync(`src/routes/${f}/+page.svelte`, 'utf8'), f).toMatch(/<PageHeader\b/);
		expect(pages('src/routes').length).toBeGreaterThan(40);
	});
});

describe('the Queries text filter', () => {
	it('turns plain choices into the include and exclude patterns the server reads', () => {
		expect(TEXT_OPS.map(([k]) => k)).toEqual(['contains', 'not', 'exact', 'any', 'regex']);
		expect(textFilter('contains', ' a.b ')).toEqual({ key: 're', pattern: 'a\\.b' });
		expect(textFilter('not', 'free')).toEqual({ key: 'nre', pattern: 'free' });
		expect(textFilter('exact', 'shoes (red)')).toEqual({ key: 're', pattern: '^shoes \\(red\\)$' });
		expect(textFilter('any', 'shoes, boots,\nsandals,')).toEqual({ key: 're', pattern: 'shoes|boots|sandals' });
		expect(textFilter('regex', '^how|best .* tools')).toEqual({ key: 're', pattern: '^how|best .* tools' });
		expect(textFilter('contains', '   ')).toBeNull();
		expect(textFilter('any', ' , ')).toBeNull();
	});
	it('reads a pattern back in the same words on its chip', () => {
		expect(describePattern('a\\.b', false)).toBe('contains “a.b”');
		expect(describePattern('free', true)).toBe('doesn’t contain “free”'.replace('’', "'"));
		expect(describePattern('^shoes \\(red\\)$', false)).toBe('is “shoes (red)”');
		expect(describePattern('shoes|boots', false)).toBe('any of “shoes”, “boots”');
		expect(describePattern('^how|best .* tools', false)).toBe('matches /^how|best .* tools/');
		expect(describePattern('free|cheap.*', true)).toBe('excludes /free|cheap.*/');
		for (const [op] of TEXT_OPS) {
			const f = textFilter(op, 'a+b')!;
			// every plain choice matches the literal text (for "doesn't contain", that match is what gets excluded); a regex reads + as "one or more"
			expect(new RegExp(f.pattern, 'i').test('A+B'), op).toBe(op !== 'regex');
		}
	});
});

describe('period shortcuts', () => {
	it('one key per period on the picker, none shared', () => {
		const all = [...QUICK_PERIODS, ...MENU_PERIODS] as number[];
		expect(Object.values(PERIOD_KEYS).sort((a, b) => a - b)).toEqual([...all].sort((a, b) => a - b));
		expect(new Set(Object.keys(PERIOD_KEYS)).size).toBe(all.length);
		expect(periodKey(28)).toBe('M');
		expect(periodKey(1)).toBe('D');
		expect(periodKey(39)).toBe('');
	});
});

describe('alert cards', () => {
	const END = '2026-11-15';
	beforeEach(() => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		delete process.env.DIGEST_WEBHOOK_URL;
		process.env.DEMO_MODE = '0';
		process.env.SCHEDULER = '0';
	});
	it('a whole-site clicks alert carries its daily line: the window before and the window it compared', async () => {
		const d = db();
		d.prepare("INSERT INTO accounts (google_sub, email, created_at) VALUES ('sub', 'a@example.com', 0)").run();
		const id = Number(d.prepare("INSERT INTO sites (account_id, site_url, permission, synced_through, backfilled_to, backfill_done, created_at) VALUES (1, 'https://example.com/', 'siteOwner', ?, ?, 1, 0)").run(END, addDays(END, -119)).lastInsertRowid);
		const ins = d.prepare('INSERT INTO site_daily (site_id, date, clicks, impressions, position) VALUES (?,?,?,?,?)');
		for (let i = 0; i < 120; i++) ins.run(id, addDays(END, -i), i < 7 ? 200 : 1000, 20_000, 5);
		await runAlertRules({ siteIds: [id] });
		const alerts = listAlerts({ siteIds: null, siteId: id, status: 'open' });
		const drop = alerts.find((a) => a.kind === 'clicks_drop')!;
		expect(drop).toBeTruthy();
		const t = alertTrends(alerts)[drop.id];
		expect(t.label).toBe('Clicks');
		expect(t.split).toBe(t.values.length - 7);
		expect(t.values.slice(t.split)).toEqual(Array(7).fill(200));
		expect(t.values.slice(0, t.split).every((v) => v === 1000)).toBe(true);
		// counts (searches, pages) get no line: a whole-site line would not be what the rule measured
		for (const a of alerts.filter((x) => !['clicks_drop', 'clicks_rise', 'impressions_drop', 'ctr_drop', 'position_drop'].includes(x.kind))) expect(alertTrends(alerts)[a.id]).toBeUndefined();
	});
});
