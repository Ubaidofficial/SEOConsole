/**
 * Three analyses that need OpenSEO's paid data, run from here only when someone asks and only after a preview of what will be asked:
 *  - SERP format check: put your best-ranking searches' results pages next to your page (src/lib/serpformat.ts),
 *  - competitor gap: who beats you for the searches you appear for, and which of their keywords you have no page for (src/lib/gap.ts),
 *  - backlink reclaim: links to pages of yours that no longer work (src/lib/reclaim.ts).
 *
 * All three go through OpenSEO's MCP server with the API key saved on the Connect page (get_serp_results, find_serp_competitors,
 * get_ranked_keywords, get_backlinks_profile). Their answer shapes were read from a live self-hosted instance on 2026-11-14, one small call
 * each. Prices are OpenSEO's: it states about 5 credits a keyword for a SERP lookup (at depth 20) and about 30 credits a page of backlinks; for the
 * two competitor tools it states only "charges credits", so the preview says the price is not stated instead of inventing one. Results are
 * stored (newest per kind), so reading them again is free; they are read-only through MCP (`get_research_findings`), which never spends credits.
 */
import { bingDeadPages } from './binglinks';
import { db, audit } from './db';
import { config } from './config';
import { getSite, type SiteRow } from './clients';
import { hostKey } from './hosts';
import { brandTerms, fittedCurve, periodFor, queryPageRows } from './queries';
import { openSeoFor, type OseoApi } from './openseolink';
import { crawledLinkPages } from './internallinks';
import { nicheFor } from './nichefit';
import { ctrAtPosition, isBranded, normalizeUrl } from '../analytics';
import { checkSerp, parseSerp, serpCredits, type SerpCheck } from '../serpformat';
import { computeGap, parseCompetitors, parseRanked, studyList, type Competitor, type GapRow } from '../gap';
import { linkProfile, parseBacklinks, reclaimPlan, type Backlink, type LinkProfile, type ReclaimRow } from '../reclaim';
import { scoreKeywords } from '../nichefit';

export type ResearchKind = 'serp' | 'gap' | 'backlinks';
export const SERP_DEPTH = 10;
export const SERP_BATCH = 10;
export const SERP_MAX = 30;
export const GAP_KEYWORDS_MAX = 50;
export const GAP_STUDY = 3;
export const BACKLINK_ROWS = 200;

const message = (e: unknown) => (e instanceof Error ? e.message : 'OpenSEO failed.');
const needOpenSeo = (siteId: number, o: { api?: OseoApi }) => {
	if (config.readOnly) throw new Error('READ_ONLY=1: asking OpenSEO for paid data is disabled.');
	const os = openSeoFor(siteId, o);
	if (!os) throw new Error('This site is not linked to an OpenSEO project (Connect page).');
	return os;
};

/**
 * Each analysis spends OpenSEO credits, so the same one cannot be started again for the same site within this long (a double click, a
 * loop in a script). The claim is made before the call and handed back if the call fails, so a provider error does not lock you out.
 * `force` exists for tests; no button or tool passes it.
 */
