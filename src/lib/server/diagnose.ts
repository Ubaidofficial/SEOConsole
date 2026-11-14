import { db } from './db';
import type { SiteRow } from './clients';
import { addDays, addMonths } from './dates';
import { brandTerms, pageTotals, periodFor, summary, topQueries } from './queries';
import { comparability } from './insights';
import { updatesBetween } from './gupdates';
import { isBranded, type Metrics } from '../analytics';
import { diagnose, type DiagRow, type Diagnosis } from '../diagnose';

const join = <K extends 'query' | 'page'>(now: ({ clicks: number; impressions: number; position: number } & Record<K, string>)[], prev: ({ clicks: number; impressions: number; position: number } & Record<K, string>)[], key: K): DiagRow[] => {
	const m = (r: Metrics) => ({ clicks: r.clicks, impressions: r.impressions, position: r.position });
	const zero: Metrics = { clicks: 0, impressions: 0, position: 0 };
	const a = new Map(now.map((r) => [r[key], m(r)]));
	const b = new Map(prev.map((r) => [r[key], m(r)]));
	return [...new Set([...a.keys(), ...b.keys()])].map((k) => ({ key: k, now: a.get(k) ?? zero, prev: b.get(k) ?? zero }));
};

/** The oldest day of daily totals held for the site. */
const firstDay = (siteId: number) => (db().prepare('SELECT MIN(date) d FROM site_daily WHERE site_id = ?').get(siteId) as { d: string | null }).d;

/** Pages seen dropping out of Google's index between two days (null when the indexing monitor has never run for the site). */
function deindexedBetween(siteId: number, start: string, end: string): number | null {
	const any = db().prepare('SELECT 1 FROM index_history WHERE site_id = ? LIMIT 1').get(siteId);
	if (!any) return null;
	const from = Date.parse(start + 'T00:00:00Z');
	const to = Date.parse(end + 'T23:59:59Z');
	return (db().prepare("SELECT COUNT(DISTINCT url) n FROM index_events WHERE site_id = ? AND kind = 'deindexed' AND at BETWEEN ? AND ?").get(siteId, from, to) as { n: number }).n;
}

export interface SiteDiagnosis extends Diagnosis { site: number; days: number; period: { start: string; end: string; prevStart: string; prevEnd: string }; note: string | null }

/** The drop diagnosis for one site over `days` against the equally long period before it, from stored data only (no calls to Google). */
export function diagnoseSite(site: SiteRow, days = 28): SiteDiagnosis {
	const p = periodFor(site, days);
	const cmp = comparability(site, p);
	const terms = brandTerms(site);
	const totals = { now: summary(site.id, p.start, p.end), prev: summary(site.id, p.prevStart, p.prevEnd) };
	const queries = cmp.comparable ? join(topQueries(site.id, p.start, p.end, {}, 50_000), topQueries(site.id, p.prevStart, p.prevEnd, {}, 50_000), 'query') : [];
	const pages = cmp.comparable ? join(pageTotals(site.id, p.start, p.end), pageTotals(site.id, p.prevStart, p.prevEnd), 'page') : [];
	const first = firstDay(site.id);
	const yaPrevStart = addMonths(p.prevStart, -12);
	const yearAgo = first && first <= yaPrevStart ? { now: summary(site.id, addMonths(p.start, -12), addMonths(p.end, -12)), prev: summary(site.id, yaPrevStart, addMonths(p.prevEnd, -12)) } : null;
	const updates = updatesBetween(p.prevStart, p.end).filter((u) => u.kind === 'core' || u.kind === 'spam');
	const d = diagnose({
		totals, queries, pages, yearAgo,
		updates: updates.map((u) => ({ name: u.name, begin: u.begin, end: u.end })),
		windowEnd: p.end, comparable: cmp.comparable,
		deindexed: deindexedBetween(site.id, p.start, p.end),
		isBrand: (q) => isBranded(q, terms)
	});
	return { ...d, site: site.id, days, period: { start: p.start, end: p.end, prevStart: p.prevStart, prevEnd: p.prevEnd }, note: cmp.reason };
}
