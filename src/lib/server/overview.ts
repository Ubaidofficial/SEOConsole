import { db } from './db';
import type { SiteRow } from './clients';
import { breakdown, brandTerms, historyCoversPrevious, topPages, topQueries } from './queries';
import { eachDay, type Period } from './dates';
import { isBranded } from '../analytics';
import { groupHistory, groupsReportFor } from './groups';

/**
 * The panels under the plan on a site's Overview tab: the biggest searches and pages with their daily line and their change, new and
 * lost searches by day, clicks by device, brand against non-brand by day, and the team's keyword buckets. Everything is read from
 * stored Search Console rows for the period on screen; "previous" is the period of the same length before it.
 */

export interface MoverRow { key: string; clicks: number; prev: number | null; change: number | null; impressions: number; position: number; spark: number[] }
export interface Movers { all: MoverRow[]; rising: MoverRow[]; falling: MoverRow[]; comparable: boolean }

/** Daily clicks of a few searches or pages over the period, one array per key, every day present. */
export function sparks(siteId: number, dim: 'query' | 'page', keys: string[], p: Period): Map<string, number[]> {
	const days = eachDay(p.start, p.end);
	const at = new Map(days.map((d, i) => [d, i]));
	const out = new Map(keys.map((k) => [k, days.map(() => 0)]));
	if (!keys.length) return out;
	const rows = db().prepare(`SELECT ${dim} k, date, SUM(clicks) c FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? AND ${dim} IN (${keys.map(() => '?').join(',')}) GROUP BY ${dim}, date`).all(siteId, p.start, p.end, ...keys) as { k: string; date: string; c: number }[];
	for (const r of rows) {
		const i = at.get(r.date);
		if (i !== undefined) out.get(r.k)![i] = r.c;
	}
	return out;
}

export function movers(site: SiteRow, p: Period, dim: 'query' | 'page', limit = 8): Movers {
	const comparable = historyCoversPrevious(site, p.prevStart);
	const read = (start: string, end: string) => (dim === 'query' ? topQueries(site.id, start, end, {}, 20_000).map((r) => ({ key: r.query, ...r })) : topPages(site.id, start, end, {}, 20_000).map((r) => ({ key: r.page, ...r })));
	const now = read(p.start, p.end);
	const before = comparable ? new Map(read(p.prevStart, p.prevEnd).map((r) => [r.key, r.clicks])) : null;
	const rows = now.map((r) => {
		const prev = before ? (before.get(r.key) ?? 0) : null;
		return { key: r.key, clicks: r.clicks, prev, change: prev == null ? null : r.clicks - prev, impressions: r.impressions, position: r.position };
	});
	const all = rows.slice(0, limit);
	const rising = comparable ? [...rows].filter((r) => (r.change ?? 0) > 0).sort((a, b) => b.change! - a.change!).slice(0, limit) : [];
	// falling includes what earned clicks before and none now (it is not in this period's rows at all)
	let falling: typeof rows = [];
	if (comparable && before) {
		const inNow = new Set(rows.map((r) => r.key));
		const gone = [...before].filter(([k, c]) => !inNow.has(k) && c > 0).map(([k, c]) => ({ key: k, clicks: 0, prev: c, change: -c, impressions: 0, position: 0 }));
		falling = [...rows.filter((r) => (r.change ?? 0) < 0), ...gone].sort((a, b) => a.change! - b.change!).slice(0, limit);
	}
	const s = sparks(site.id, dim, [...new Set([...all, ...rising, ...falling].map((r) => r.key))], p);
	const withSpark = (xs: typeof rows): MoverRow[] => xs.map((r) => ({ ...r, spark: s.get(r.key) ?? [] }));
	return { all: withSpark(all), rising: withSpark(rising), falling: withSpark(falling), comparable };
}

/**
 * Searches that started getting impressions in this period (none in the period before), counted on the day each first appeared,
 * and searches that stopped (impressions before, none now), counted on the day each was last seen. Needs the previous period stored.
 */
