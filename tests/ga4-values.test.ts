import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts, upsertGoogleAccount } from '../src/lib/server/accounts';
import { autoMatchGa4 } from '../src/lib/server/connect';
import { ga4SourceFor } from '../src/lib/server/channels';
import { siteSearchTerms, valueReport, VALUE_ROW_LIMIT } from '../src/lib/server/ga4';
import { ga4ValuesReport, pullGa4Values } from '../src/lib/server/ga4values';
import { getSite } from '../src/lib/server/clients';
import { linksFor } from '../src/lib/server/links';
import { pacificToday } from '../src/lib/server/dates';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';
import { fmtDur, fmtMoney } from '../src/lib/format';
import { PERIODS } from '../src/lib/periods';

beforeEach(() => {
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const n = (sql: string, ...a: unknown[]) => (db().prepare(sql).get(...a) as { n: number }).n;
const r = (v: string[], m: number[]) => ({ dimensionValues: v.map((value) => ({ value })), metricValues: m.map((x) => ({ value: String(x) })) });

async function linked() {
	await ensureDemoAccounts();
	await autoMatchGa4();
	for (let i = 0; i < 200 && n("SELECT COUNT(*) n FROM site_links WHERE kind='ga4' AND sync_status IN ('queued','running')") > 0; i++) await new Promise((res) => setTimeout(res, 50));
	return linksFor(1).ga4!;
}

describe('GA4 value request', () => {
	it('asks for engagement time, revenue and transactions, merges landing pages that differ by query string, and reads the currency', async () => {
		const id = upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.readonly' });
		let body: Record<string, any> = {};
		const f = vi.fn(async (_u: string, init?: RequestInit) => ((body = JSON.parse(String(init?.body))), json({ rows: [r(['/a?x=1'], [10, 5, 1, 300, 50, 1]), r(['/a'], [6, 3, 0, 120, 0, 0]), r(['/b'], [4, 1, 0, 20, 0, 0])], metadata: { currencyCode: 'EUR' } })));
		const out = await valueReport(id, 'properties/1', 'landing', '2026-10-22', '2026-11-18', { fetchImpl: f as never });
		expect(body.dimensions).toEqual([{ name: 'landingPagePlusQueryString' }]);
		expect(body.metrics.map((m: { name: string }) => m.name)).toEqual(['sessions', 'engagedSessions', 'keyEvents', 'userEngagementDuration', 'totalRevenue', 'transactions']);
		expect(body.limit).toBe(VALUE_ROW_LIMIT.landing);
		expect(out.currency).toBe('EUR');
		expect(out.truncated).toBe(false);
		expect(out.rows).toEqual([
			{ key: '/a', sessions: 16, engagedSessions: 8, keyEvents: 1, engagementSec: 420, revenue: 50, transactions: 1 },
			{ key: '/b', sessions: 4, engagedSessions: 1, keyEvents: 0, engagementSec: 20, revenue: 0, transactions: 0 }
		]);
	});

	it('campaigns are grouped by sessionCampaignName and a missing currency stays null', async () => {
		const id = upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.readonly' });
		let body: Record<string, any> = {};
		const f = vi.fn(async (_u: string, init?: RequestInit) => ((body = JSON.parse(String(init?.body))), json({ rows: [r(['spring'], [3, 2, 1, 90, 0, 0])] })));
		const out = await valueReport(id, 'properties/1', 'campaign', '2026-10-22', '2026-11-18', { fetchImpl: f as never });
		expect(body.dimensions).toEqual([{ name: 'sessionCampaignName' }]);
		expect(out.currency).toBeNull();
		expect(out.rows[0].key).toBe('spring');
	});

	it('site search asks for view_search_results terms and merges different casing', async () => {
		const id = upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.readonly' });
		let body: Record<string, any> = {};
		const f = vi.fn(async (_u: string, init?: RequestInit) => ((body = JSON.parse(String(init?.body))), json({ rows: [r(['Shipping'], [5, 4]), r(['shipping '], [3, 3]), r(['(not set)'], [9, 9]), r(['returns'], [7, 6])] })));
		const out = await siteSearchTerms(id, 'properties/1', '2026-10-22', '2026-11-18', { fetchImpl: f as never });
		expect(body.dimensions).toEqual([{ name: 'searchTerm' }]);
		expect(body.dimensionFilter.filter).toEqual({ fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'view_search_results' } });
		expect(out).toEqual([
			{ term: 'shipping', searches: 8, users: 4 },
			{ term: 'returns', searches: 7, users: 6 }
		]);
	});
});

describe('GA4 values in sync and report', () => {
	it('demo sync stores every period with time, revenue, campaigns and search terms', async () => {
		await linked();
		for (const days of PERIODS) expect(n('SELECT COUNT(*) n FROM ga4_value_windows WHERE site_id = 1 AND days = ?', days)).toBe(1);
		const v = ga4ValuesReport(getSite(1)!, 28);
		if (!v.linked || v.status !== 'ok') throw new Error('expected values, got ' + JSON.stringify(v));
		expect(v.currency).toBe('USD');
		expect(v.hasRevenue).toBe(true);
		expect(v.channels.find((c) => c.key === 'Organic Search')!.avgEngagementSec).toBeGreaterThan(0);
		expect(v.campaigns.some((c) => c.key === 'newsletter_weekly')).toBe(true);
		expect(v.searchTerms.length).toBeGreaterThan(0);
		// channel sessions agree with the daily channel table over the same window
		const daily = n("SELECT SUM(sessions) n FROM ga4_daily WHERE site_id = 1 AND date BETWEEN ? AND ?", v.window.start, v.window.end);
		expect(v.totals.sessions).toBe(daily);
		expect(ga4ValuesReport(getSite(1)!, 5)).toMatchObject({ status: 'no-window' });
	}, 30_000);

	it('a failure is recorded, keeps the last rows, and is retried; once a day after a success', async () => {
		const link = await linked();
		const today = pacificToday();
		const real = ga4SourceFor(link.account_id!);
		// as on the next day: the last success was yesterday
		db().prepare("UPDATE sites SET ga4_values_on = '2000-01-01' WHERE id = 1").run();
		let calls = 0;
		const failing = { ...real, values: async () => ((calls++, Promise.reject(new Error('quota exhausted')))) as never };
		expect(await pullGa4Values(1, link.external_id, failing, today)).toEqual({ ok: false });
		const v = ga4ValuesReport(getSite(1)!, 28);
		if (!v.linked || v.status !== 'ok') throw new Error('expected stale rows');
		expect(v.staleError).toContain('quota exhausted');
		expect(v.channels.length).toBeGreaterThan(0);
		let ok = 0;
		const counting = { ...real, values: (...a: Parameters<NonNullable<typeof real.values>>) => ((ok++, real.values!(...a))) };
		expect(await pullGa4Values(1, link.external_id, counting, today)).toEqual({ ok: true });
		const after = ok;
		expect(await pullGa4Values(1, link.external_id, counting, today)).toEqual({ ok: true });
		expect(ok).toBe(after); // nothing asked again the same day
		const fresh = ga4ValuesReport(getSite(1)!, 28);
		expect(fresh.linked && fresh.status === 'ok' && fresh.staleError).toBeNull();
		expect(calls).toBeGreaterThan(0);
	}, 30_000);

	it('when only site search fails, values are stored and the old terms are kept', async () => {
		const link = await linked();
		const before = n('SELECT COUNT(*) n FROM ga4_search_terms WHERE site_id = 1');
		expect(before).toBeGreaterThan(0);
		db().prepare('UPDATE sites SET ga4_values_on = NULL WHERE id = 1').run();
		const real = ga4SourceFor(link.account_id!);
		expect(await pullGa4Values(1, link.external_id, { ...real, searchTerms: async () => Promise.reject(new Error('nope')) }, pacificToday())).toEqual({ ok: true });
		expect(n('SELECT COUNT(*) n FROM ga4_search_terms WHERE site_id = 1')).toBe(before);
	}, 30_000);

	it('MCP views value, campaigns and site_search answer from stored data', async () => {
		await linked();
		const { key } = createApiKey('t', null);
		const call = async (args: object) => {
			const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_ga4_summary', arguments: { site: '1', ...args } } }) }));
			const out = (await res.json()).result;
			expect(out.isError, out.content[0].text).toBeFalsy();
			return JSON.parse(out.content[0].text);
		};
		const value = await call({ view: 'value' });
		expect(value.currency).toBe('USD');
		expect(value.channels[0]).toHaveProperty('avgEngagementSeconds');
		expect(value.channels[0]).toHaveProperty('revenue');
		const camp = await call({ view: 'campaigns', search: 'newsletter' });
		expect(camp.campaigns.map((c: { campaign: string }) => c.campaign)).toEqual(['newsletter_weekly']);
		const search = await call({ view: 'site_search', limit: 3 });
		expect(search.terms).toHaveLength(3);
		expect((await call({ view: 'value', days: 90 })).window).toBeTruthy();
	}, 30_000);
});

describe('formatting', () => {
	it('engagement time reads like GA4 and money uses the property currency', () => {
		expect(fmtDur(42)).toBe('42s');
		expect(fmtDur(65)).toBe('1m 05s');
		expect(fmtDur(null)).toBe('–');
		expect(fmtMoney(12.5, 'USD')).toBe('$12.50');
		expect(fmtMoney(2500, 'EUR')).toBe('€2,500');
		expect(fmtMoney(3, null)).toBe('3.00');
		expect(fmtMoney(3, 'NOT_A_CODE')).toContain('NOT_A_CODE');
	});
});
