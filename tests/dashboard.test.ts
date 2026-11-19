import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts, upsertGoogleAccount } from '../src/lib/server/accounts';
import { autoMatchGa4 } from '../src/lib/server/connect';
import { ga4SourceFor, pullGa4Dims, syncGa4, type Ga4Source } from '../src/lib/server/channels';
import { dailyByDimension } from '../src/lib/server/ga4';
import { dashboardFor } from '../src/lib/server/dashboard';
import { getSite } from '../src/lib/server/clients';
import { linksFor, saveIntegration } from '../src/lib/server/links';
import { addDays, pacificToday } from '../src/lib/server/dates';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';

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

describe('GA4 breakdowns by day', () => {
	it('asks GA4 for date plus one dimension, pages past 100,000 rows, and names empty values', async () => {
		const id = upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.readonly' });
		const bodies: Record<string, any>[] = [];
		const row = (date: string, v: string, s: number) => ({ dimensionValues: [{ value: date }, { value: v }], metricValues: [s, s - 1, 1, s * 2].map((x) => ({ value: String(x) })) });
		const f = vi.fn(async (_u: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			bodies.push(body);
			// a full first page, then a short one
			return json({ rows: body.offset === 0 ? Array.from({ length: 100_000 }, () => row('20261118', 'United States', 3)) : [row('20261119', '', 2)] });
		});
		const out = await dailyByDimension(id, 'properties/1', 'country', '2026-11-18', '2026-11-19', { fetchImpl: f as never });
		expect(bodies).toHaveLength(2);
		expect(bodies[0].dimensions).toEqual([{ name: 'date' }, { name: 'country' }]);
		expect(bodies[0].metrics.map((m: { name: string }) => m.name)).toEqual(['sessions', 'engagedSessions', 'keyEvents', 'screenPageViews']);
		expect(bodies[1].offset).toBe(100_000);
		expect(out.at(-1)).toEqual({ date: '2026-11-19', value: '(not set)', sessions: 2, engagedSessions: 1, keyEvents: 1, pageviews: 4 });
	});

	it('demo sync stores country, device and visitor days that add up to the channel totals', async () => {
		await linked();
		for (const dim of ['country', 'deviceCategory', 'newVsReturning']) {
			const byDim = n('SELECT SUM(sessions) n FROM ga4_dim_daily WHERE site_id = 1 AND dim = ?', dim);
			const byChannel = n('SELECT SUM(sessions) n FROM ga4_daily WHERE site_id = 1');
			expect(byDim, dim).toBe(byChannel);
		}
	}, 30_000);

	it('pulls the whole history once, then only the last 10 days; a failure is recorded and never fails the GA4 sync', async () => {
		const link = await linked();
		const today = pacificToday();
		const real = ga4SourceFor(link.account_id!);
		const starts: string[] = [];
		const spy: Ga4Source = { ...real, dimDaily: (p, dim, s, e) => (starts.push(s), real.dimDaily!(p, dim, s, e)) };
		db().prepare("DELETE FROM ga4_dim_daily WHERE dim = 'country'").run();
		await pullGa4Dims(1, link.external_id, spy, today);
		expect(starts[0] < addDays(today, -400)).toBe(true); // country was empty: full history
		expect(starts.slice(1)).toEqual([addDays(today, -10), addDays(today, -10)]);
		const broken: Ga4Source = { ...real, dimDaily: async () => { throw new Error('quota'); } };
		await syncGa4(1, broken, today);
		expect(linksFor(1).ga4!.sync_status).toBe('idle');
		const site = getSite(1)!;
		const dash = dashboardFor(site, 28);
		if (!dash.ga4?.synced) throw new Error('expected GA4');
		expect(dash.ga4.breakdownsError).toBe('quota');
		expect(dash.ga4.breakdowns).not.toBeNull(); // the rows already stored are still shown
		await syncGa4(1, real, today);
		expect(dashboardFor(site, 28).ga4).toMatchObject({ breakdownsError: null });
	}, 30_000);
});

