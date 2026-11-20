import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { cardTraffic, sumSource } from '../src/lib/server/traffic';
import { mergePages, type PageSources } from '../src/lib/pageinsights';
import { addDays, eachDay } from '../src/lib/server/dates';

beforeEach(() => {
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	const d = db();
	d.prepare("INSERT INTO accounts (id, google_sub, email, status, created_at) VALUES (1, 's', 'o@example.com', 'active', 1)").run();
	d.prepare("INSERT INTO sites (id, account_id, site_url, permission, hidden, created_at) VALUES (1, 1, 'sc-domain:a.example', 'siteOwner', 0, 1)").run();
});

const TODAY = '2026-11-20';
const ga4Day = (date: string, channel: string, sessions: number) => db().prepare('INSERT INTO ga4_daily VALUES (1,?,?,?,?,?,?,?)').run(date, channel, sessions, 0, 0, 0, 0);
const bingDay = (date: string, clicks: number) => db().prepare('INSERT INTO bing_daily VALUES (1,?,?,?)').run(date, clicks, clicks * 10);
const gscOf = (end: string, days: number, clicks = 1) => ({ end, daily: eachDay(addDays(end, -(days - 1)), end).map((date) => ({ date, clicks })) });

describe('cardTraffic', () => {
	it('sums GA4 over every channel, drops the day still in progress, and lines every source up on one calendar', () => {
		for (const date of eachDay('2026-11-01', TODAY)) {
			ga4Day(date, 'Organic Search', 5);
			ga4Day(date, 'Direct', 3);
		}
		const t = cardTraffic({ id: 1 }, gscOf('2026-11-18', 7), 7, { ga4: { external_id: 'properties/1' } }, TODAY);
		// today (2026-11-20) is partial and left out, so GA4 ends yesterday and the chart ends there too
		expect(t.chart.dates).toEqual(eachDay('2026-11-13', '2026-11-19'));
		expect(t.ga4).toMatchObject({ value: 7 * 8, prev: 7 * 8, comparable: true, window: { start: '2026-11-13', end: '2026-11-19' } });
		expect(t.chart.ga4).toEqual(new Array(7).fill(8));
		// Search Console reports later: its line stops on its newest day instead of falling to zero
		expect(t.chart.gsc).toEqual([1, 1, 1, 1, 1, 1, null]);
		expect(t.bing).toBeNull();
		expect(t.chart.bing).toBeNull();
	});

	it('draws a gap (null) before a source has data and a zero on a quiet day inside its range; no change without the previous window', () => {
		bingDay('2026-11-16', 4);
		bingDay('2026-11-18', 2); // 17th missing: Bing had no clicks that day
		const t = cardTraffic({ id: 1 }, gscOf('2026-11-18', 7), 7, { bing: { external_id: 'https://a.example/' } }, TODAY);
		expect(t.chart.bing).toEqual([null, null, null, null, 4, 0, 2]); // 12th–15th: before Bing's first stored day
		expect(t.bing).toMatchObject({ value: 6, comparable: false });
	});

	it('leaves GA4 and Bing out when the site is not linked, even if rows are stored', () => {
		ga4Day('2026-11-18', 'Direct', 9);
		bingDay('2026-11-18', 9);
		const t = cardTraffic({ id: 1 }, gscOf('2026-11-18', 7), 7, {}, TODAY);
		expect(t.ga4).toBeNull();
		expect(t.bing).toBeNull();
		expect(t.chart.dates.at(-1)).toBe('2026-11-18');
	});
});

describe('sumSource', () => {
	const t = (externalId: string, value: number, prev: number, comparable = true) => ({ externalId, value, prev, comparable, window: { start: 'a', end: 'b' } });
	it('counts a property linked to two sites once, and claims a change only when every property has its previous window', () => {
		expect(sumSource([t('p1', 10, 5), t('p1', 10, 5), t('p2', 4, 2), null])).toEqual({ value: 14, prev: 7, comparable: true, properties: 2 });
		expect(sumSource([t('p1', 10, 5), t('p2', 4, 0, false)])?.comparable).toBe(false);
		expect(sumSource([null, null])).toBeNull();
	});
});

describe('mergePages: GA4 all traffic', () => {
	const base: PageSources = { google: [], googlePrev: [], bing: null, bingPrev: null, ga4: null, ga4Prev: null, ai: null, aiPrev: null, clarity: null };
	const origin = (p: string) => 'https://site.example' + p;
	it('sums every channel per page, names the busiest channel, and adds pages only GA4 knows', () => {
		const rows = mergePages({
			...base,
			google: [{ url: 'https://site.example/a', clicks: 10, impressions: 100, position: 3 }],
			all: [
				{ page: '/a', channel: 'Organic Search', sessions: 12 },
				{ page: '/a/', channel: 'Direct', sessions: 20 },
				{ page: '/pricing', channel: 'Referral', sessions: 5 }
			],
			allPrev: [{ page: '/a', channel: 'Direct', sessions: 16 }]
		}, origin);
		const by = (p: string) => rows.find((r) => r.path === p)!;
		expect(by('/a')).toMatchObject({ tSessions: 32, tSessionsD: 1, tTop: 'Direct', gClicks: 10 });
		// stored previous window without this page: zero before, so a percentage cannot be given (never an invented +∞)
		expect(by('/pricing')).toMatchObject({ tSessions: 5, tSessionsD: null, tTop: 'Referral', gClicks: null });
	});

	it('claims no change when the previous window is not stored', () => {
		const rows = mergePages({ ...base, all: [{ page: '/a', channel: 'Direct', sessions: 3 }], allPrev: null }, origin);
		expect(rows[0]).toMatchObject({ tSessions: 3, tSessionsD: null });
	});
});
