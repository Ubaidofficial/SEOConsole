import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { db, openDb } from '../src/lib/server/db';
import { ALERT_KINDS } from '../src/lib/alerts';
import { SITE_TABS } from '../src/lib/explain';
import { ALERT_FIX, addCustomRule, alertCards, alertEvidence, alertFix, closeAlerts, listAlerts, runAlertRules, type AlertEvidence } from '../src/lib/server/alerts';
import { addDays } from '../src/lib/server/dates';

/** The evidence panel of the alert cards: what each rule saw, re-read with the rule's own window and scope. */
const END = '2026-11-15';

function makeSite(daily: (i: number) => number, days = 120): number {
	const d = db();
	d.prepare("INSERT INTO accounts (google_sub, email, created_at) VALUES ('sub', 'a@example.com', 0)").run();
	const id = Number(d.prepare("INSERT INTO sites (account_id, site_url, permission, synced_through, backfilled_to, backfill_done, created_at) VALUES (1, 'https://example.com/', 'siteOwner', ?, ?, 1, 0)").run(END, addDays(END, -(days - 1))).lastInsertRowid);
	const ins = d.prepare('INSERT OR REPLACE INTO site_daily (site_id, date, clicks, impressions, position) VALUES (?,?,?,?,?)');
	for (let i = 0; i < days; i++) ins.run(id, addDays(END, -i), daily(i), 20_000, 5);
	return id;
}
/** Search Analytics rows on days `from`..`to` back from END (0 = END): [query, page, clicks, impressions, position]. */
const rows = (id: number, list: [string, string, number, number, number][], from: number, to: number) => {
	const ins = db().prepare("INSERT OR REPLACE INTO sa_rows (site_id, date, query, page, country, device, clicks, impressions, position) VALUES (?,?,?,?,'usa','DESKTOP',?,?,?)");
	for (let i = from; i <= to; i++) for (const [q, p, c, imp, pos] of list) ins.run(id, addDays(END, -i), q, p, c, imp, pos);
};
const open = (id: number) => listAlerts({ siteIds: null, siteId: id, status: 'open' });
const of = <T extends AlertEvidence['type']>(e: AlertEvidence | undefined, type: T) => {
	expect(e?.type).toBe(type);
	return e as Extract<AlertEvidence, { type: T }>;
};

beforeEach(() => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	delete process.env.DIGEST_WEBHOOK_URL;
	process.env.DEMO_MODE = '0';
	process.env.SCHEDULER = '0';
});

