import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { addDays } from '../src/lib/server/dates';
import { getSite } from '../src/lib/server/clients';
import { allSites } from '../src/lib/server/queries';
import { aiSuggestions, parseReply, ruleSuggestions } from '../src/lib/server/suggest';
import { deleteExpiredSites, purgeRemovedSite, recentlyRemoved, restoreSite, RESTORE_DAYS } from '../src/lib/server/duplicates';
import { saveGroup, setBucketTracking } from '../src/lib/server/groups';
import { rankReport, trackQueries } from '../src/lib/server/ranktrack';
import { brandByDay, countries } from '../src/lib/server/overview';
import { periodFor } from '../src/lib/server/queries';
import { parseRecipients, setMailSender } from '../src/lib/server/mail';
import { runAlertRules, setSiteEmails } from '../src/lib/server/alerts';

const END = '2026-11-15';
function makeSite(daily: (i: number) => number, days = 120, brand = 'acme'): number {
	const d = db();
	d.prepare("INSERT OR IGNORE INTO accounts (id, google_sub, email, created_at) VALUES (1, 'sub', 'a@example.com', 0)").run();
	const id = Number(d.prepare("INSERT INTO sites (account_id, site_url, permission, synced_through, backfilled_to, backfill_done, brand_terms, created_at) VALUES (1, ?, 'siteOwner', ?, ?, 1, ?, 0)").run(`https://site${Math.random().toString(36).slice(2, 7)}.example/`, END, addDays(END, -(days - 1)), brand).lastInsertRowid);
	const ins = d.prepare('INSERT INTO site_daily (site_id, date, clicks, impressions, position) VALUES (?,?,?,?,?)');
	for (let i = 0; i < days; i++) ins.run(id, addDays(END, -i), daily(i), daily(i) * 20, 5);
	return id;
}
const rows = (id: number, list: [string, string, number, number, number, string?][], from = 0, to = 59) => {
	const ins = db().prepare("INSERT OR REPLACE INTO sa_rows (site_id, date, query, page, country, device, clicks, impressions, position) VALUES (?,?,?,?,?,'DESKTOP',?,?,?)");
	for (let i = from; i <= to; i++) for (const [q, p, c, imp, pos, country] of list) ins.run(id, addDays(END, -i), q, p, country ?? 'usa', c, imp, pos);
};
const KEYS = ['ANTHROPIC_API_KEY', 'CHAT_MODEL', 'CHAT_PROVIDER', 'SMTP_URL', 'ALERT_EMAIL_FROM', 'ALERT_EMAIL_TO', 'DIGEST_WEBHOOK_URL'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	for (const k of KEYS) (saved[k] = process.env[k]), delete process.env[k];
	process.env.DEMO_MODE = '0';
	process.env.SCHEDULER = '0';
});
afterEach(() => {
	for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
	setMailSender(null);
});

