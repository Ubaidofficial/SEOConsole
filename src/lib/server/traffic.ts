import { db } from './db';
import { addDays, eachDay, pacificToday } from './dates';
import type { LinkRow } from './links';

/**
 * Traffic beyond Search Console for the dashboard cards: GA4 sessions from every channel and Bing clicks, each over its
 * own newest window (they run on different delays), plus one shared calendar so all lines can be drawn on one chart.
 *
 * The figures are never added together: GA4's Organic Search sessions already include most Google clicks, so a "total"
 * of clicks + sessions would count the same visits twice.
 */

export interface SourceTotals {
	/** sessions (GA4) or clicks (Bing) over the source's own window */
	value: number;
	prev: number;
	/** false while the stored history does not reach the previous window, so no change can be claimed */
	comparable: boolean;
	window: { start: string; end: string };
	/** the property or Bing site, so a portfolio total counts one property linked to two sites once */
	externalId: string;
}

export interface CardTraffic {
	ga4: SourceTotals | null;
	bing: SourceTotals | null;
	chart: {
		dates: string[];
		/** null = the source has no data for that day yet (not stored, or not reported yet), drawn as a gap, never as zero */
		gsc: (number | null)[];
		ga4: (number | null)[] | null;
		bing: (number | null)[] | null;
	};
}

type Daily = { date: string; v: number }[];

/** A source's stored days, its newest day, and its first stored day. */
function load(sql: string, siteId: number, cap?: string) {
	const rows = (db().prepare(sql).all(siteId) as Daily).filter((r) => !cap || r.date <= cap);
	if (!rows.length) return null;
	return { rows, first: rows[0].date, end: rows.at(-1)!.date };
}

function totals(src: NonNullable<ReturnType<typeof load>>, days: number, externalId: string): SourceTotals {
	const start = addDays(src.end, -(days - 1));
	const prevStart = addDays(start, -days);
	const prevEnd = addDays(start, -1);
	let value = 0;
	let prev = 0;
	for (const r of src.rows) {
		if (r.date >= start && r.date <= src.end) value += r.v;
		else if (r.date >= prevStart && r.date <= prevEnd) prev += r.v;
	}
	return { value, prev, comparable: src.first <= prevStart, window: { start, end: src.end }, externalId };
}

/** One value per calendar day: null before the source's first stored day and after its newest, 0 for a quiet day inside. */
function onCalendar(dates: string[], src: { rows: Daily; first: string; end: string }): (number | null)[] {
	const by = new Map(src.rows.map((r) => [r.date, r.v]));
	return dates.map((d) => (d < src.first || d > src.end ? null : (by.get(d) ?? 0)));
}

export function cardTraffic(
	site: { id: number },
	gsc: { end: string; daily: { date: string; clicks: number }[] },
	days: number,
	links: { ga4?: Pick<LinkRow, 'external_id'>; bing?: Pick<LinkRow, 'external_id'> },
	today = pacificToday()
): CardTraffic {
	// GA4 is asked for data up to today, so its newest day can be a day still in progress; that partial day is left out
	// so the line does not dip at the end. (Days are cut on Pacific time, the same as Search Console here; a property
	// set to another time zone may lose or keep a few hours of its own day.)
	const ga4 = links.ga4 ? load('SELECT date, SUM(sessions) v FROM ga4_daily WHERE site_id = ? GROUP BY date ORDER BY date', site.id, addDays(today, -1)) : null;
	const bing = links.bing ? load('SELECT date, clicks v FROM bing_daily WHERE site_id = ? ORDER BY date', site.id) : null;

	// The chart spans `days` ending on the newest day any source has, so a source that reports later simply stops earlier.
	const end = [gsc.end, ga4?.end, bing?.end].filter((x): x is string => !!x).sort().at(-1)!;
	const dates = eachDay(addDays(end, -(days - 1)), end);
	const gscBy = new Map(gsc.daily.map((r) => [r.date, r.clicks]));
	return {
		ga4: ga4 && links.ga4 ? totals(ga4, days, links.ga4.external_id) : null,
		bing: bing && links.bing ? totals(bing, days, links.bing.external_id) : null,
		chart: {
			dates,
			// Search Console's own period is already zero-filled up to its newest synced day.
			gsc: dates.map((d) => (d > gsc.end ? null : (gscBy.get(d) ?? (gscBy.size ? 0 : null)))),
			ga4: ga4 ? onCalendar(dates, ga4) : null,
			bing: bing ? onCalendar(dates, bing) : null
		}
	};
}

/** Portfolio totals for one source: each linked property counted once; a change only when every counted property has its previous window. */
export function sumSource(items: (SourceTotals | null)[]) {
	const seen = new Map<string, SourceTotals>();
	for (const t of items) if (t && !seen.has(t.externalId)) seen.set(t.externalId, t);
	const list = [...seen.values()];
	if (!list.length) return null;
	return {
		value: list.reduce((a, t) => a + t.value, 0),
		prev: list.reduce((a, t) => a + t.prev, 0),
		comparable: list.every((t) => t.comparable),
		properties: list.length
	};
}

/** GA4's unique active and new users for a preset window length, as stored by the daily pull; null for other lengths or before the first pull. */
export function ga4UsersFor(siteId: number, days: number): { activeUsers: number; newUsers: number; window: { start: string; end: string } } | null {
	const r = db().prepare('SELECT active_users a, new_users n, start_date s, end_date e FROM ga4_users WHERE site_id = ? AND days = ?').get(siteId, days) as { a: number; n: number; s: string; e: string } | undefined;
	return r ? { activeUsers: r.a, newUsers: r.n, window: { start: r.s, end: r.e } } : null;
}

export interface PageViews {
	window: { start: string; end: string };
	views: Map<string, number>;
	/** null when the stored days do not reach back over the whole previous window: no change is claimed */
	prev: Map<string, number> | null;
	titles: Map<string, string>;
	/** the first pull hit GA4's row limit, so the oldest days are missing */
	truncated: boolean;
}

/** GA4 page views per page for `days` ending on GA4's newest complete stored day (today, still filling in, is left out). */
export function pageViewsFor(siteId: number, days: number, today = pacificToday()): PageViews | null {
	const d = db();
	const range = d.prepare('SELECT MIN(date) a, MAX(date) b FROM ga4_page_views WHERE site_id = ? AND date < ?').get(siteId, today) as { a: string | null; b: string | null };
	if (!range.b) return null;
	const end = range.b;
	const start = addDays(end, -(days - 1));
	const prevStart = addDays(start, -days);
	const sum = (s: string, e: string) => new Map((d.prepare('SELECT page, SUM(views) v FROM ga4_page_views WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY page').all(siteId, s, e) as { page: string; v: number }[]).map((r) => [r.page, r.v]));
	const titles = new Map((d.prepare('SELECT page, title FROM ga4_page_titles WHERE site_id = ?').all(siteId) as { page: string; title: string }[]).map((r) => [r.page, r.title]));
	const truncated = !!(d.prepare('SELECT ga4_views_truncated t FROM sites WHERE id = ?').get(siteId) as { t: number } | undefined)?.t;
	return { window: { start, end }, views: sum(start, end), prev: range.a! <= prevStart ? sum(prevStart, addDays(start, -1)) : null, titles, truncated };
}