describe('alert evidence', () => {
	it('a pages_drop alert carries the daily clicks of the pages that actually fell, not of the steady ones', async () => {
		const id = makeSite(() => 1000);
		const fell = ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'];
		// the 28 days before the window: 20 clicks a day each; the 28-day window: 2 a day (-90%)
		rows(id, fell.map((p, n) => [`q${n}`, p, 20, 200, 4] as [string, string, number, number, number]), 28, 55);
		rows(id, fell.map((p, n) => [`q${n}`, p, 2, 200, 4] as [string, string, number, number, number]), 0, 27);
		rows(id, [['steady', 'https://example.com/steady', 30, 300, 3]], 0, 55);
		await runAlertRules({ siteIds: [id] });
		const alert = open(id).find((a) => a.kind === 'pages_drop')!;
		expect(alert).toBeTruthy();
		const e = of(alertEvidence(open(id))[alert.id], 'pages');
		expect(e.dim).toBe('page');
		expect(e.total).toBe(3);
		expect(e.items.map((x) => x.key).sort()).toEqual(fell);
		for (const it of e.items) {
			expect(it.values).toHaveLength(56);
			expect(it.split).toBe(28);
			expect(it.values.slice(0, 28).every((v) => v === 20)).toBe(true);
			expect(it.values.slice(28).every((v) => v === 2)).toBe(true);
			expect([it.before, it.now, Math.round(it.pct!)]).toEqual([560, 56, -90]);
		}
		expect(e.facts).toContainEqual({ label: 'Pages', value: '3' });
		expect(e.facts).toContainEqual({ label: 'Clicks lost', value: '1,512' });
		expect(e.facts).toContainEqual({ label: 'Window', value: 'last 28 days vs 28 before' });
	});

	it('a deindexed alert carries its URLs, when each dropped out and the coverage state Google gave', async () => {
		const id = makeSite(() => 1000);
		const now = Date.now();
		const ins = db().prepare('INSERT INTO index_events (site_id, url, at, kind, detail) VALUES (?,?,?,?,?)');
		ins.run(id, 'https://example.com/gone', now - 3 * 86_400_000 - 60_000, 'deindexed', 'Crawled - currently not indexed');
		ins.run(id, 'https://example.com/also-gone', now - 86_400_000, 'deindexed', null);
		ins.run(id, 'https://example.com/old', now - 30 * 86_400_000, 'deindexed', 'Excluded by noindex'); // before the 7-day window
		await runAlertRules({ siteIds: [id] });
		const alert = open(id).find((a) => a.kind === 'deindexed')!;
		expect(alert).toBeTruthy();
		const e = of(alertEvidence(open(id), 40, now)[alert.id], 'index');
		expect(e.total).toBe(2);
		expect(e.urls.map((u) => [u.url, u.state, u.back])).toEqual([
			['https://example.com/also-gone', 'Not indexed', false],
			['https://example.com/gone', 'Crawled - currently not indexed', false]
		]);
		for (const u of e.urls) expect(u.at).toBeGreaterThanOrEqual(e.from);
		expect(e.to).toBe(now);
		expect(e.facts[0]).toEqual({ label: 'Out of Google for', value: '3 days' });
		// a page Google indexed again since shows as back
		ins.run(id, 'https://example.com/gone', now - 3_600_000, 'indexed', null);
		expect(of(alertEvidence(open(id), 40, now)[alert.id], 'index').urls[1]).toMatchObject({ state: 'Back in the index', back: true });
	});

	it('a clicks_drop alert keeps its daily line, and a scoped one sums exactly the pages it watches', async () => {
		const id = makeSite((i) => (i < 7 ? 200 : 1000));
		rows(id, [['blog q', 'https://example.com/blog/post', 50, 1000, 3]], 7, 13);
		rows(id, [['blog q', 'https://example.com/blog/post', 10, 1000, 3]], 0, 6);
		rows(id, [['shop q', 'https://example.com/shop', 40, 1000, 3]], 0, 13);
		expect(addCustomRule(id, { kind: 'clicks_drop', threshold: 25, windowDays: 7, scopeKind: 'page', scopeValue: '/blog/' })).toHaveProperty('id');
		await runAlertRules({ siteIds: [id] });
		const drops = open(id).filter((a) => a.kind === 'clicks_drop');
		expect(drops).toHaveLength(2);
		const ev = alertEvidence(open(id));
		const site = of(ev[drops.find((a) => !a.title.includes('/blog/'))!.id], 'trend');
		expect(site.scope).toBe('Whole site');
		expect(site.trend.split).toBe(7);
		expect(site.trend.values.slice(7)).toEqual(Array(7).fill(200));
		expect(site.trend.values.slice(0, 7)).toEqual(Array(7).fill(1000));
		expect(site.facts).toContainEqual({ label: 'Clicks', value: '7,000 → 1,400' });
		const blog = of(ev[drops.find((a) => a.title.includes('/blog/'))!.id], 'trend');
		expect(blog.scope).toMatch(/\/blog\//);
		expect(blog.trend.values).toEqual([...Array(7).fill(50), ...Array(7).fill(10)]);
		expect(blog.facts).toContainEqual({ label: 'Change', value: '−80%' });
	});

	it('a closed alert gets no evidence, but its card still says where to fix it', async () => {
		const id = makeSite((i) => (i < 7 ? 200 : 1000));
		await runAlertRules({ siteIds: [id] });
		const drop = open(id).find((a) => a.kind === 'clicks_drop')!;
		expect(alertEvidence(open(id))[drop.id]).toBeTruthy();
		expect(closeAlerts([drop.id], 'resolved', 'me', [id])).toBe(1);
		const all = listAlerts({ siteIds: null, siteId: id, status: 'all' });
		expect(alertEvidence(all)[drop.id]).toBeUndefined();
		const card = alertCards(all)[drop.id];
		expect(card.evidence).toBeNull();
		expect(card.fix).toEqual({ href: `/sites/${id}/diagnose`, label: 'Open Diagnose' });
		expect(card.rule?.href).toMatch(new RegExp(`^/sites/${id}/alerts#rule-\\d+$`));
		expect(card.facts).toEqual([{ label: 'Window', value: 'last 7 days vs 7 before' }]);
		expect(listAlerts({ siteIds: null, siteId: id, status: 'resolved' }).map((a) => a.id)).toEqual([drop.id]);
		expect(listAlerts({ siteIds: null, siteId: id, status: 'dismissed' })).toEqual([]);
	});

	it('the fix link of every kind points at a site tab that exists', () => {
		const tabs = new Set<string>(SITE_TABS.map(([t]) => t));
		for (const k of ALERT_KINDS) {
			const f = ALERT_FIX[k.kind];
			expect(f, k.kind).toBeTruthy();
			expect(tabs.has(f.tab), `${k.kind} → ${f.tab}`).toBe(true);
			expect(existsSync(`src/routes/sites/[id]${f.tab}/+page.svelte`), f.tab).toBe(true);
			expect(alertFix(k.kind, 7).href).toBe(`/sites/7${f.tab}`);
		}
		expect(ALERT_FIX.pages_drop.tab).toBe('/decay');
		expect(ALERT_FIX.deindexed.tab).toBe('/inspect');
		expect(ALERT_FIX.tracked_drop.tab).toBe('/rank');
	});
});