describe('AI-assisted setup', () => {
	it('reads a JSON reply even with a fence or a sentence around it, and nothing else', () => {
		expect(parseReply('{"a":1}')).toEqual({ a: 1 });
		expect(parseReply('```json\n{"a":2}\n```')).toEqual({ a: 2 });
		expect(parseReply('Here you go: {"a":3} hope it helps')).toEqual({ a: 3 });
		expect(parseReply('no json here')).toBeNull();
		expect(parseReply('[1,2]')).toBeNull();
	});
	it('without an AI provider it offers the app\'s own clusters and folders, and says why', async () => {
		const id = makeSite(() => 100);
		rows(id, [['red running shoes', 'https://x.example/shoes/red', 20, 200, 3], ['blue running shoes', 'https://x.example/shoes/blue', 15, 150, 4], ['trail shoes guide', 'https://x.example/blog/trail', 10, 100, 5]]);
		const s = await aiSuggestions(getSite(id)!);
		expect(s.source).toBe('rules');
		expect(s.note).toMatch(/No AI provider/);
		expect(s.pageGroups.map((g) => g.name)).toEqual(expect.arrayContaining(['Shoes']));
		expect(ruleSuggestions(getSite(id)!).source).toBe('rules');
	});
	it('with a provider, keeps only valid suggestions that match the data and are not taken, measured on the site', async () => {
		process.env.ANTHROPIC_API_KEY = 'test-key';
		process.env.CHAT_MODEL = 'claude-test';
		const id = makeSite(() => 100);
		rows(id, [['red running shoes', 'https://x.example/shoes/red', 20, 200, 3], ['blue running shoes', 'https://x.example/shoes/blue', 15, 150, 4], ['acme login', 'https://x.example/', 30, 60, 1], ['shoe care tips', 'https://x.example/blog/care', 5, 80, 6], ['repair kit', 'https://x.example/kit', 2, 20, 9]]);
		saveGroup(id, 'bucket', 'Taken', { rules: [{ kind: 'contains', value: 'kit' }] });
		let asked = '';
		const reply = {
			brandTerms: ['Acme', 'ac'],
			buckets: [
				{ name: 'Running shoes', rules: [{ kind: 'contains', value: 'running' }] },
				{ name: 'Bad regex', rules: [{ kind: 'regex', value: '(a+)+' }] },
				{ name: 'Matches nothing', rules: [{ kind: 'contains', value: 'zebra' }] },
				{ name: 'taken', rules: [{ kind: 'contains', value: 'kit' }] }
			],
			pageGroups: [{ name: 'Blog', match: 'any', rules: [{ kind: 'starts', value: '/blog/' }] }]
		};
		const call = (async (params: { messages: { content: string }[] }) => {
			asked = params.messages[0].content;
			return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] };
		}) as never;
		const s = await aiSuggestions(getSite(id)!, { call });
		expect(asked).toMatch(/red running shoes\t1200\t12000/);
		expect(asked).toMatch(/Already defined \(do not repeat\): Taken/);
		expect(s.source).toBe('ai');
		expect(s.buckets.map((b) => [b.name, b.matches, b.clicks])).toEqual([['Running shoes', 2, 35 * 60]]);
		expect(s.pageGroups.map((g) => [g.name, g.matches])).toEqual([['Blog', 1]]);
		expect(s.brandTerms).toEqual([]); // the site already has brand terms, so none are offered
	});
	it('falls back to the app\'s own suggestions when the model declines or answers nonsense', async () => {
		process.env.ANTHROPIC_API_KEY = 'test-key';
		process.env.CHAT_MODEL = 'claude-test';
		const id = makeSite(() => 100);
		rows(id, [['a b', 'https://x.example/a', 1, 10, 3], ['c d', 'https://x.example/b', 1, 10, 3], ['e f', 'https://x.example/c', 1, 10, 3], ['g h', 'https://x.example/d', 1, 10, 3], ['i j', 'https://x.example/e', 1, 10, 3]]);
		const refuse = (async () => ({ stop_reason: 'refusal', content: [] })) as never;
		expect((await aiSuggestions(getSite(id)!, { call: refuse })).note).toMatch(/declined/);
		const junk = (async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'sorry' }] })) as never;
		expect((await aiSuggestions(getSite(id)!, { call: junk })).note).toMatch(/could not be read/);
	});
});

describe('removed sites can be restored for 14 days', () => {
	it('a removed property leaves the dashboard, can come back with its history, and is deleted for good after 14 days', () => {
		const id = makeSite(() => 10, 20);
		db().prepare("UPDATE sites SET permission = 'none' WHERE id = ?").run(id);
		expect(purgeRemovedSite(id)).toBe(true);
		expect(allSites({ includeHidden: true }).some((s) => s.id === id)).toBe(false);
		expect(recentlyRemoved(null).map((r) => r.id)).toEqual([id]);
		expect(recentlyRemoved([999])).toEqual([]);
		expect(restoreSite(id)).toBe(true);
		expect(allSites({ includeHidden: true }).some((s) => s.id === id)).toBe(true);
		expect((db().prepare('SELECT COUNT(*) n FROM site_daily WHERE site_id = ?').get(id) as { n: number }).n).toBe(20);
		purgeRemovedSite(id);
		expect(deleteExpiredSites(Date.now() + (RESTORE_DAYS - 1) * 86_400_000)).toBe(0);
		expect(deleteExpiredSites(Date.now() + (RESTORE_DAYS + 1) * 86_400_000)).toBe(1);
		expect(getSite(id)).toBeUndefined();
		expect((db().prepare('SELECT COUNT(*) n FROM site_daily WHERE site_id = ?').get(id) as { n: number }).n).toBe(0);
	});
	it('a property that Google lists again comes back by itself', async () => {
		const id = makeSite(() => 10, 5);
		db().prepare("UPDATE sites SET permission = 'none', deleted_at = ? WHERE id = ?").run(Date.now(), id);
		const url = getSite(id)!.site_url;
		db().prepare(`INSERT INTO sites (account_id, site_url, permission, created_at) VALUES (1, ?, 'siteOwner', 0) ON CONFLICT(account_id, site_url) DO UPDATE SET permission = excluded.permission, deleted_at = NULL`).run(url);
		expect(getSite(id)!.deleted_at).toBeNull();
	});
});