describe('all-sources dashboard', () => {
	it('puts Search Console, GA4 and Clarity side by side, each on its own dates', async () => {
		await linked();
		await syncSite(1, { client: new DemoClient('demo-a') });
		const site = getSite(1)!;
		// Clarity linked, with a snapshot shaped like a live API answer (distinctUserCount, numbers as strings and numbers)
		const integ = saveIntegration('clarity', 'p', { token: 't' });
		db().prepare("INSERT OR REPLACE INTO site_links (site_id, kind, integration_id, external_id, created_at) VALUES (1, 'clarity', ?, 'p', 0)").run(integ);
		const payload = [
			{ metricName: 'Traffic', information: [{ totalSessionCount: '179', totalBotSessionCount: 86, distinctUserCount: '167' }] },
			{ metricName: 'DeadClickCount', information: [{ sessionsCount: 179, sessionsWithMetricPercentage: 11.17 }] },
			{ metricName: 'ScrollDepth', information: [{ averageScrollDepth: 27.05 }] },
			{ metricName: 'EngagementTime', information: [{ totalTime: 89, activeTime: 46 }] },
			{ metricName: 'Country', information: [{ name: 'United States', sessionsCount: 80 }, { name: 'India', sessionsCount: 23 }] },
			{ metricName: 'Device', information: [{ name: 'Mobile', sessionsCount: 155 }, { name: 'PC', sessionsCount: 23 }] },
			{ metricName: 'ReferrerUrl', information: [{ name: 'www.bing.com', sessionsCount: 6 }] },
			{ metricName: 'PopularPages', information: [{ url: 'https://x.example/jobs', visitsCount: 45 }] }
		];
		db().prepare("INSERT INTO clarity_snapshots VALUES (1, '2026-11-19', '', ?, 0)").run(JSON.stringify(payload));
		const d = dashboardFor(site, 28);
		expect(d.gsc.clicks).toBeGreaterThan(0);
		expect(d.gsc.countries.length).toBeGreaterThan(0);
		expect(d.gsc.countries[0].key).toBe(d.gsc.countries[0].key.toUpperCase());
		if (!d.ga4?.synced) throw new Error('expected GA4');
		expect(d.ga4.channels[0].key).toBe('Organic Search');
		expect(d.ga4.breakdowns!.countries[0].key).toBe('United States');
		expect(d.ga4.sources?.rows[0]).toMatchObject({ source: 'google', medium: 'organic' });
		const shares = d.ga4.channels.reduce((a, c) => a + c.share, 0);
		expect(shares).toBeCloseTo(1, 5);
		if (!d.clarity?.synced) throw new Error('expected Clarity');
		expect(d.clarity).toMatchObject({ day: '2026-11-19', sessions: 179, bots: 86, humans: 93, users: 167, deadClicks: 0.1117, activeTime: 46, totalTime: 89 });
		expect(d.clarity.scrollDepth).toBeCloseTo(0.2705, 5);
		expect(d.clarity.countries[0]).toEqual({ name: 'United States', sessions: 80 });
		expect(d.clarity.pages[0]).toEqual({ name: 'https://x.example/jobs', sessions: 45 });
		expect(d.clarity.rageClicks).toBeNull(); // not in the payload: unknown, not zero
	}, 30_000);

	it('24h is each source\'s newest day; periods without stored sources say so instead of showing nothing', async () => {
		await linked();
		const site = getSite(1)!;
		const d = dashboardFor(site, 1);
		if (!d.ga4?.synced) throw new Error('expected GA4');
		const newestGa4 = (db().prepare('SELECT MAX(date) d FROM ga4_daily WHERE site_id = 1').get() as { d: string }).d;
		expect(d.ga4.window).toEqual({ start: newestGa4, end: newestGa4 });
		expect(d.gsc.window.start).toBe(d.gsc.window.end);
		expect(d.ga4.sessions).toBe(n('SELECT SUM(sessions) n FROM ga4_daily WHERE site_id = 1 AND date = ?', newestGa4));
		expect(d.ga4.sources).toBeNull();
		expect(d.ga4.landing).toBeNull();
		expect(d.clarity).toBeNull(); // not linked
	}, 30_000);
});
