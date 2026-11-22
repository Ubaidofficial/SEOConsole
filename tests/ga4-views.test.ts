import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts, upsertGoogleAccount } from '../src/lib/server/accounts';
import { autoMatchGa4 } from '../src/lib/server/connect';
import { pageTitles, pageViewsDaily, usersTotal } from '../src/lib/server/ga4';
import { pullGa4PageViews, USER_WINDOWS, type Ga4Source } from '../src/lib/server/channels';
import { ga4UsersFor, pageViewsFor } from '../src/lib/server/traffic';
import { mergePages, type PageSources } from '../src/lib/pageinsights';
import { pageInsights } from '../src/lib/server/pageinsights';
import { getSite } from '../src/lib/server/clients';
import { queueDepth } from '../src/lib/server/jobs';
import { load as siteLayoutLoad } from '../src/routes/sites/[id]/+layout.server';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const row = (dims: string[], metrics: number[]) => ({ dimensionValues: dims.map((value) => ({ value })), metricValues: metrics.map((m) => ({ value: String(m) })) });
const drain = async () => {
	const end = Date.now() + 30_000;
	while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
};

beforeEach(() => {
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
});

describe('GA4 requests', () => {
	const account = () => upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.readonly' });

	it('page views: date + pagePath, newest days first, paths with a query string merged, and a cut at the row limit says so', async () => {
		const id = account();
		const bodies: Record<string, any>[] = [];
		const f = vi.fn(async (_u: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			bodies.push(body);
			return json({ rows: Array.from({ length: 100_000 }, (_, i) => row(['20261121', body.offset === 0 && i === 0 ? '/a?x=1' : body.offset === 0 && i === 1 ? '/a' : `/p${body.offset + i}`], [2])) });
		});
		const r = await pageViewsDaily(id, 'properties/1', '2026-11-01', '2026-11-21', { fetchImpl: f as never }, 150_000);
		expect(bodies[0].dimensions).toEqual([{ name: 'date' }, { name: 'pagePath' }]);
		expect(bodies[0].metrics).toEqual([{ name: 'screenPageViews' }]);
		expect(bodies[0].orderBys[0]).toEqual({ dimension: { dimensionName: 'date' }, desc: true });
		expect(bodies.map((b) => b.offset)).toEqual([0, 100_000]);
		expect(r.truncated).toBe(true);
		expect(r.rows.find((x) => x.page === '/a')).toEqual({ date: '2026-11-21', page: '/a', views: 4 });
	});

	it('titles: the busiest title per path, "(not set)" skipped; users: GA4 active and new users for the window', async () => {
		const id = account();
		const titles = vi.fn(async () => json({ rows: [row(['/a', 'Main title'], [50]), row(['/a', 'Old title'], [3]), row(['/b', '(not set)'], [9]), row(['/b?q=1', 'B page'], [2])] }));
		expect(await pageTitles(id, 'properties/1', '2026-10-25', '2026-11-21', { fetchImpl: titles as never })).toEqual([{ page: '/a', title: 'Main title' }, { page: '/b', title: 'B page' }]);
		const users = vi.fn(async (_u: string, init?: RequestInit) => (expect(JSON.parse(String(init?.body)).dimensions).toBeUndefined(), json({ rows: [{ metricValues: [{ value: '211' }, { value: '198' }] }] })));
		expect(await usersTotal(id, 'properties/1', '2026-11-15', '2026-11-21', { fetchImpl: users as never })).toEqual({ activeUsers: 211, newUsers: 198 });
	});
});

