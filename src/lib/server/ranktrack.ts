import { db, audit } from './db';
import type { SiteRow } from './clients';
import { addDays } from './dates';
import { periodFor, siteEnd } from './queries';

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
}

export function rankReport(site: Pick<SiteRow, 'id' | 'synced_through'>, days: number): { rows: RankRow[]; start: string; end: string } {
	const tracked = listTracked(site.id);
	const end = siteEnd(site);
	const p = periodFor(site, days);
	// the series covers the period, and at least the last 14 days so the week-on-week change can always be worked out
	const start = p.start < addDays(end, -13) ? p.start : addDays(end, -13);
	const series = rankSeries(site.id, tracked.map((t) => t.query), start, end);
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
			addedAt
		};
	});
	return { rows, start: p.start, end };
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
