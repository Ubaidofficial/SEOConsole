import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { compileRuleSet, describeRuleSet, pagePath, parseRuleSet, quickFilter, QUICK_FILTERS } from '../src/lib/rules';
import { ALERT_KINDS, attentionOf, clampThreshold, alertKind } from '../src/lib/alerts';
import { addCustomRule, closeAlerts, listAlerts, listRules, runAlertRules, setSiteWebhook, siteWebhook, updateRule } from '../src/lib/server/alerts';
import { cleanViewParams, deleteGroup, groupsReportFor, listViews, matcherFor, saveGroup, saveView } from '../src/lib/server/groups';
import { MAX_ADD_AT_ONCE, listTracked, rankReport, trackQueries, untrackQueries } from '../src/lib/server/ranktrack';
import { judge } from '../src/lib/server/updateimpact';
import { NOT_FOUND_TITLE, notFoundPages } from '../src/lib/server/notfound';
import { getSite } from '../src/lib/server/clients';
import { addDays } from '../src/lib/server/dates';

const END = '2026-11-15';

/** A site whose stored history is under the test's control: `daily(i)` clicks on day i (0 = END, 1 = the day before …). */
function makeSite(daily: (i: number) => number, days = 120): number {
	const d = db();
	d.prepare("INSERT INTO accounts (google_sub, email, created_at) VALUES ('sub', 'a@example.com', 0)").run();
	const id = Number(d.prepare("INSERT INTO sites (account_id, site_url, permission, synced_through, backfilled_to, backfill_done, created_at) VALUES (1, 'https://example.com/', 'siteOwner', ?, ?, 1, 0)").run(END, addDays(END, -(days - 1))).lastInsertRowid);
	writeDaily(id, daily, days);
	return id;
}
function writeDaily(id: number, daily: (i: number) => number, days = 120) {
	const ins = db().prepare('INSERT OR REPLACE INTO site_daily (site_id, date, clicks, impressions, position) VALUES (?,?,?,?,?)');
	for (let i = 0; i < days; i++) ins.run(id, addDays(END, -i), daily(i), daily(i) * 20, 5);
}
const rows = (id: number, list: [string, string, number, number, number][], from = 0, to = 59) => {
	const ins = db().prepare("INSERT OR REPLACE INTO sa_rows (site_id, date, query, page, country, device, clicks, impressions, position) VALUES (?,?,?,?,'usa','DESKTOP',?,?,?)");
	for (let i = from; i <= to; i++) for (const [q, p, c, imp, pos] of list) ins.run(id, addDays(END, -i), q, p, c, imp, pos);
};

beforeEach(() => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	delete process.env.DIGEST_WEBHOOK_URL;
	process.env.DEMO_MODE = '0';
	process.env.SCHEDULER = '0';
});