describe('storing page views, titles and users', () => {
	const TODAY = '2026-11-22';
	const seed = () => {
		db().prepare("INSERT INTO accounts (id, google_sub, email, status, created_at) VALUES (1, 's', 'o@example.com', 'active', 1)").run();
		db().prepare("INSERT INTO sites (id, account_id, site_url, permission, hidden, created_at) VALUES (1, 1, 'sc-domain:x.example', 'siteOwner', 0, 1)").run();
	};
	const source = (calls: string[], fail = false): Ga4Source =>
		({
			pageViews: async (_p: string, s: string, e: string) => {
				calls.push(`views ${s} ${e}`);
				if (fail) throw new Error('GA4 said no');
				return { rows: [{ date: '2026-11-21', page: '/a', views: 5 }, { date: TODAY, page: '/a', views: 1 }], truncated: false };
			},
			pageTitles: async () => (calls.push('titles'), [{ page: '/a', title: 'A page' }]),
			usersTotal: async (_p: string, s: string, e: string) => (calls.push(`users ${s} ${e}`), { activeUsers: 10, newUsers: 7 })
		}) as never;

	it('first pull covers 90 days, later ones the last 10; titles and users once a day, users ending yesterday for every preset window', async () => {
		seed();
		const calls: string[] = [];
		await pullGa4PageViews(1, 'properties/1', source(calls), TODAY);
		expect(calls[0]).toBe('views 2026-08-25 2026-11-22');
		expect(calls.filter((c) => c.startsWith('users')).map((c) => c.split(' ')[1])).toEqual(USER_WINDOWS.map((d) => new Date(Date.parse('2026-11-21') - (d - 1) * 86_400_000).toISOString().slice(0, 10)));
		expect(calls.filter((c) => c.startsWith('users')).every((c) => c.endsWith(' 2026-11-21'))).toBe(true);
		calls.length = 0;
		await pullGa4PageViews(1, 'properties/1', source(calls), TODAY);
		expect(calls).toEqual(['views 2026-11-12 2026-11-22']); // titles and users already pulled today
		expect(ga4UsersFor(1, 7)).toEqual({ activeUsers: 10, newUsers: 7, window: { start: '2026-11-15', end: '2026-11-21' } });
		expect(ga4UsersFor(1, 14)).toBeNull();
	});

	it('a failure is recorded on the site and never thrown', async () => {
		seed();
		expect(await pullGa4PageViews(1, 'properties/1', source([], true), TODAY)).toEqual({ ok: false });
		expect((db().prepare('SELECT ga4_views_error e FROM sites WHERE id = 1').get() as { e: string }).e).toBe('GA4 said no');
	});

	it('page views for a period end on the newest complete day (today left out), with titles; no change without the previous period', async () => {
		seed();
		await pullGa4PageViews(1, 'properties/1', source([]), TODAY);
		const pv = pageViewsFor(1, 3, TODAY)!;
		expect(pv.window).toEqual({ start: '2026-11-19', end: '2026-11-21' });
		expect(pv.views.get('/a')).toBe(5);
		expect(pv.titles.get('/a')).toBe('A page');
		expect(pv.prev).toBeNull();
	});
});

describe('page views on the Pages tab', () => {
	const base: PageSources = { google: [], googlePrev: [], bing: null, bingPrev: null, ga4: null, ga4Prev: null, ai: null, aiPrev: null, clarity: null };
	it('joins views and titles on the folded path, adds pages only GA4 saw viewed, and gives a change only with the previous period', () => {
		const rows = mergePages({ ...base, google: [{ url: 'https://www.x.example/a/', clicks: 1, impressions: 3, position: 9 }], views: new Map([['/a', 40], ['/viewed-only', 6]]), viewsPrev: new Map([['/a', 20]]), titles: new Map([['/a', 'A page']]) }, (p) => 'https://x.example' + p);
		const by = (p: string) => rows.find((r) => r.path === p)!;
		expect(by('/a')).toMatchObject({ tViews: 40, tViewsD: 1, title: 'A page', gClicks: 1 });
		expect(by('/viewed-only')).toMatchObject({ tViews: 6, tViewsD: null, gClicks: null }); // zero views before: a percentage cannot be given
		const noPrev = mergePages({ ...base, views: new Map([['/a', 40]]), viewsPrev: null }, (p) => p);
		expect(noPrev[0].tViewsD).toBeNull();
	});
});

describe('on demo data', () => {
	beforeEach(async () => {
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		await autoMatchGa4();
		await drain();
	}, 120_000);

	it('the site page headline has GA4 sessions with users for a preset period, next to Google clicks', () => {
		const k = (siteLayoutLoad({ params: { id: '1' }, url: new URL('http://x/sites/1?days=7') } as never) as { kpis: { clicks: number; ga4: { sessions: number; users: number | null } | null } }).kpis;
		expect(k.ga4?.sessions).toBeGreaterThan(0);
		expect(k.ga4?.users).toBeGreaterThan(0);
		expect(k.ga4!.users!).toBeLessThan(k.ga4!.sessions);
	}, 60_000);

	it('the Pages tab says "nothing in this period" once a source has synced, and "after the first sync" before', () => {
		const site = getSite(1)!;
		expect(pageInsights(site, 7).ga4.synced).toBe(true);
		expect(pageInsights(site, 7).views.hasData).toBe(true);
		db().prepare("UPDATE site_links SET last_sync_at = NULL WHERE site_id = 1 AND kind = 'ga4'").run();
		expect(pageInsights(site, 7).ga4.synced).toBe(false);
	}, 60_000);
});
