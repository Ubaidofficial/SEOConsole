import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { MAX_DAYS, MENU_PERIODS, PERIODS, QUICK_PERIODS, daysSince, isIsoDay, periodLabel, shiftDay } from '../src/lib/periods';
import { daysParam } from '../src/lib/server/params';
import { makePeriod } from '../src/lib/server/dates';
import { newestDataDay, periodFor, siteEnd, topQueries } from '../src/lib/server/queries';
import { GET as exportCsv } from '../src/routes/sites/[id]/export/+server';

/**
 * 24h and 3d, then a date-picker menu. A start date means "since then, up to the newest data": every report keeps one consistent window
 * (GA4 unique users and search appearance are fetched from Google for fixed windows ending today, so a window ending in the past could
 * not be shown consistently on every page).
 */
const url = (q: string) => new URL('http://localhost/x?' + q);

describe('the period list', () => {
	it('the sync list is unchanged, because every entry costs Google API calls on every sync; the picker has its own list', () => {
		expect([...PERIODS]).toEqual([7, 28, 90, 180, 480]);
		expect([...QUICK_PERIODS]).toEqual([1, 3, 7, 28]);
		expect([...MENU_PERIODS]).toEqual([90, 180, 480]);
		expect(periodLabel(1)).toBe('24h');
		expect([3, 7, 28, 90, 180, 480].map(periodLabel)).toEqual(['3d', '7d', '28d', '3m', '6m', '16m']);
	});
	it('day arithmetic: a window since a date counts both ends, and refuses dates after the newest data or too far back', () => {
		expect(daysSince('2026-11-12', '2026-11-12')).toBe(1);
		expect(daysSince('2026-11-10', '2026-11-12')).toBe(3);
		expect(daysSince('2026-10-16', '2026-11-12')).toBe(28);
		expect(daysSince('2026-11-13', '2026-11-12')).toBeNull();
		expect(daysSince(shiftDay('2026-11-12', -MAX_DAYS), '2026-11-12')).toBeNull();
		expect(daysSince(shiftDay('2026-11-12', -(MAX_DAYS - 1)), '2026-11-12')).toBe(MAX_DAYS);
		for (const bad of ['', 'x', '2026-13-40', '2026-02-30', '26-11-12']) expect(daysSince(bad, '2026-11-12'), bad).toBeNull();
		expect(isIsoDay('2026-02-29')).toBe(false); // 2026 is not a leap year
		expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
	});
});

describe('the days the address asks for', () => {
	it('takes any whole number from 1 to the maximum, and falls back to 28 for anything else', () => {
		for (const n of [1, 3, 7, 28, 39, 90, 480, MAX_DAYS]) expect(daysParam(url(`days=${n}`)), String(n)).toBe(n);
		for (const bad of ['0', '-1', '1.5', 'abc', '', String(MAX_DAYS + 1), '1e3x']) expect(daysParam(url(`days=${bad}`)), bad).toBe(28);
		expect(daysParam(url(''))).toBe(28);
	});
	it('a start date becomes days against the newest data, and beats ?days=; without the newest day, or when it is not usable, it is ignored', () => {
		expect(daysParam(url('from=2026-10-16'), '2026-11-12')).toBe(28);
		expect(daysParam(url('from=2026-11-12&days=7'), '2026-11-12')).toBe(1);
		expect(daysParam(url('from=2026-10-16'))).toBe(28); // no newest day given: the plain default
		expect(daysParam(url('from=2026-10-16&days=7'))).toBe(7);
		expect(daysParam(url('from=2026-11-20&days=7'), '2026-11-12')).toBe(7); // after the newest data
		expect(daysParam(url('from=garbage&days=3'), '2026-11-12')).toBe(3);
	});
});

describe('short windows', () => {
	it('24h is the newest day against the day before; 3d is three days against the three before', () => {
		expect(makePeriod('2026-11-12', 1)).toEqual({ start: '2026-11-12', end: '2026-11-12', prevStart: '2026-11-11', prevEnd: '2026-11-11', days: 1 });
		expect(makePeriod('2026-11-12', 3)).toEqual({ start: '2026-11-10', end: '2026-11-12', prevStart: '2026-11-07', prevEnd: '2026-11-09', days: 3 });
	});
});

describe('against real (demo) data', () => {
	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
		await syncSite(1, { client: new DemoClient('demo-a'), mode: 'auto', backfillChunkDays: 60 });
	}, 120_000);

	it('the newest data day is the newest site end, and a start date reaches exactly that far back for a site', () => {
		const site = getSite(1)!;
		const end = siteEnd(site);
		expect(newestDataDay([site])).toBe(end);
		const from = shiftDay(end, -9);
		const days = daysParam(url(`from=${from}`), end);
		expect(days).toBe(10);
		expect(periodFor(site, days).start).toBe(from);
		expect(periodFor(site, days).end).toBe(end);
	});

	it('the CSV export follows the same window: a start date gives the same rows as the matching number of days', async () => {
		const site = getSite(1)!;
		const end = siteEnd(site);
		const get = async (q: string) => (await (exportCsv({ params: { id: '1' }, url: url(q) } as never) as Response).text());
		const rows = (csv: string) => csv.split('\r\n').slice(1).filter(Boolean).length;
		const byFrom = await get(`from=${shiftDay(end, -2)}`);
		const byDays = await get('days=3');
		expect(byFrom).toBe(byDays);
		// exactly the rows the app's own query function gives for that window (a per-query table never sums to the site total: Google hides some queries)
		expect(rows(byDays)).toBe(topQueries(1, shiftDay(end, -2), end, {}, 100_000).length);
		const oneDay = await get('days=1');
		expect(rows(oneDay)).toBe(topQueries(1, end, end, {}, 100_000).length);
		expect(oneDay).not.toBe(byDays);
		expect(rows(byDays)).toBeGreaterThan(0);
	});
});

describe('the picker', () => {
	const picker = readFileSync('src/lib/components/PeriodPicker.svelte', 'utf8');
	it('has the four quick buttons, then a menu with the longer ranges and a native date input that submits a plain GET form', () => {
		expect(picker).toContain('QUICK_PERIODS');
		expect(picker).toContain('MENU_PERIODS');
		expect(picker).toMatch(/<form method="GET" action=\{page\.url\.pathname\}/);
		expect(picker).toMatch(/<input[^>]*name="from" type="date"[^>]*required/);
		expect(picker).toMatch(/max=\{latest/); // no dates after the newest data
		expect(picker).toContain('<details');
		expect(picker).toMatch(/Escape/);
	});
	it('keeps the rest of the page\'s query (tab, view) when a date is chosen, and drops the old period', () => {
		expect(picker).toMatch(/k !== 'days' && k !== 'from'/);
		expect(picker).toMatch(/searchParams\.delete\('from'\)/);
	});
	it('says what 24h means, because Search Console reports whole days about two days behind', () => {
		expect(picker).toMatch(/title=\{d === 1 \? 'The newest day Search Console has/);
	});
	it('is used on the dashboard, the portfolio and every site page, each with the newest data day', () => {
		for (const f of ['src/routes/+page.svelte', 'src/routes/portfolio/+page.svelte', 'src/routes/sites/[id]/+layout.svelte']) expect(readFileSync(f, 'utf8'), f).toContain('<PeriodPicker days={data.days} latest={data.latest} />');
	});
	it('a one-day dashboard card says there is no trend line to draw instead of drawing an empty chart', () => {
		expect(readFileSync('src/routes/+page.svelte', 'utf8')).toMatch(/c\.spark\.length > 1[\s\S]*One day of data, so there is no trend line/);
	});
});