describe('rule engine (keyword buckets and page groups)', () => {
	it('checks rules before they are stored: unknown kinds and empty values dropped, unsafe regexes and bad numbers refused', () => {
		expect(parseRuleSet({ rules: [] })).toEqual({ error: 'Add at least one rule.' });
		expect(parseRuleSet({ rules: [{ kind: 'bogus', value: 'x' }, { kind: 'contains', value: '  ' }] })).toHaveProperty('error');
		expect(parseRuleSet({ rules: [{ kind: 'regex', value: '(a+)+$' }] })).toHaveProperty('error');
		expect(parseRuleSet({ rules: [{ kind: 'words_min', value: 'many' }] })).toHaveProperty('error');
		expect(parseRuleSet('{not json')).toHaveProperty('error');
		const ok = parseRuleSet({ match: 'all', rules: [{ kind: 'contains', value: 'Shoe' }, { kind: 'bogus', value: 'x' }] });
		expect(ok).toEqual({ set: { match: 'all', rules: [{ kind: 'contains', value: 'Shoe' }] } });
	});
	it('any / all, exclusions always win, lists and word counts, case ignored', () => {
		const any = compileRuleSet({ match: 'any', rules: [{ kind: 'contains', value: 'shoe' }, { kind: 'starts', value: 'boot' }, { kind: 'not_contains', value: 'repair' }] });
		expect(any('Running SHOES')).toBe(true);
		expect(any('boots for hiking')).toBe(true);
		expect(any('shoe repair near me')).toBe(false);
		expect(any('sandals')).toBe(false);
		const all = compileRuleSet({ match: 'all', rules: [{ kind: 'contains', value: 'shoe' }, { kind: 'words_min', value: '3' }] });
		expect(all('trail running shoes')).toBe(true);
		expect(all('shoes')).toBe(false);
		const list = compileRuleSet({ match: 'any', rules: [{ kind: 'list', value: 'Alpha\n beta \n\n' }] });
		expect([list('alpha'), list('beta'), list('alphabet')]).toEqual([true, true, false]);
		const re = compileRuleSet({ match: 'any', rules: [{ kind: 'regex', value: '^/blog/' }, { kind: 'not_regex', value: 'draft' }] });
		expect([re('/blog/post'), re('/blog/draft-1'), re('/shop/')]).toEqual([true, false, false]);
	});
	it('page groups read the path only, so every host of a Domain property matches', () => {
		expect(pagePath('https://www.example.com/blog/a?x=1')).toBe('/blog/a?x=1');
		expect(pagePath('not a url')).toBe('not a url');
		expect(describeRuleSet({ match: 'all', rules: [{ kind: 'starts', value: '/blog/' }, { kind: 'list', value: 'a\nb' }] })).toBe('starts with “/blog/” and is one of 2 entries');
	});
	it('quick filters pick the searches their names promise', () => {
		const t = (k: string, q: string) => quickFilter(k)!.test!(q);
		expect(t('longtail', 'best trail running shoes')).toBe(true);
		expect(t('longtail', 'running shoes')).toBe(false);
		expect(t('compare', 'nike vs adidas')).toBe(true);
		expect(t('buying', 'buy running shoes')).toBe(true);
		expect(t('nearme', 'shoe shop near me')).toBe(true);
		expect(t('questions', 'how to clean suede shoes')).toBe(true);
		expect(t('year', 'best shoes 2026')).toBe(true);
		expect(quickFilter('new')!.test).toBeNull(); // worked out against the previous period on the page
		expect(new Set(QUICK_FILTERS.map((f) => f.key)).size).toBe(QUICK_FILTERS.length);
	});
});

describe('keyword buckets, page groups and saved views', () => {
	it('a bucket gathers its searches with their totals and change, and the last row counts what is in no bucket', () => {
		const id = makeSite(() => 100);
		rows(id, [['running shoes', 'https://example.com/shoes', 10, 100, 3], ['shoe repair', 'https://example.com/repair', 2, 50, 8], ['boots', 'https://example.com/boots', 5, 60, 4]], 0, 55);
		const b = saveGroup(id, 'bucket', 'Shoes', { match: 'any', rules: [{ kind: 'contains', value: 'shoe' }, { kind: 'not_contains', value: 'repair' }] });
		expect(b).toHaveProperty('id');
		expect(saveGroup(id, 'bucket', 'shoes', { rules: [{ kind: 'contains', value: 'x' }] })).toEqual({ error: 'There is already one called “shoes”.' });
		const r = groupsReportFor(getSite(id)!, 'bucket', 28);
		expect(r.rows.map((x) => [x.name, x.members, x.clicks])).toEqual([['Shoes', 1, 280], ['In no bucket', 2, 196]]);
		expect(r.rows[0].deltaPct).toBe(0);
		const pg = saveGroup(id, 'pages', 'Shoe pages', { rules: [{ kind: 'starts', value: '/shoes' }] }) as { id: number };
		expect(matcherFor(id, 'pages', pg.id)!('https://www.example.com/shoes')).toBe(true);
		expect(matcherFor(id, 'bucket', pg.id)).toBeNull(); // a page group is not a bucket
		expect(deleteGroup(id, pg.id)).toBe(true);
		expect(matcherFor(id, 'pages', pg.id)).toBeNull();
	});
	it('a saved view keeps only the filters (never the period), and saving the same name again replaces it', () => {
		const id = makeSite(() => 1, 10);
		expect(cleanViewParams('/queries', '?days=90&qf=longtail&re=shoe&evil=1&bucket=3')).toBe('qf=longtail&re=shoe&bucket=3');
		expect(saveView(id, '/queries', 'Long tail', 'days=28', null)).toHaveProperty('error');
		expect(saveView(id, '/settings', 'x', 'qf=a', null)).toHaveProperty('error');
		saveView(id, '/queries', 'Long tail', 'qf=longtail', 'a@example.com');
		saveView(id, '/queries', 'Long tail', 'qf=longtail&b=nonbrand', 'a@example.com');
		expect(listViews(id, '/queries').map((v) => [v.name, v.params])).toEqual([['Long tail', 'b=nonbrand&qf=longtail']]);
	});
});

