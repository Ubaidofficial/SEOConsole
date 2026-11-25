import { db } from './db';
import { addDays } from './dates';
import { siteEnd, summary } from './queries';
import { normalizeUrl } from '../analytics';
import type { ActionItem } from '../actions';
import type { SiteRow } from './clients';

/**
 * Did it work? When a finding is marked done, its clicks over the 28 days up to that day are stored; once 28 more days of data
 * have arrived, the same measure is read again and compared with the rest of the site over the same two windows, so a site-wide
 * rise or fall (a Google update, a season) is not credited to the fix. Findings about a page or a search are measured on that
 * page or search; the others (sitemaps, tracking, robots.txt...) on the whole site, with no control, and are also judged by
 * whether the problem is still detected. Observational: "improved" means "more than the rest of the site, beyond noise", not proof
 * that the fix caused it.
 */
export const OUTCOME_DAYS = 28;
/** Below this many clicks in the two windows together nothing can be told. */
export const MIN_CLICKS = 20;
/** A type's learned weight is used only once it has this many measured outcomes. */
export const MIN_MEASURED = 8;

export type ScopeKind = 'page' | 'query' | 'site';
export interface Scope { kind: ScopeKind; value: string | null }
export type Verdict = 'improved' | 'worse' | 'no-clear-change' | 'too-little-data';

/** What a finding is about, from its key: the page or search it names, or the whole site. */
export function scopeOfKey(key: string): Scope {
	const after = (p: string) => key.slice(p.length);
	if (key.startsWith('ctr:')) return { kind: 'page', value: key.slice(key.indexOf('|') + 1) || null };
	for (const p of ['dead:', 'decay:', 'hidden:edge:', 'hidden:gem:', 'links:']) if (key.startsWith(p)) return { kind: 'page', value: after(p) };
	for (const p of ['striking:', 'cannibal:']) if (key.startsWith(p)) return { kind: 'query', value: after(p) };
	return { kind: 'site', value: null };
}

/** Clicks and impressions of a scope over [start, end]. Pages are matched as normalizeUrl does (www, http(s) and a trailing slash count as one). */
export function scopeClicks(siteId: number, scope: Scope, start: string, end: string): { clicks: number; impressions: number } {
	const d = db();
	if (scope.kind === 'site' || !scope.value) {
		const m = summary(siteId, start, end);
		return { clicks: m.clicks, impressions: m.impressions };
	}
	if (scope.kind === 'query') {
		const r = d.prepare('SELECT SUM(clicks) c, SUM(impressions) i FROM sa_rows WHERE site_id = ? AND query = ? AND date BETWEEN ? AND ?').get(siteId, scope.value, start, end) as { c: number | null; i: number | null };
		return { clicks: r.c ?? 0, impressions: r.i ?? 0 };
	}
	const rows = d.prepare('SELECT page, SUM(clicks) c, SUM(impressions) i FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY page').all(siteId, start, end) as { page: string; c: number; i: number }[];
	let clicks = 0, impressions = 0;
	for (const r of rows) if (normalizeUrl(r.page) === scope.value) (clicks += r.c), (impressions += r.i);
	return { clicks, impressions };
}

/** The verdict from the two windows. `expected` is what the scope would have had if it moved like the rest of the site. */
export function judge(before: number, after: number, siteBefore: number, siteAfter: number, kind: ScopeKind): { expected: number; lift: number | null; verdict: Verdict } {
	let expected = before;
	if (kind !== 'site') {
		const ctrlBefore = siteBefore - before, ctrlAfter = siteAfter - after;
		if (ctrlBefore >= MIN_CLICKS && ctrlAfter >= 0) expected = before * (ctrlAfter / ctrlBefore);
	}
	const lift = expected > 0 ? after / expected - 1 : null;
	if (before + after < MIN_CLICKS) return { expected, lift, verdict: 'too-little-data' };
	// Poisson z against the expectation, plus a floor of 5 clicks and 10%: real traffic scatters more than Poisson says.
	const z = (after - expected) / Math.sqrt(Math.max(expected, 1));
	const big = Math.abs(after - expected) >= Math.max(5, 0.1 * expected);
	const verdict: Verdict = z >= 2 && big ? 'improved' : z <= -2 && big ? 'worse' : 'no-clear-change';
	return { expected, lift, verdict };
}