describe('bucket rank tracking, hidden clicks, countries', () => {
	it('each tracking bucket follows its 8 biggest searches, beside the ones added by hand', () => {
		const id = makeSite(() => 100);
		rows(id, Array.from({ length: 10 }, (_, i) => [`shoe ${i}`, 'https://x.example/s', 10 - i, 100, 4] as [string, string, number, number, number]), 0, 30);
		const b = saveGroup(id, 'bucket', 'Shoes', { rules: [{ kind: 'contains', value: 'shoe' }] }) as { id: number };
		trackQueries(id, ['shoe 1', 'boots']);
		let r = rankReport(getSite(id)!, 28);
		expect(r.rows.filter((x) => x.manual).map((x) => x.query).sort()).toEqual(['boots', 'shoe 1']);
		expect(r.rows.filter((x) => !x.manual).map((x) => x.query).sort()).toEqual(['shoe 0', 'shoe 2', 'shoe 3', 'shoe 4', 'shoe 5', 'shoe 6', 'shoe 7']);
		expect(r.rows.find((x) => x.query === 'shoe 1')!.buckets).toEqual(['Shoes']);
		setBucketTracking(id, b.id, false);
		r = rankReport(getSite(id)!, 28);
		expect(r.rows.map((x) => x.query).sort()).toEqual(['boots', 'shoe 1']);
	});
	it('hidden clicks are the day\'s total less the searches Google lists, never below zero', () => {
		const id = makeSite(() => 100, 40);
		rows(id, [['acme shoes', 'https://x.example/a', 30, 100, 2], ['running shoes', 'https://x.example/b', 50, 300, 4]], 0, 40);
		const days = brandByDay(getSite(id)!, periodFor(getSite(id)!, 7))!;
		expect(days[0]).toMatchObject({ brand: 30, other: 50, hidden: 20 });
	});
	it('countries leave out Search Console\'s unknown-country code', () => {
		const id = makeSite(() => 100, 40);
		rows(id, [['a', 'https://x.example/a', 5, 50, 2, 'usa'], ['b', 'https://x.example/b', 3, 30, 2, 'zzz']], 0, 10);
		expect(countries(getSite(id)!, periodFor(getSite(id)!, 7)).map((c) => c.country)).toEqual(['usa']);
	});
});

describe('email alerts', () => {
	it('recipients are checked, deduplicated and capped', () => {
		expect(parseRecipients('A@x.com, a@x.com; b@y.org nope')).toEqual({ list: ['a@x.com', 'b@y.org'], bad: ['nope'] });
		expect(parseRecipients(Array.from({ length: 15 }, (_, i) => `u${i}@x.com`).join(',')).list).toHaveLength(10);
	});
	it('new alerts are emailed once, one message per site, to the site\'s own recipients', async () => {
		process.env.SMTP_URL = 'smtp://user:pw@mail.example.com:587';
		process.env.ALERT_EMAIL_FROM = 'SEOConsole <alerts@example.com>';
		process.env.ALERT_EMAIL_TO = 'team@example.com';
		const id = makeSite((i) => (i < 7 ? 30 : 100));
		expect(setSiteEmails(id, 'not-an-email')).toHaveProperty('error');
		setSiteEmails(id, 'owner@example.com');
		const sent: { to: string[]; subject: string; text: string }[] = [];
		setMailSender(async (m) => void sent.push(m));
		await runAlertRules({ siteIds: [id] });
		expect(sent).toHaveLength(1);
		expect(sent[0].to).toEqual(['owner@example.com']);
		expect(sent[0].subject).toMatch(/alert/);
		expect(sent[0].text).toMatch(/Clicks falling/);
		await runAlertRules({ siteIds: [id] });
		expect(sent).toHaveLength(1);
	});
	it('without SMTP set up nothing is emailed', async () => {
		const id = makeSite((i) => (i < 7 ? 30 : 100));
		let n = 0;
		setMailSender(async () => void n++);
		await runAlertRules({ siteIds: [id] });
		expect(n).toBe(0);
	});
});