describe('rank tracking from Search Console data', () => {
	it('adds at most 100 at a time, lower-cases, skips what is tracked, and untracks', () => {
		const id = makeSite(() => 1, 10);
		expect(trackQueries(id, Array.from({ length: MAX_ADD_AT_ONCE + 1 }, (_, i) => `q${i}`)).error).toMatch(/Up to 100/);
		expect(trackQueries(id, ['Running  Shoes', 'running shoes', 'boots'])).toEqual({ added: 2, already: 0 });
		expect(trackQueries(id, ['boots', 'sandals'])).toEqual({ added: 1, already: 1 });
		expect(listTracked(id).map((t) => t.query)).toEqual(['boots', 'running shoes', 'sandals']);
		expect(untrackQueries(id, ['BOOTS'])).toBe(1);
	});
	it('the daily position is impression-weighted, a day without an impression has none, and the weekly change is + for moving up', () => {
		const id = makeSite(() => 100);
		trackQueries(id, ['running shoes', 'never shown']);
		rows(id, [['running shoes', 'https://example.com/a', 1, 10, 8]], 7, 13);
		rows(id, [['running shoes', 'https://example.com/a', 1, 30, 4], ['running shoes', 'https://example.com/b', 0, 10, 8]], 1, 6);
		const r = rankReport(getSite(id)!, 28);
		const shoes = r.rows.find((x) => x.query === 'running shoes')!;
		expect(shoes.latest).toEqual({ date: addDays(END, -1), position: 5 }); // (30×4 + 10×8) / 40; day 0 has no impression
		expect(shoes.week).toBe(5);
		expect(shoes.prevWeek).toBe(8);
		expect(shoes.change).toBe(3);
		expect(shoes.series.at(-1)).toBeNull();
		const none = r.rows.find((x) => x.query === 'never shown')!;
		expect([none.latest, none.week, none.change]).toEqual([null, null, null]);
	});
});

