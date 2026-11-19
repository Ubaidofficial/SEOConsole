import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts, upsertGoogleAccount } from '../src/lib/server/accounts';
import { autoMatchGa4 } from '../src/lib/server/connect';
import { ga4SourceFor, pullGa4Sources, syncGa4, type Ga4Source } from '../src/lib/server/channels';
import { trafficSources, SOURCE_ROW_LIMIT } from '../src/lib/server/ga4';
import { trafficSourcesReport } from '../src/lib/server/insights';
import { getSite } from '../src/lib/server/clients';
import { linksFor } from '../src/lib/server/links';
import { addDays, pacificToday } from '../src/lib/server/dates';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';
import { PERIODS } from '../src/lib/periods';

beforeEach(() => {
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const n = (sql: string, ...a: unknown[]) => (db().prepare(sql).get(...a) as { n: number }).n;

async function linked() {
	await ensureDemoAccounts();
	await autoMatchGa4();
	for (let i = 0; i < 200 && n("SELECT COUNT(*) n FROM site_links WHERE kind='ga4' AND sync_status IN ('queued','running')") > 0; i++) await new Promise((r) => setTimeout(r, 50));
	return linksFor(1).ga4!;
}

/** A source whose traffic-source report returns fixed rows: `now` for the window ending today, `prev` for the one before. */
function fixed(real: Ga4Source, today: string, now: object[], prev: object[] | (() => never)): Ga4Source & { calls: number } {
	const s = {
		...real,
		calls: 0,
		sources: async (_p: string, _s: string, e: string) => {
			s.calls++;
			if (e === today) return now as never;
			if (typeof prev === 'function') return prev();
			return prev as never;
		}
	};
	return s;
}
const row = (source: string, medium: string, channel: string, sessions: number) => ({ source, medium, channel, sessions, engagedSessions: Math.round(sessions / 2), keyEvents: 1 });

describe('GA4 traffic-source request', () => {
	it('asks for source, medium and channel over the whole window, largest first, every channel', async () => {
		const id = upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.readonly' });
		let body: Record<string, any> = {};
		const r = (v: string[], m: number[]) => ({ dimensionValues: v.map((value) => ({ value })), metricValues: m.map((x) => ({ value: String(x) })) });
		const f = vi.fn(async (_u: string, init?: RequestInit) => ((body = JSON.parse(String(init?.body))), json({ rows: [r(['layoffsandhires.com', 'referral', 'Referral'], [40, 22, 3]), r(['(direct)', '(none)', 'Direct'], [30, 4, 0])] })));
		const out = await trafficSources(id, 'properties/1', '2026-10-22', '2026-11-18', { fetchImpl: f as never });
		expect(out).toEqual([
			{ source: 'layoffsandhires.com', medium: 'referral', channel: 'Referral', sessions: 40, engagedSessions: 22, keyEvents: 3 },
			{ source: '(direct)', medium: '(none)', channel: 'Direct', sessions: 30, engagedSessions: 4, keyEvents: 0 }
		]);
		expect(body.dimensions.map((d: { name: string }) => d.name)).toEqual(['sessionSource', 'sessionMedium', 'sessionDefaultChannelGroup']);
		expect(body.metrics.map((m: { name: string }) => m.name)).toEqual(['sessions', 'engagedSessions', 'keyEvents']);
		expect(body.dimensionFilter).toBeUndefined();
		expect(body.dateRanges).toEqual([{ startDate: '2026-10-22', endDate: '2026-11-18' }]);
		expect(body.limit).toBe(SOURCE_ROW_LIMIT);
	});
});

describe('traffic sources in sync and report', () => {
	it('demo sync stores sources for every period, consistent with channel totals', async () => {
		await linked();
		const t = trafficSourcesReport(getSite(1)!, 28);
		if (!t.linked || t.status !== 'ok') throw new Error('expected stored sources, got ' + JSON.stringify(t));
		expect(t.rows[0]).toMatchObject({ source: 'google', medium: 'organic', channel: 'Organic Search' });
		const referral = n("SELECT SUM(sessions) n FROM ga4_sources WHERE site_id = 1 AND days = 28 AND which = 'now' AND channel = 'Referral'");
		const daily = n("SELECT SUM(sessions) n FROM ga4_daily WHERE site_id = 1 AND channel = 'Referral' AND date BETWEEN ? AND ?", t.window.start, t.window.end);
		expect(referral).toBe(daily);
		for (const days of PERIODS) expect(n("SELECT COUNT(*) n FROM ga4_source_windows WHERE site_id = 1 AND days = ? AND which = 'now'", days)).toBe(1);
		// the longest period reaches GA4's retention horizon, so it has no previous window and no change figures
		const longest = trafficSourcesReport(getSite(1)!, PERIODS[PERIODS.length - 1]);
		if (!longest.linked || longest.status !== 'ok') throw new Error('expected rows');
		expect(longest.previousWindow).toBeNull();
		expect(longest.rows.every((r) => r.sessionsDelta === null && r.prevSessions === null)).toBe(true);
	}, 30_000);

	it('finds a referrer by name, shows its change, and marks a source new in this window as having no change figure', async () => {
		const link = await linked();
		const today = pacificToday();
		db().prepare('UPDATE sites SET ga4_sources_on = NULL').run();
		const src = fixed(ga4SourceFor(link.account_id!), today, [row('layoffsandhires.com', 'referral', 'Referral', 40), row('brand-new.example', 'referral', 'Referral', 5), row('google', 'organic', 'Organic Search', 100)], [row('layoffsandhires.com', 'referral', 'Referral', 20), row('google', 'organic', 'Organic Search', 100)]);
		expect((await pullGa4Sources(1, link.external_id, src, today)).ok).toBe(true);
		const t = trafficSourcesReport(getSite(1)!, 28, { search: 'LayoffsAndHires' });
		if (!t.linked || t.status !== 'ok') throw new Error('expected rows');
		expect(t.rows).toHaveLength(1);
		expect(t.rows[0]).toMatchObject({ source: 'layoffsandhires.com', sessions: 40, prevSessions: 20, sessionsDelta: 1, engagementRate: 0.5 });
		expect(t.sessions).toBe(40);
		const fresh = trafficSourcesReport(getSite(1)!, 28, { search: 'brand-new' });
		if (!fresh.linked || fresh.status !== 'ok') throw new Error('expected rows');
		expect(fresh.rows[0]).toMatchObject({ prevSessions: 0, sessionsDelta: null });
		const referral = trafficSourcesReport(getSite(1)!, 28, { channel: 'referral' });
		if (!referral.linked || referral.status !== 'ok') throw new Error('expected rows');
		expect(referral.rows.map((r) => r.source)).toEqual(['layoffsandhires.com', 'brand-new.example']);
		// once a day: a second pull the same day asks GA4 nothing
		const calls = src.calls;
		await pullGa4Sources(1, link.external_id, src, today);
		expect(src.calls).toBe(calls);
		// a period length that is not stored says so instead of answering with an empty table
		expect(trafficSourcesReport(getSite(1)!, 3)).toMatchObject({ status: 'no-window' });
	});

	it('a failure never fails the GA4 sync, keeps the last good rows, says they are older, and is retried', async () => {
		const link = await linked();
		const today = pacificToday();
		const real = ga4SourceFor(link.account_id!);
		const before = n('SELECT COUNT(*) n FROM ga4_sources WHERE site_id = 1');
		expect(before).toBeGreaterThan(0);
		db().prepare('UPDATE sites SET ga4_sources_on = NULL, ga4_periods_on = NULL').run();
		// no successful pull yet and a failure: the report says it failed rather than showing nothing
		db().prepare('DELETE FROM ga4_sources').run();
		db().prepare('DELETE FROM ga4_source_windows').run();
		const broken: Ga4Source = { ...real, sources: async () => { throw new Error('quota exhausted'); } };
		await syncGa4(1, broken, today);
		expect(linksFor(1).ga4!.sync_status).toBe('idle');
		expect(trafficSourcesReport(getSite(1)!, 28)).toMatchObject({ status: 'failed', error: 'quota exhausted' });
		// retried on the next sync, and the error is cleared
		await syncGa4(1, real, today);
		const ok = trafficSourcesReport(getSite(1)!, 28);
		expect(ok).toMatchObject({ status: 'ok', staleError: null });
		// a later failure keeps the rows from the last success and flags them; a failing previous window leaves everything as it was
		const tomorrow = addDays(today, 1);
		const half = fixed(real, tomorrow, [row('x.example', 'referral', 'Referral', 1)], () => { throw new Error('prev failed'); });
		expect((await pullGa4Sources(1, link.external_id, half, tomorrow)).ok).toBe(false);
		const stale = trafficSourcesReport(getSite(1)!, 28);
		if (!stale.linked || stale.status !== 'ok') throw new Error('expected the older rows');
		expect(stale.staleError).toBe('prev failed');
		expect(stale.rows.some((r) => r.source === 'x.example')).toBe(false);
		expect(stale.window.end).toBe(today);
	}, 30_000);

	it('MCP get_ga4_summary view=sources answers with sources and filters by search, and the default view is unchanged', async () => {
		await linked();
		const { key } = createApiKey('t', null);
		const call = async (args: object) => {
			const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_ga4_summary', arguments: { site: '1', view: 'sources', ...args } } }) }));
			const r = (await res.json()).result;
			expect(r.isError, r.content[0].text).toBeFalsy();
			return JSON.parse(r.content[0].text);
		};
		const all = await call({});
		expect(all.sources.length).toBeGreaterThan(3);
		expect(all.sources[0]).toMatchObject({ source: 'google', medium: 'organic' });
		const one = await call({ search: 'forum.example' });
		expect(one.sources.map((s: { source: string }) => s.source)).toEqual(['forum.example']);
		expect(one.sources[0].change === null || /%$/.test(one.sources[0].change)).toBe(true);
		expect((await call({ days: 90 })).window).toBeDefined();
		const pages = await call({ view: 'pages' });
		expect(pages.pages[0]).toMatchObject({ mainChannel: expect.any(String), fromOrganic: expect.stringMatching(/%$/) });
		const events = await call({ view: 'events' });
		expect(events.events.length).toBe(3);
		expect(events.total).toBeGreaterThan(0);
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_ga4_summary', arguments: { site: '1' } } }) }));
		expect(JSON.parse((await res.json()).result.content[0].text).channels.length).toBeGreaterThan(0);
	}, 30_000);
});
