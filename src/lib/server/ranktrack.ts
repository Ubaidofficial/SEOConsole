import { db, audit } from './db';
import type { SiteRow } from './clients';
import { addDays } from './dates';
import { periodFor, siteEnd } from './queries';
import { bucketTracked } from './groups';
import { POSITION_BUCKETS } from '../plan';

/**
 * Rank tracking from Search Console's own data: the daily average Google position of the searches you choose, across every country
 * and device (weighted by impressions, as Search Console averages it). No credits and no scraping: a day with no impression for the
 * search has no position, rather than a guessed one. A rank tracker that checks results pages (OpenSEO) measures one location and
 * device; this measures what searchers actually saw.
 */
export const MAX_ADD_AT_ONCE = 100;
export const MAX_TRACKED = 500;

/** A search as Search Console reports it: lower case, single spaces. */
export const normQuery = (q: string) => q.toLowerCase().replace(/\s+/g, ' ').trim();

export function listTracked(siteId: number): { query: string; addedAt: number }[] {
	return db().prepare('SELECT query, added_at addedAt FROM tracked_queries WHERE site_id = ? ORDER BY query').all(siteId) as { query: string; addedAt: number }[];
}

export function trackQueries(siteId: number, raw: string[]): { added: number; already: number; error?: string } {
	const qs = [...new Set(raw.map(normQuery).filter((q) => q && q.length <= 300))];
	if (!qs.length) return { added: 0, already: 0, error: 'No searches given.' };
	if (qs.length > MAX_ADD_AT_ONCE) return { added: 0, already: 0, error: `Up to ${MAX_ADD_AT_ONCE} searches at a time.` };
	const d = db();
	const have = new Set(listTracked(siteId).map((t) => t.query));
	const fresh = qs.filter((q) => !have.has(q));
	if (have.size + fresh.length > MAX_TRACKED) return { added: 0, already: qs.length - fresh.length, error: `A site can track up to ${MAX_TRACKED} searches; ${have.size} are tracked now.` };
	const ins = d.prepare('INSERT OR IGNORE INTO tracked_queries (site_id, query, added_at) VALUES (?,?,?)');
	d.transaction(() => { for (const q of fresh) ins.run(siteId, q, Date.now()); })();
	if (fresh.length) audit('rank tracking: searches added', { siteId, detail: String(fresh.length) });
	return { added: fresh.length, already: qs.length - fresh.length };
}

export function untrackQueries(siteId: number, raw: string[]): number {
	const del = db().prepare('DELETE FROM tracked_queries WHERE site_id = ? AND query = ?');
	let n = 0;
	db().transaction(() => { for (const q of raw.map(normQuery)) n += del.run(siteId, q).changes; })();
	return n;
}

export interface RankDay { date: string; position: number | null; clicks: number; impressions: number }

/** Daily position of each search from `start` to `end`, every day present (null = no impression that day). */
export function rankSeries(siteId: number, queries: string[], start: string, end: string): Map<string, RankDay[]> {
	const out = new Map<string, RankDay[]>();
	if (!queries.length) return out;
	const days: string[] = [];
	for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
	const found = new Map<string, Map<string, { c: number; i: number; pw: number }>>();
	for (let i = 0; i < queries.length; i += 400) {
		const chunk = queries.slice(i, i + 400);
		const rows = db()
			.prepare(`SELECT query q, date, SUM(clicks) c, SUM(impressions) i, SUM(position * impressions) pw FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? AND query IN (${chunk.map(() => '?').join(',')}) GROUP BY query, date`)
			.all(siteId, start, end, ...chunk) as { q: string; date: string; c: number; i: number; pw: number }[];
		for (const r of rows) {
			let m = found.get(r.q);
			if (!m) found.set(r.q, (m = new Map()));
			m.set(r.date, r);
		}
	}
	for (const q of queries) {
		const m = found.get(q);
		out.set(q, days.map((date) => {
			const r = m?.get(date);
			return { date, position: r && r.i ? r.pw / r.i : null, clicks: r?.c ?? 0, impressions: r?.i ?? 0 };
		}));
	}
	return out;
}

const avgPos = (xs: RankDay[]) => {
	let i = 0, pw = 0;
	for (const x of xs) if (x.position != null) (i += x.impressions, pw += x.position * x.impressions);
	return i ? pw / i : null;
};

export interface RankRow {
	query: string;
	/** the newest day with an impression, and its position */
	latest: { date: string; position: number } | null;
	/** average over the last 7 days, and the 7 before */
	week: number | null;
	prevWeek: number | null;
	/** positive = better (moved up) */
	change: number | null;
	best: number | null;
	clicks: number;
	impressions: number;
	daysTop10: number;
	daysShown: number;
	/** daily positions over the chosen period, for the sparkline */
	series: (number | null)[];
	addedAt: number;
	/** added by hand (can be removed here), or followed because it is one of a bucket's biggest searches */
	manual: boolean;
	buckets: string[];
	/** the page that earned this search the most clicks in the period (most impressions when none had a click) */
	landing: string | null;
}

/** The tracked searches as a whole, this week (the last 7 days) against the 7 before. */
export interface RankSummary {
	tracked: number;
	/** the average of each search's position this week, over the searches shown this week */
	position: number | null;
	/** the average of each search's move against the week before, over the searches shown in both weeks; positive = better (moved up) */
	change: number | null;
	/** searches whose position this week is in the top 3, and the same count for the week before */
	top3: number;
	top3Prev: number;
}

/** How many tracked searches sat in each position band on one day: Top 3, 4–10, 11–20, 21+ (as POSITION_BUCKETS) and not shown. */
export interface RankBandDay { date: string; bands: [number, number, number, number]; none: number }