describe('alert rules', () => {
	it('every site has the built-in rules from the start, and thresholds are kept within sense', () => {
		const id = makeSite(() => 100);
		const rules = listRules(id);
		expect(rules.filter((r) => r.builtin).map((r) => r.kind)).toEqual(ALERT_KINDS.map((k) => k.kind));
		listRules(id); // creating them again changes nothing
		expect((db().prepare('SELECT COUNT(*) n FROM alert_rules').get() as { n: number }).n).toBe(ALERT_KINDS.length);
		expect(clampThreshold(alertKind('clicks_drop')!, 0)).toBeNull();
		expect(clampThreshold(alertKind('clicks_drop')!, 40)).toBe(40);
		const drop = rules.find((r) => r.kind === 'clicks_drop')!;
		expect(updateRule(id, drop.id, { threshold: 500 })).toHaveProperty('error');
		expect(updateRule(id, drop.id, { windowDays: 9 })).toHaveProperty('error');
		expect(updateRule(id, drop.id, { threshold: 40, windowDays: 14 })).toEqual({ ok: true });
		expect(addCustomRule(id, { kind: 'deindexed', threshold: 1, windowDays: 7, scopeKind: 'page', scopeValue: '/blog/' })).toHaveProperty('error');
		expect(addCustomRule(id, { kind: 'clicks_drop', threshold: 30, windowDays: 7, scopeKind: 'page', scopeValue: 'blog' })).toEqual({ error: 'A URL path starts with “/”, for example /blog/.' });
		expect(addCustomRule(id, { kind: 'clicks_drop', threshold: 30, windowDays: 7, scopeKind: 'query', scopeValue: '(a+)+' })).toHaveProperty('error');
		expect(addCustomRule(id, { kind: 'clicks_drop', threshold: 30, windowDays: 7, scopeKind: 'page', scopeValue: '/blog/' })).toHaveProperty('id');
	});

	it('an alert opens once, stays one alert while the drop lasts, ends by itself, and a resolved one does not come back until the drop has ended', async () => {
		const id = makeSite((i) => (i < 7 ? 40 : 100));
		let r = await runAlertRules({ siteIds: [id] });
		expect(r.opened).toBeGreaterThanOrEqual(1);
		const open = () => listAlerts({ siteIds: null, siteId: id, status: 'open' });
		const drop = open().find((a) => a.kind === 'clicks_drop')!;
		expect(drop.detail).toMatch(/down 60% from 700/);
		expect(drop.delivery).toBe('none'); // no webhook: shown in the app only
		r = await runAlertRules({ siteIds: [id] });
		expect(open().filter((a) => a.kind === 'clicks_drop')).toHaveLength(1);
		// resolved while the drop lasts: closed, and no new alert
		expect(closeAlerts([drop.id], 'resolved', 'me', [id])).toBe(1);
		await runAlertRules({ siteIds: [id] });
		expect(open().filter((a) => a.kind === 'clicks_drop')).toHaveLength(0);
		// a person limited to another site cannot close it
		expect(closeAlerts([drop.id], 'dismissed', 'x', [999])).toBe(0);
		// the drop ends: the alert is no longer active; a new drop opens a new one
		writeDaily(id, () => 100);
		await runAlertRules({ siteIds: [id] });
		expect((db().prepare('SELECT active FROM alert_events WHERE id = ?').get(drop.id) as { active: number }).active).toBe(0);
		writeDaily(id, (i) => (i < 7 ? 30 : 100));
		await runAlertRules({ siteIds: [id] });
		expect(open().filter((a) => a.kind === 'clicks_drop')).toHaveLength(1);
	});

	it('a rise opens a good-news alert; a quiet site does not alert on a handful of clicks', async () => {
		const id = makeSite((i) => (i < 7 ? 200 : 100));
		await runAlertRules({ siteIds: [id] });
		expect(listAlerts({ siteIds: null, siteId: id, status: 'open' }).map((a) => [a.kind, a.positive])).toContainEqual(['clicks_rise', true]);
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		const quiet = makeSite((i) => (i < 7 ? 1 : 2)); // 7 clicks a week against 14, 280 impressions against 140
		await runAlertRules({ siteIds: [quiet] });
		expect(listAlerts({ siteIds: null, siteId: quiet, status: 'all' })).toEqual([]);
	});

	it('a site webhook must be Slack or Discord, so the form cannot point the server anywhere else', () => {
		expect(siteWebhook('https://hooks.slack.com/services/T0/B0/xyz')).toEqual({ url: 'https://hooks.slack.com/services/T0/B0/xyz', format: 'slack' });
		expect(siteWebhook('https://discord.com/api/webhooks/1/abc')).toMatchObject({ format: 'discord' });
		for (const bad of ['http://hooks.slack.com/services/x', 'https://hooks.slack.com.evil.test/services/x', 'https://169.254.169.254/latest', 'https://localhost/services/x', 'https://hooks.slack.com:8443/services/x', 'https://user:pw@hooks.slack.com/services/x', 'https://hooks.slack.com/other', 'nonsense']) expect(siteWebhook(bad), bad).toHaveProperty('error');
		expect(siteWebhook('')).toBeNull();
		const id = makeSite(() => 1, 10);
		expect(setSiteWebhook(id, 'https://example.com/hook')).toHaveProperty('error');
		expect(getSite(id)!.alert_webhook).toBeNull();
	});

	it('new alerts go to the site\'s own webhook once, grouped in one message', async () => {
		const id = makeSite((i) => (i < 7 ? 30 : 100));
		setSiteWebhook(id, 'https://hooks.slack.com/services/T0/B0/xyz');
		const sent: { url: string; body: string }[] = [];
		const fake = (async (u: URL | string, init?: RequestInit) => { sent.push({ url: String(u), body: String(init?.body) }); return new Response('ok'); }) as typeof fetch;
		const r = await runAlertRules({ siteIds: [id], fetchImpl: fake });
		expect(r.delivered).toBe(r.opened);
		expect(sent).toHaveLength(1);
		expect(sent[0].url).toBe('https://hooks.slack.com/services/T0/B0/xyz');
		expect(JSON.parse(sent[0].body).text).toMatch(/^SEOConsole alerts \(\d+\)\n▼ example\.com[^\n]* · Clicks falling: Clicks over the 7 days/);
		await runAlertRules({ siteIds: [id], fetchImpl: fake });
		expect(sent).toHaveLength(1); // not announced again
	});
});

