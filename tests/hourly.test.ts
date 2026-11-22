import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { pullHourly, syncSite, HOURLY_DAYS } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { hourLabel, hourlyReport } from '../src/lib/server/hourly';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';
import type { GscClient, QueryBody, SearchRow } from '../src/lib/server/google';

const row = (keys: string[], clicks: number, impressions = clicks * 10): SearchRow => ({ keys, clicks, impressions, ctr: clicks / impressions, position: 5 });
const hourKey = (day: string, h: number) => `${day}T${String(h).padStart(2, '0')}:00:00-08:00`;

function fake(answer: (b: QueryBody) => SearchRow[]): GscClient & { bodies: QueryBody[] } {
	const bodies: QueryBody[] = [];
	return { bodies, query: async (_u: string, b: QueryBody) => (bodies.push(b), answer(b)) } as never;
}

describe('hourly pull', () => {
	beforeEach(async () => {
		process.env.SCHEDULER = '0';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
	});

	it('asks for HOUR with HOURLY_ALL over 10 days, and by page over the last 2', async () => {
		const c = fake((b) => (b.dimensions!.length === 1 ? [row([hourKey('2026-11-20', 9)], 4)] : [row([hourKey('2026-11-20', 9), 'https://x.com/a'], 3)]));
		const r = await pullHourly(c, 1, 'sc-domain:x.com', '2026-11-20');
		expect(r).toEqual({ ok: true, hours: 1, pages: true });
		expect(c.bodies[0]).toMatchObject({ startDate: '2026-11-11', endDate: '2026-11-20', dimensions: ['HOUR'], dataState: 'HOURLY_ALL' });
		expect(HOURLY_DAYS).toBe(10);
		expect(c.bodies[1]).toMatchObject({ startDate: '2026-11-19', endDate: '2026-11-20', dimensions: ['HOUR', 'page'], dataState: 'HOURLY_ALL' });
		expect((db().prepare('SELECT COUNT(*) n FROM sa_hourly WHERE site_id = 1').get() as { n: number }).n).toBe(2);
	});

	it('keeps the totals when Google refuses hourly by page, and stores nothing when it refuses hourly altogether', async () => {
		const c = fake((b) => {
			if (b.dimensions!.length > 1) throw new Error('400 invalid dimensions');
			return [row([hourKey('2026-11-20', 9)], 4)];
		});
		expect(await pullHourly(c, 1, 'sc-domain:x.com', '2026-11-20')).toEqual({ ok: true, hours: 1, pages: false });
		expect(hourlyReport(1)!.empty).toBe(false);
		const h = hourlyReport(1)!;
		expect(!h.empty && h.pages).toBeNull();
		const refused = fake(() => {
			throw new Error('400 unknown dataState');
		});
		expect(await pullHourly(refused, 1, 'sc-domain:x.com', '2026-11-20')).toEqual({ ok: false, hours: 0, pages: false });
		// the earlier hours stay: a refusal is not "no clicks"
		expect((db().prepare('SELECT COUNT(*) n FROM sa_hourly WHERE site_id = 1').get() as { n: number }).n).toBe(1);
	});
});

describe('hourly report', () => {
	beforeEach(async () => {
		process.env.SCHEDULER = '0';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
	});

	it('the last 24 hours end at the newest hour with data, compared with the 24 before; pages count only the newer 24', async () => {
		const totals: SearchRow[] = [];
		for (let h = 0; h < 24; h++) totals.push(row([hourKey('2026-11-19', h)], 1));
		for (let h = 0; h < 10; h++) totals.push(row([hourKey('2026-11-20', h)], 2));
		const pages = [row([hourKey('2026-11-19', 3), 'https://x.com/old'], 50), row([hourKey('2026-11-20', 8), 'https://x.com/new'], 7), row([hourKey('2026-11-19', 20), 'https://x.com/new'], 1)];
		await pullHourly(fake((b) => (b.dimensions!.length === 1 ? totals : pages)), 1, 'sc-domain:x.com', '2026-11-20');
		const h = hourlyReport(1)!;
		if (h.empty) throw new Error('expected data');
		expect(h.through).toBe(hourKey('2026-11-20', 9));
		// newest 24 hours: 2026-11-19 10:00 … 2026-11-20 09:00 = 14 × 1 + 10 × 2
		expect(h.last24).toMatchObject({ clicks: 34, hours: 24 });
		expect(h.prev24).toMatchObject({ clicks: 10, hours: 10 });
		expect(h.hours).toHaveLength(48);
		expect(h.hours.filter((x) => x.recent)).toHaveLength(24);
		expect(h.hours.at(-1)!.label).toBe('09:00');
		expect(h.pages).toEqual([{ page: 'https://x.com/new', clicks: 8, impressions: 80 }]);
		expect(hourLabel('2026-11-20T14:00:00-08:00')).toBe('14:00');
	});

	it('is null before the first read', () => {
		expect(hourlyReport(1)).toBeNull();
	});
});

describe('hourly in the demo sync and MCP', () => {
	beforeAll(async () => {
		process.env.SCHEDULER = '0';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
		await syncSite(1, { client: new DemoClient('demo-a'), backfillChunkDays: 30 });
	}, 120_000);

	it('a sync stores hourly totals and pages, and get_last_24_hours answers from them', async () => {
		const h = hourlyReport(1)!;
		if (h.empty) throw new Error('expected demo hourly data');
		expect(h.last24.clicks).toBeGreaterThan(0);
		expect(h.pages!.length).toBeGreaterThan(0);
		const { key } = createApiKey('t', null);
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_last_24_hours', arguments: { site: '1', limit: 3 } } }) }));
		const out = (await res.json()).result;
		expect(out.isError, out.content[0].text).toBeFalsy();
		const body = JSON.parse(out.content[0].text);
		expect(body.last24Hours.clicks).toBe(h.last24.clicks);
		expect(body.byHour).toHaveLength(24);
		expect(body.topPages.length).toBeLessThanOrEqual(3);
	});
});