export interface RankReport {
	rows: RankRow[];
	start: string;
	end: string;
	summary: RankSummary;
	bands: RankBandDay[];
	/** tracked searches per keyword bucket that follows them, biggest first, and how many were added by hand */
	bucketCounts: { name: string; count: number }[];
	manualCount: number;
}

/** The page with the most clicks (then impressions) for each search between `start` and `end`. */
export function landingPages(siteId: number, queries: string[], start: string, end: string): Map<string, string> {
	const best = new Map<string, { page: string; c: number; i: number }>();
	for (let i = 0; i < queries.length; i += 400) {
		const chunk = queries.slice(i, i + 400);
		const rows = db()
			.prepare(`SELECT query q, page, SUM(clicks) c, SUM(impressions) i FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? AND query IN (${chunk.map(() => '?').join(',')}) GROUP BY query, page`)
			.all(siteId, start, end, ...chunk) as { q: string; page: string; c: number; i: number }[];
		for (const r of rows) {
			const b = best.get(r.q);
			if (!b || r.c > b.c || (r.c === b.c && (r.i > b.i || (r.i === b.i && r.page < b.page)))) best.set(r.q, { page: r.page, c: r.c, i: r.i });
		}
	}
	return new Map([...best].filter(([, b]) => b.c > 0 || b.i > 0).map(([q, b]) => [q, b.page]));
}

const TOP3 = POSITION_BUCKETS[0].max;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);

export function summarise(rows: Pick<RankRow, 'week' | 'prevWeek' | 'change'>[]): RankSummary {
	return {
		tracked: rows.length,
		position: mean(rows.flatMap((r) => (r.week == null ? [] : [r.week]))),
		change: mean(rows.flatMap((r) => (r.change == null ? [] : [r.change]))),
		top3: rows.filter((r) => r.week != null && r.week <= TOP3).length,
		top3Prev: rows.filter((r) => r.prevWeek != null && r.prevWeek <= TOP3).length
	};
}

export function rankReport(site: Pick<SiteRow, 'id' | 'synced_through'>, days: number): RankReport {
	const manual = listTracked(site.id);
	const fromBuckets = bucketTracked(site);
	const have = new Set(manual.map((t) => t.query));
	const tracked = [...manual, ...[...fromBuckets.keys()].filter((q) => !have.has(q)).map((query) => ({ query, addedAt: 0 }))];
	const end = siteEnd(site);
	const p = periodFor(site, days);
	// the series covers the period, and at least the last 14 days so the week-on-week change can always be worked out
	const start = p.start < addDays(end, -13) ? p.start : addDays(end, -13);
	const series = rankSeries(site.id, tracked.map((t) => t.query), start, end);
	const landing = landingPages(site.id, tracked.map((t) => t.query), p.start, end);
	const rows = tracked.map(({ query, addedAt }): RankRow => {
		const s = series.get(query) ?? [];
		const inPeriod = s.filter((x) => x.date >= p.start);
		const last = [...s].reverse().find((x) => x.position != null);
		const week = avgPos(s.slice(-7));
		const prevWeek = avgPos(s.slice(-14, -7));
		const shown = inPeriod.filter((x) => x.position != null);
		return {
			query,
			latest: last ? { date: last.date, position: last.position! } : null,
			week, prevWeek,
			change: week != null && prevWeek != null ? prevWeek - week : null,
			best: shown.length ? Math.min(...shown.map((x) => x.position!)) : null,
			clicks: inPeriod.reduce((a, x) => a + x.clicks, 0),
			impressions: inPeriod.reduce((a, x) => a + x.impressions, 0),
			daysTop10: shown.filter((x) => x.position! <= 10.5).length,
			daysShown: shown.length,
			series: inPeriod.map((x) => x.position),
			addedAt,
			manual: have.has(query),
			buckets: fromBuckets.get(query) ?? [],
			landing: landing.get(query) ?? null
		};
	});
	// one pass over the daily positions already loaded: every tracked search lands in exactly one band (or "not shown") each day
	const dates: string[] = [];
	for (let d = p.start; d <= end; d = addDays(d, 1)) dates.push(d);
	const bands: RankBandDay[] = dates.map((date) => ({ date, bands: [0, 0, 0, 0], none: 0 }));
	for (const r of rows) {
		r.series.forEach((x, i) => {
			const b = bands[i];
			if (!b) return;
			if (x == null) b.none++;
			else b.bands[Math.max(0, POSITION_BUCKETS.findIndex((k) => x <= k.max))]++;
		});
	}
	const per = new Map<string, number>();
	for (const r of rows) for (const b of r.buckets) per.set(b, (per.get(b) ?? 0) + 1);
	return {
		rows,
		start: p.start,
		end,
		summary: summarise(rows),
		bands,
		bucketCounts: [...per].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
		manualCount: rows.filter((r) => r.manual).length
	};
}

/** Searches worth tracking that are not tracked yet: the biggest by impressions on page one or two in the last 28 days. */
export function trackSuggestions(site: Pick<SiteRow, 'id' | 'synced_through'>, limit = 20): { query: string; impressions: number; position: number }[] {
	const p = periodFor(site, 28);
	const have = new Set(listTracked(site.id).map((t) => t.query));
	const rows = db()
		.prepare('SELECT query, SUM(impressions) impressions, SUM(position * impressions) / SUM(impressions) position FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY query HAVING SUM(impressions) > 0 ORDER BY impressions DESC LIMIT ?')
		.all(site.id, p.start, p.end, limit * 4) as { query: string; impressions: number; position: number }[];
	return rows.filter((r) => !have.has(r.query) && r.position <= 20.5).slice(0, limit);
}