export function newAndLost(site: SiteRow, p: Period, limit = 5) {
	if (!historyCoversPrevious(site, p.prevStart)) return null;
	const d = db();
	const first = d.prepare('SELECT query, MIN(date) first, SUM(impressions) impressions, SUM(clicks) clicks, SUM(position * impressions) / SUM(impressions) position FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY query HAVING SUM(impressions) > 0').all(site.id, p.start, p.end) as { query: string; first: string; impressions: number; clicks: number; position: number }[];
	const last = d.prepare('SELECT query, MAX(date) last, SUM(impressions) impressions, SUM(clicks) clicks, SUM(position * impressions) / SUM(impressions) position FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY query HAVING SUM(impressions) > 0').all(site.id, p.prevStart, p.prevEnd) as { query: string; last: string; impressions: number; clicks: number; position: number }[];
	const before = new Set(last.map((r) => r.query));
	const now = new Set(first.map((r) => r.query));
	const added = first.filter((r) => !before.has(r.query));
	const lost = last.filter((r) => !now.has(r.query));
	const hist = (dates: string[], from: string, to: string) => {
		const days = eachDay(from, to);
		const at = new Map(days.map((x, i) => [x, i]));
		const counts = days.map(() => 0);
		for (const x of dates) if (at.has(x)) counts[at.get(x)!]++;
		return { days, counts };
	};
	return {
		added: { count: added.length, top10: added.filter((r) => r.position <= 10.5).length, byDay: hist(added.map((r) => r.first), p.start, p.end), top: [...added].sort((a, b) => b.impressions - a.impressions).slice(0, limit).map((r) => ({ query: r.query, date: r.first, impressions: r.impressions, position: r.position })) },
		lost: { count: lost.length, top10: lost.filter((r) => r.position <= 10.5).length, clicks: lost.reduce((a, r) => a + r.clicks, 0), byDay: hist(lost.map((r) => r.last), p.prevStart, p.prevEnd), top: [...lost].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, limit).map((r) => ({ query: r.query, date: r.last, clicks: r.clicks, position: r.position })) }
	};
}

/** Clicks and impressions by device, now and (when stored) in the period before. */
export function devices(site: SiteRow, p: Period) {
	const now = breakdown(site.id, p.start, p.end, 'device');
	const prev = historyCoversPrevious(site, p.prevStart) ? new Map(breakdown(site.id, p.prevStart, p.prevEnd, 'device').map((r) => [r.key, r.clicks])) : null;
	return now.map((r) => ({ device: r.key, clicks: r.clicks, impressions: r.impressions, prev: prev ? (prev.get(r.key) ?? 0) : null }));
}

/** Brand and non-brand clicks per day over the period (only searches Google lists; anonymised ones cannot be classed). */
export function brandByDay(site: SiteRow, p: Period): { date: string; brand: number; other: number }[] | null {
	const terms = brandTerms(site);
	if (!terms.length) return null;
	const days = eachDay(p.start, p.end);
	const at = new Map(days.map((x, i) => [x, i]));
	const out = days.map((date) => ({ date, brand: 0, other: 0 }));
	const memo = new Map<string, boolean>();
	for (const r of db().prepare('SELECT date, query, SUM(clicks) c FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? AND clicks > 0 GROUP BY date, query').iterate(site.id, p.start, p.end) as Iterable<{ date: string; query: string; c: number }>) {
		let b = memo.get(r.query);
		if (b === undefined) memo.set(r.query, (b = isBranded(r.query, terms)));
		const i = at.get(r.date);
		if (i !== undefined) b ? (out[i].brand += r.c) : (out[i].other += r.c);
	}
	return out;
}

/** The team's keyword buckets with their totals, change and daily clicks (at most 8, biggest first). */
export function bucketPanel(site: SiteRow, p: Period, days: number) {
	const r = groupsReportFor(site, 'bucket', days);
	const rows = r.rows.filter((x) => x.id != null).sort((a, b) => b.clicks - a.clicks).slice(0, 8);
	const daysList = eachDay(p.start, p.end);
	return {
		comparable: r.comparable,
		count: r.groups.length,
		rows: rows.map((x) => {
			const h = new Map(groupHistory(site, 'bucket', x.id!, p.start, p.end).map((d) => [d.date, d.clicks]));
			return { id: x.id!, name: x.name, clicks: x.clicks, impressions: x.impressions, deltaPct: x.deltaPct, members: x.members, spark: daysList.map((d) => h.get(d) ?? 0) };
		})
	};
}