/** Called when a finding is marked done: store its baseline. Marking it done again the same data day changes nothing. */
export function recordDone(site: Pick<SiteRow, 'id' | 'synced_through'>, key: string, item: Pick<ActionItem, 'type' | 'title' | 'impact' | 'confidence'> | undefined, now = Date.now()) {
	const day0 = siteEnd(site);
	const scope = scopeOfKey(key);
	const start = addDays(day0, -(OUTCOME_DAYS - 1));
	const s = scopeClicks(site.id, scope, start, day0);
	const all = scopeClicks(site.id, { kind: 'site', value: null }, start, day0);
	const type = item?.type ?? key.split(':')[0];
	db()
		.prepare(
			`INSERT OR IGNORE INTO action_outcomes (site_id, key, type, title, impact, confidence, scope_kind, scope_value, done_at, day0, before_clicks, site_before)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
		)
		.run(site.id, key, type, (item?.title ?? key).slice(0, 300), item?.impact ?? null, item?.confidence ?? null, scope.kind, scope.value, now, day0, s.clicks, all.clicks);
}

/** Back in the queue before it was measured: forget the pending measurement. */
export const forgetPending = (siteId: number, key: string) => void db().prepare('DELETE FROM action_outcomes WHERE site_id = ? AND key = ? AND verdict IS NULL').run(siteId, key);

/** Measure every pending outcome of a site whose 28 days after are now in the data. `detected` = keys the site's queue still finds. */
export function evaluateOutcomes(site: Pick<SiteRow, 'id' | 'synced_through'>, detected: Set<string>, now = Date.now()): number {
	const d = db();
	const end = siteEnd(site);
	const pending = d.prepare('SELECT id, key, scope_kind, scope_value, day0, before_clicks, site_before FROM action_outcomes WHERE site_id = ? AND verdict IS NULL').all(site.id) as {
		id: number; key: string; scope_kind: ScopeKind; scope_value: string | null; day0: string; before_clicks: number; site_before: number;
	}[];
	const upd = d.prepare('UPDATE action_outcomes SET after_clicks = ?, site_after = ?, expected = ?, lift = ?, verdict = ?, still_detected = ?, evaluated_at = ? WHERE id = ?');
	let n = 0;
	for (const p of pending) {
		const afterEnd = addDays(p.day0, OUTCOME_DAYS);
		if (afterEnd > end) continue;
		const scope = { kind: p.scope_kind, value: p.scope_value };
		const a = scopeClicks(site.id, scope, addDays(p.day0, 1), afterEnd);
		const all = scopeClicks(site.id, { kind: 'site', value: null }, addDays(p.day0, 1), afterEnd);
		const j = judge(p.before_clicks, a.clicks, p.site_before, all.clicks, p.scope_kind);
		upd.run(a.clicks, all.clicks, j.expected, j.lift, j.verdict, detected.has(p.key) ? 1 : 0, now, p.id);
		n++;
	}
	return n;
}

export interface OutcomeRow {
	siteId: number; key: string; type: string; title: string; scope: ScopeKind; target: string | null; doneOn: string; measuredThrough: string;
	clicksBefore: number; clicksAfter: number | null; expectedAfter: number | null; liftVsRestOfSite: number | null; verdict: Verdict | 'pending'; stillDetected: boolean | null; estimatedClicksPer28Days: number | null;
}

export function listOutcomes(siteIds: number[], limit = 50): OutcomeRow[] {
	if (!siteIds.length) return [];
	const rows = db()
		.prepare(`SELECT * FROM action_outcomes WHERE site_id IN (${siteIds.map(() => '?').join(',')}) ORDER BY done_at DESC LIMIT ?`)
		.all(...siteIds, limit) as Record<string, unknown>[];
	return rows.map((r) => ({
		siteId: r.site_id as number,
		key: r.key as string,
		type: r.type as string,
		title: r.title as string,
		scope: r.scope_kind as ScopeKind,
		target: (r.scope_value as string | null) ?? null,
		doneOn: r.day0 as string,
		measuredThrough: addDays(r.day0 as string, OUTCOME_DAYS),
		clicksBefore: r.before_clicks as number,
		clicksAfter: (r.after_clicks as number | null) ?? null,
		expectedAfter: r.expected == null ? null : Math.round(r.expected as number),
		liftVsRestOfSite: r.lift == null ? null : Math.round((r.lift as number) * 1000) / 1000,
		verdict: ((r.verdict as Verdict | null) ?? 'pending') as OutcomeRow['verdict'],
		stillDetected: r.still_detected == null ? null : !!r.still_detected,
		estimatedClicksPer28Days: r.impact == null ? null : Math.round(r.impact as number)
	}));
}

export interface TypeStats { type: string; measured: number; improved: number; worse: number; noClearChange: number; tooLittleData: number; resolved: number; pending: number }

/** Per finding type: how the fixes went, across the given sites (or all). */
export function outcomeStats(siteIds?: number[]): TypeStats[] {
	const where = siteIds ? (siteIds.length ? `WHERE site_id IN (${siteIds.map(() => '?').join(',')})` : 'WHERE 0') : '';
	const rows = db()
		.prepare(
			`SELECT type, SUM(verdict IN ('improved','worse','no-clear-change')) measured, SUM(verdict = 'improved') improved, SUM(verdict = 'worse') worse,
			   SUM(verdict = 'no-clear-change') ncc, SUM(verdict = 'too-little-data') tld, SUM(verdict IS NOT NULL AND still_detected = 0) resolved, SUM(verdict IS NULL) pending
			 FROM action_outcomes ${where} GROUP BY type ORDER BY type`
		)
		.all(...(siteIds ?? [])) as { type: string; measured: number; improved: number; worse: number; ncc: number; tld: number; resolved: number; pending: number }[];
	return rows.map((r) => ({ type: r.type, measured: r.measured ?? 0, improved: r.improved ?? 0, worse: r.worse ?? 0, noClearChange: r.ncc ?? 0, tooLittleData: r.tld ?? 0, resolved: r.resolved ?? 0, pending: r.pending ?? 0 }));
}

/**
 * Learned weights per finding type for the to-do list's order: a type whose fixes beat the rest of the site more often than the
 * average type moves up, one that rarely does moves down. Only types with MIN_MEASURED measured outcomes get one, and the weight
 * stays within 0.6-1.4, so a handful of results cannot reorder the list. Shrunk towards the average (one improved and one
 * not, added to each type) because the counts are small.
 */
export function learnedWeights(stats: TypeStats[] = outcomeStats()): Record<string, number> {
	const usable = stats.filter((s) => s.measured >= MIN_MEASURED);
	if (!usable.length) return {};
	const total = stats.reduce((a, s) => a + s.measured, 0);
	const overall = (stats.reduce((a, s) => a + s.improved, 0) + 1) / (total + 2);
	const out: Record<string, number> = {};
	for (const s of usable) out[s.type] = Math.round(Math.min(1.4, Math.max(0.6, (s.improved + 1) / (s.measured + 2) / overall)) * 100) / 100;
	return out;
}