export const RUN_COOLDOWN_MS = 30 * 60_000;
function claim(siteId: number, kind: ResearchKind, o: { force?: boolean; now?: number }): () => void {
	const key = `research-run:${kind}:${siteId}`;
	const now = o.now ?? Date.now();
	const last = Number((db().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? 0);
	const elapsed = now - last;
	// A stamp from the future (the clock was stepped back) is not a reason to block for hours.
	if (!o.force && elapsed >= 0 && elapsed < RUN_COOLDOWN_MS) {
		const mins = Math.max(1, Math.ceil((RUN_COOLDOWN_MS - elapsed) / 60_000));
		throw new Error(`This was run ${Math.floor(elapsed / 60_000)} minutes ago and every run spends OpenSEO credits. The stored result is below; try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
	}
	db().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(now));
	return () => void db().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(last));
}

// ── storage ──────────────────────────────────────────────────────────────────
export interface Stored<T> { fetchedAt: number; credits: number | null; data: T }
export function storedResearch<T>(siteId: number, kind: ResearchKind): Stored<T> | null {
	const r = db().prepare('SELECT fetched_at, credits, payload FROM oseo_research WHERE site_id = ? AND kind = ?').get(siteId, kind) as { fetched_at: number; credits: number | null; payload: string } | undefined;
	return r ? { fetchedAt: r.fetched_at, credits: r.credits, data: JSON.parse(r.payload) as T } : null;
}
const keep = (siteId: number, kind: ResearchKind, credits: number | null, data: unknown) =>
	void db().prepare('INSERT OR REPLACE INTO oseo_research (site_id, kind, fetched_at, credits, payload) VALUES (?,?,?,?,?)').run(siteId, kind, Date.now(), credits, JSON.stringify(data));

// ── 1. SERP format check ─────────────────────────────────────────────────────
export interface SerpCandidate { keyword: string; page: string | null; position: number; impressions: number; clicks: number; /** clicks the site's own click-rate curve expects at this position, minus the ones it got */ missing: number }

/** Searches you rank for (top 15) whose click rate is furthest below your own curve: where looking at the results page pays most. Brand searches are left out. */
export function serpCandidates(site: SiteRow, n = 10): SerpCandidate[] {
	const p = periodFor(site, 90);
	const terms = brandTerms(site);
	const all = queryPageRows(site.id, p.start, p.end);
	const curve = fittedCurve(all, terms);
	const best = new Map<string, { page: string; clicks: number; impressions: number; wpos: number }>();
	const tot = new Map<string, { clicks: number; impressions: number; pos: number }>();
	for (const r of all) {
		if (isBranded(r.query, terms)) continue;
		const t = tot.get(r.query) ?? { clicks: 0, impressions: 0, pos: 0 };
		t.clicks += r.clicks; t.impressions += r.impressions; t.pos += r.position * r.impressions;
		tot.set(r.query, t);
		const b = best.get(r.query);
		if (!b || r.impressions > b.impressions) best.set(r.query, { page: r.page, clicks: r.clicks, impressions: r.impressions, wpos: r.position });
	}
	return [...tot].map(([query, t]) => {
		const position = t.impressions ? t.pos / t.impressions : 99;
		const expected = ctrAtPosition(curve, position) * t.impressions;
		return { keyword: query, page: best.get(query)?.page ?? null, position: Math.round(position * 10) / 10, impressions: t.impressions, clicks: t.clicks, missing: Math.max(0, Math.round((expected - t.clicks) * 10) / 10) };
	}).filter((c) => c.position <= 15 && c.impressions >= 50 && c.keyword.length <= 100).sort((a, b) => b.missing - a.missing || b.impressions - a.impressions).slice(0, Math.min(SERP_MAX, n));
}

/** `credits` is an upper bound: OpenSEO states about 5 a keyword at depth 20 and does not price the depth used here (see serpCredits). */
export interface SerpPlan { keywords: SerpCandidate[]; calls: number; credits: number; depth: number; /** how many searches qualify in all (up to SERP_MAX) */ available: number; perKeyword: number }
export function serpPlanFrom(all: SerpCandidate[], n: number): SerpPlan {
	const keywords = all.slice(0, Math.min(SERP_MAX, Math.max(1, n)));
	return { keywords, calls: Math.ceil(keywords.length / SERP_BATCH), credits: serpCredits(keywords.length), depth: SERP_DEPTH, available: all.length, perKeyword: serpCredits(1) };
}
export const serpPlan = (siteId: number, n = 10): SerpPlan => serpPlanFrom(serpCandidates(getSite(siteId)!, SERP_MAX), n);
export interface SerpResult { checks: SerpCheck[]; asked: number; failed: number; depth: number; summary: { crowded: number; mismatch: number; both: number; ok: number; unclear: number } }

export async function runSerp(siteId: number, keywords: SerpCandidate[], o: { api?: OseoApi; force?: boolean; now?: number } = {}): Promise<SerpResult> {
	const os = needOpenSeo(siteId, o);
	const list = keywords.slice(0, SERP_MAX);
	if (!list.length) throw new Error('No searches to look up.');
	const release = claim(siteId, 'serp', o);
	const checks: SerpCheck[] = [];
	try {
		const api = await os.api();
		for (let i = 0; i < list.length; i += SERP_BATCH) {
			const batch = list.slice(i, i + SERP_BATCH);
			const out = await api.callTool('get_serp_results', { projectId: os.projectId, queries: batch.map((k) => ({ keyword: k.keyword })), depth: SERP_DEPTH });
			const parsed = new Map(parseSerp(out).map((k) => [k.keyword.toLowerCase(), k]));
			for (const c of batch) {
				const k = parsed.get(c.keyword.toLowerCase()) ?? { keyword: c.keyword, ok: false, error: 'OpenSEO returned nothing for this search.', items: [], device: null };
				checks.push(checkSerp(k, { page: c.page, position: c.position, impressions: c.impressions, clicks: c.clicks }));
			}
		}
	} catch (e) {
		release();
		throw new Error(`OpenSEO: ${message(e)}`);
	}
	const summary = { crowded: 0, mismatch: 0, both: 0, ok: 0, unclear: 0 };
	for (const c of checks) summary[c.verdict]++;
	const result: SerpResult = { checks, asked: list.length, failed: checks.filter((c) => c.verdict === 'unclear').length, depth: SERP_DEPTH, summary };
	keep(siteId, 'serp', serpCredits(list.length), result);
	audit('openseo.serp', { siteId, detail: `${list.length} searches looked up, ${result.failed} failed` });
	return result;
}

// ── 2. Competitor gap ────────────────────────────────────────────────────────
/** The searches to compare on: non-brand queries you appear for between positions 4 and 40, most impressions first. */
export function gapKeywords(site: SiteRow, n = 30): string[] {
	const p = periodFor(site, 90);
	const terms = brandTerms(site);
	const tot = new Map<string, { impressions: number; pos: number }>();
	for (const r of queryPageRows(site.id, p.start, p.end)) {
		if (isBranded(r.query, terms) || r.query.length > 120) continue;
		const t = tot.get(r.query) ?? { impressions: 0, pos: 0 };
		t.impressions += r.impressions; t.pos += r.position * r.impressions;
		tot.set(r.query, t);
	}
	return [...tot].filter(([, t]) => t.impressions >= 20 && t.pos / t.impressions >= 4 && t.pos / t.impressions <= 40).sort((a, b) => b[1].impressions - a[1].impressions).slice(0, Math.min(GAP_KEYWORDS_MAX, n)).map(([q]) => q);
}
export interface GapPlan { keywords: string[]; calls: number; study: number; priced: false; note: string }
export function gapPlan(siteId: number, n = 30): GapPlan {
	const keywords = gapKeywords(getSite(siteId)!, n);
	return { keywords, calls: keywords.length ? 1 + GAP_STUDY : 0, study: GAP_STUDY, priced: false, note: 'OpenSEO states only that these two tools "charge credits" and gives no price, so the cost is not known in advance. One competitor lookup plus up to three keyword lists.' };
}
export interface GapResult { keywordsUsed: number; competitors: Competitor[]; studied: string[]; rows: GapRow[]; fitted: boolean }

export async function runGap(siteId: number, keywords: string[], o: { api?: OseoApi; force?: boolean; now?: number } = {}): Promise<GapResult> {
	const site = getSite(siteId)!;
	const os = needOpenSeo(siteId, o);
	const kws = [...new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean))].slice(0, GAP_KEYWORDS_MAX);
	if (!kws.length) throw new Error('No searches to compare on.');
	const release = claim(siteId, 'gap', o);
	const own = hostKey(site.site_url);
	let competitors: Competitor[];
	const rows: GapRow[] = [];
	let studied: string[] = [];
	try {
		const api = await os.api();
		competitors = parseCompetitors(await api.callTool('find_serp_competitors', { projectId: os.projectId, keywords: kws, excludeDomains: [own], limit: 20, sortBy: 'visibility' }));
		const study = studyList(competitors, own, GAP_STUDY);
		studied = study.map((c) => c.domain);
		const p = periodFor(site, 90);
		const ownQueries = new Map<string, { query: string; position: number; impressions: number; clicks: number }>();
		for (const r of queryPageRows(site.id, p.start, p.end)) {
			const t = ownQueries.get(r.query) ?? { query: r.query, position: 0, impressions: 0, clicks: 0 };
			t.position += r.position * r.impressions; t.impressions += r.impressions; t.clicks += r.clicks;
			ownQueries.set(r.query, t);
		}
		const own2 = [...ownQueries.values()].map((t) => ({ ...t, position: t.impressions ? t.position / t.impressions : 99 }));
		for (const c of study) {
			const ranked = parseRanked(await api.callTool('get_ranked_keywords', { projectId: os.projectId, target: c.domain, scope: 'domain', limit: 100, maxRank: 20, minSearchVolume: 20, sortBy: 'search_volume', resultTypes: ['organic'] }));
			rows.push(...computeGap(c.domain, ranked, own2, { limit: 25 }));
		}
	} catch (e) {
		release();
		throw new Error(`OpenSEO: ${message(e)}`);
	}
	// A keyword two competitors both rank for is listed once, under the one that ranks better.
	const seen = new Map<string, GapRow>();
	for (const r of rows) { const k = `${r.kind}:${r.keyword}`; const cur = seen.get(k); if (!cur || r.competitorRank < cur.competitorRank) seen.set(k, r); }
	const merged = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 60);
	// Say how well each gap keyword fits what the site already earns clicks for (the niche profile, see src/lib/nichefit.ts).
	const profile = nicheFor(site, 90).profile;
	const fit = new Map(scoreKeywords(profile, merged.map((r) => r.keyword)).map((f) => [f.keyword, f.fit]));
	for (const r of merged) r.fit = fit.get(r.keyword);
	const result: GapResult = { keywordsUsed: kws.length, competitors: competitors.slice(0, 12), studied, rows: merged, fitted: profile.vocabulary.size > 0 };
	keep(siteId, 'gap', null, result);
	audit('openseo.gap', { siteId, detail: `${kws.length} searches, ${studied.length} competitors studied, ${merged.length} gaps` });
	return result;
}

// ── 3. Backlink reclaim ──────────────────────────────────────────────────────
export interface BacklinkPlan { target: string; pages: number; credits: number }
export const backlinkPlan = (siteId: number): BacklinkPlan => ({ target: hostKey(getSite(siteId)!.site_url), pages: 1, credits: 30 });
export interface BacklinkResult { target: string; profile: LinkProfile; reclaim: ReclaimRow[]; spamSample: Backlink[]; sample: Backlink[]; partial: boolean; deadKnown: number }

/** Pages known to be gone: the crawl's 4xx/5xx, the checked link targets that came back that way, and the pages Bing's crawler found missing. Keyed by normalised URL. */
function deadPages(siteId: number): Map<string, string> {
	const dead = new Map<string, string>();
	for (const p of crawledLinkPages(siteId)) if (p.status >= 400) dead.set(normalizeUrl(p.url), `The page answered ${p.status}.`);
	for (const r of db().prepare('SELECT norm, status FROM link_checks WHERE site_id = ? AND status >= 400 AND status NOT IN (401,403,408,429)').all(siteId) as { norm: string; status: number }[]) if (!dead.has(r.norm)) dead.set(r.norm, `The page answered ${r.status}.`);
	for (const [norm, b] of bingDeadPages(siteId)) if (!dead.has(norm)) dead.set(norm, `Bing's crawler got ${b.httpCode} for this page.`);
	return dead;
}

export async function runBacklinks(siteId: number, o: { api?: OseoApi; force?: boolean; now?: number } = {}): Promise<BacklinkResult> {
	const site = getSite(siteId)!;
	const os = needOpenSeo(siteId, o);
	const release = claim(siteId, 'backlinks', o);
	const target = hostKey(site.site_url);
	let rows: Backlink[] = [];
	let total = 0;
	let partial = false;
	try {
		const out = parseBacklinks(await (await os.api()).callTool('get_backlinks_profile', { projectId: os.projectId, target, scope: 'subdomains', mode: 'as_is', pageSize: BACKLINK_ROWS, page: 1, hideSpam: false, filters: { hideBroken: false, hideLost: false } }));
		rows = out.rows; total = out.total; partial = out.hasMore;
	} catch (e) {
		release();
		throw new Error(`OpenSEO: ${message(e)}`);
	}
	const dead = deadPages(siteId);
	const p = periodFor(site, 90);
	const live = (db().prepare('SELECT page, SUM(clicks) c, SUM(impressions) i FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY page HAVING SUM(impressions) > 0 ORDER BY i DESC LIMIT 300').all(siteId, p.start, p.end) as { page: string; c: number; i: number }[])
		.filter((r) => !dead.has(normalizeUrl(r.page))).map((r) => ({ url: r.page, clicks: r.c, impressions: r.i }));
	const result: BacklinkResult = {
		target, profile: linkProfile(rows, total), reclaim: reclaimPlan(rows, dead, live).slice(0, 40),
		spamSample: rows.filter((r) => (r.spam ?? 0) >= 40).slice(0, 10), sample: rows.slice(0, 15), partial, deadKnown: dead.size
	};
	keep(siteId, 'backlinks', 30, result);
	audit('openseo.backlinks', { siteId, detail: `${total} backlinks, ${result.reclaim.length} pages to reclaim` });
	return result;
}

/** Everything stored for a site, for the page and the MCP tool. Never calls OpenSEO. */
export function researchFor(siteId: number) {
	return { serp: storedResearch<SerpResult>(siteId, 'serp'), gap: storedResearch<GapResult>(siteId, 'gap'), backlinks: storedResearch<BacklinkResult>(siteId, 'backlinks'), linked: !!openSeoFor(siteId) };
}
