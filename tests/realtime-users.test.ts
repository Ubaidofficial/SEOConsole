import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts, upsertGoogleAccount } from '../src/lib/server/accounts';
import { realtimeUsers } from '../src/lib/server/ga4';
import { realtimeFor } from '../src/lib/server/realtime';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const r = (v: string[], m: number[]) => ({ dimensionValues: v.map((value) => ({ value })), metricValues: m.map((x) => ({ value: String(x) })) });

/** Answers a Realtime request by its first dimension, as GA4 would. */
function answer(body: { dimensions?: { name: string }[] }) {
	const dim = body.dimensions?.[0]?.name;
	if (!dim) return { rows: [{ metricValues: [{ value: '17' }] }] };
	if (dim === 'eventName') return { rows: [r(['page_view'], [40])] };
	if (dim === 'unifiedScreenName') return { rows: [r(['Home'], [9, 12]), r(['Pricing'], [4, 4])] };
	if (dim === 'country') return { rows: [r(['Spain'], [10])] };
	if (dim === 'deviceCategory') return { rows: [r(['mobile'], [11]), r(['desktop'], [6])] };
	if (dim === 'minutesAgo') return { rows: [r(['02'], [3]), r(['00'], [5])] };
	throw new Error('unexpected ' + dim);
}

beforeEach(async () => {
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
});

describe('GA4 realtime active users', () => {
	it('asks Realtime for active users in total and by page title, country, device and minute', async () => {
		const id = upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.readonly' });
		const urls: string[] = [];
		const dims: (string | undefined)[] = [];
		const f = async (u: string, init?: RequestInit) => {
			urls.push(u);
			const b = JSON.parse(String(init?.body));
			dims.push(b.dimensions?.[0]?.name);
			return json(answer(b));
		};
		const out = await realtimeUsers(id, 'properties/9', { fetchImpl: f as never });
		expect(urls.every((u) => u.endsWith('/properties/9:runRealtimeReport'))).toBe(true);
		expect(new Set(dims)).toEqual(new Set([undefined, 'unifiedScreenName', 'country', 'deviceCategory', 'minutesAgo']));
		expect(dims).not.toContain('pagePath'); // not a Realtime dimension
		expect(out).toEqual({
			total: 17,
			pages: [{ title: 'Home', users: 9, views: 12 }, { title: 'Pricing', users: 4, views: 4 }],
			countries: [{ country: 'Spain', users: 10 }],
			devices: [{ device: 'mobile', users: 11 }, { device: 'desktop', users: 6 }],
			minutes: [{ minutesAgo: 0, users: 5 }, { minutesAgo: 2, users: 3 }]
		});
	});

	it('realtimeFor still returns events when only the visitor breakdown fails', async () => {
		await ensureDemoAccounts();
		const id = upsertGoogleAccount({ sub: 'real', email: 'r@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.readonly' });
		db().prepare("DELETE FROM site_links WHERE site_id = 1 AND kind = 'ga4'").run();
		db().prepare("INSERT INTO site_links (site_id, kind, account_id, external_id, created_at) VALUES (1, 'ga4', ?, 'properties/9', ?)").run(id, Date.now());
		const f = async (_u: string, init?: RequestInit) => {
			const b = JSON.parse(String(init?.body));
			return b.dimensions?.[0]?.name === 'eventName' ? json(answer(b)) : json({ error: { code: 403, message: 'Realtime not allowed' } }, 403);
		};
		const rt = await realtimeFor(1, { fetchImpl: f as never });
		if (!rt.linked || !rt.ok) throw new Error('expected events: ' + JSON.stringify(rt));
		expect(rt.events).toEqual([{ event: 'page_view', count: 40 }]);
		expect(rt.users).toBeNull();
		expect(rt.usersError).toBeTruthy();
	});

	it('demo sites get labelled visitor data', async () => {
		await ensureDemoAccounts();
		const { autoMatchGa4 } = await import('../src/lib/server/connect');
		await autoMatchGa4();
		const rt = await realtimeFor(1);
		if (!rt.linked || !rt.ok) throw new Error('expected demo realtime');
		expect(rt.demo).toBe(true);
		expect(rt.users!.total).toBeGreaterThan(0);
	});
});