describe('Google update impact, not-found pages, needs a look', () => {
	it('judges only a change beyond noise, beyond the trend before and unlike last year', () => {
		expect(judge({ before: 1000, after: 700, days: 28, trend: 0, lastYear: 0 }).verdict).toBe('hurt');
		expect(judge({ before: 1000, after: 1300, days: 28, trend: null, lastYear: null }).verdict).toBe('helped');
		expect(judge({ before: 1000, after: 970, days: 28, trend: 0, lastYear: null }).verdict).toBe('none');
		expect(judge({ before: 1000, after: 700, days: 28, trend: -0.28, lastYear: null }).why).toMatch(/already moving/);
		expect(judge({ before: 1000, after: 700, days: 28, trend: 0, lastYear: -0.25 }).why).toMatch(/seasonal/);
		expect(judge({ before: 5, after: 1, days: 28, trend: null, lastYear: null }).verdict).toBe('none');
	});
	it('recognises not-found titles in seven languages and leaves ordinary titles alone', () => {
		for (const t of ['404 | Shop', 'Page not found', 'Página no encontrada', 'Page introuvable', 'Seite nicht gefunden', 'Pagina non trovata', 'Página não encontrada', 'Pagina niet gevonden']) expect(NOT_FOUND_TITLE.test(t), t).toBe(true);
		for (const t of ['Running shoes', 'Top 4040 deals', 'Found it!']) expect(NOT_FOUND_TITLE.test(t), t).toBe(false);
	});
	it('a not-found address an AI assistant sends people to, unknown to Google and the sitemaps, is flagged as likely made up', () => {
		const id = makeSite(() => 10, 40);
		rows(id, [['x', 'https://example.com/real-old-page', 1, 5, 3]], 0, 2);
		const d = db();
		const t = d.prepare('INSERT INTO ga4_page_titles (site_id, page, title) VALUES (?,?,?)');
		t.run(id, '/made-up-guide', 'Page not found');
		t.run(id, '/real-old-page', '404');
		t.run(id, '/fine', 'Shoes');
		d.prepare("INSERT INTO ga4_ai_daily (site_id, date, assistant, page, sessions, key_events) VALUES (?, ?, 'ChatGPT', '/made-up-guide', 4, 0)").run(id, END);
		d.prepare('INSERT INTO ga4_page_views (site_id, date, page, views) VALUES (?,?,?,?)').run(id, END, '/real-old-page', 9);
		const r = notFoundPages(getSite(id)!, 28);
		expect(r.rows.map((x) => [x.path, x.likelyInvented, x.inSearch, x.ai, x.views])).toEqual([['/made-up-guide', true, false, 4, 0], ['/real-old-page', false, true, 0, 9]]);
	});
	it('"needs a look" is a real fall of 20% or more, "watch" 10% or more, nothing without a fair comparison', () => {
		const c = (now: number, prev: number, comparable = true) => attentionOf({ comparable, now: { clicks: now }, prev: { clicks: prev } });
		expect(c(700, 1000)).toBe('look');
		expect(c(860, 1000)).toBe('watch');
		expect(c(980, 1000)).toBeNull();
		expect(c(7, 10)).toBeNull();
		expect(c(500, 1000, false)).toBeNull();
	});
});
