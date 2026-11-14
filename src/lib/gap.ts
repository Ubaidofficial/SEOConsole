/**
 * Competitor gap: who beats you for the searches you already appear for, and which of their keywords you have no page for. Pure functions.
 * Parsers follow the answers of OpenSEO's `find_serp_competitors` and `get_ranked_keywords` as returned by a live instance on 2026-11-14:
 *  - competitors: `{ competitors: [{ domain, avg_position, median_position, etv, keywords_count, visibility, keywords_positions: { keyword: [rank] } }] }`
 *  - ranked keywords: `{ keywords: [{ keyword_data: { keyword, keyword_info: { search_volume }, keyword_properties: { keyword_difficulty },
 *    search_intent_info: { main_intent }, serp_info: { serp_item_types } }, ranked_serp_element: { serp_item: { url, rank_group, etv } } }], totalCount }`
 *
 * What it will not tell you: whether you *can* beat a competitor. A site with fifty times your links and a decade of history is on this list
 * the same as a small one, so big general sites (marketplaces, social networks, encyclopaedias) are marked as platforms and left out of the
 * ones worth studying. Search volume and rank come from a third-party panel, not from Google.
 */
import { queryTokens } from './groups';
import { normQuery as norm } from './hidden';

export interface Competitor { domain: string; avgPosition: number; medianPosition: number; keywords: number; visibility: number; traffic: number; positions: Record<string, number>; platform: boolean }

/** Sites you cannot out-write with a page: marketplaces, social networks, encyclopaedias, general Q&A. A rule of thumb, not a verdict. */
const PLATFORM = /(^|\.)(wikipedia\.org|youtube\.com|reddit\.com|facebook\.com|instagram\.com|pinterest\.[a-z.]+|quora\.com|x\.com|twitter\.com|linkedin\.com|tiktok\.com|amazon\.[a-z.]+|ebay\.[a-z.]+|etsy\.com|walmart\.com|target\.com|goodreads\.com|google\.com|apple\.com|play\.google\.com|medium\.com|github\.com|stackoverflow\.com)$/i;
export const isPlatform = (domain: string) => PLATFORM.test(domain.replace(/^www\./, ''));
export const bareDomain = (d: string) => d.toLowerCase().replace(/^www\./, '');

const n = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const s = (v: unknown) => (typeof v === 'string' ? v : '');

export function parseCompetitors(out: unknown): Competitor[] {
	const list = (out as { competitors?: unknown[] } | null)?.competitors;
	if (!Array.isArray(list)) return [];
	return list.map((c) => {
		const o = c as Record<string, unknown>;
		const positions: Record<string, number> = {};
		for (const [k, v] of Object.entries((o.keywords_positions ?? {}) as Record<string, unknown>)) {
			const ranks = (Array.isArray(v) ? v : []).filter((x): x is number => typeof x === 'number');
			if (ranks.length) positions[k.toLowerCase()] = Math.min(...ranks);
		}
		const domain = bareDomain(s(o.domain));
		return { domain, avgPosition: n(o.avg_position), medianPosition: n(o.median_position), keywords: n(o.keywords_count), visibility: n(o.visibility), traffic: n(o.etv), positions, platform: isPlatform(domain) };
	}).filter((c) => c.domain);
}

export interface RankedKeyword { keyword: string; volume: number | null; kd: number | null; intent: string | null; serpTypes: string[]; url: string | null; rank: number | null; traffic: number }

export function parseRanked(out: unknown): RankedKeyword[] {
	const list = (out as { keywords?: unknown[] } | null)?.keywords;
	if (!Array.isArray(list)) return [];
	return list.map((r) => {
		const x = r as { keyword_data?: Record<string, any>; ranked_serp_element?: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
		const kd = x.keyword_data ?? {};
		const el = x.ranked_serp_element ?? {};
		const item = el.serp_item ?? {};
		const types = (kd.serp_info?.serp_item_types ?? el.serp_item_types ?? []) as unknown[];
		return {
			keyword: s(kd.keyword).toLowerCase().trim(),
			volume: typeof kd.keyword_info?.search_volume === 'number' ? kd.keyword_info.search_volume : null,
			kd: typeof kd.keyword_properties?.keyword_difficulty === 'number' ? kd.keyword_properties.keyword_difficulty : null,
			intent: s(kd.search_intent_info?.main_intent) || null,
			serpTypes: types.filter((t): t is string => typeof t === 'string'),
			url: s(item.url) || null,
			rank: typeof item.rank_group === 'number' ? item.rank_group : null,
			traffic: n(item.etv)
		};
	}).filter((k) => k.keyword);
}

export interface OwnQuery { query: string; position: number; impressions: number; clicks: number }
export interface GapRow { keyword: string; competitor: string; competitorRank: number; competitorUrl: string | null; volume: number | null; kd: number | null; intent: string | null; serpTypes: string[]; score: number; kind: 'missing' | 'behind'; ownPosition: number | null; fit?: string }

/** How much of a keyword's volume the rank collects: a rough shape, not a measured curve. */
const rankWeight = (r: number) => (r <= 3 ? 1 : r <= 5 ? 0.6 : r <= 10 ? 0.3 : r <= 20 ? 0.08 : 0.01);

/**
 * From one competitor's ranked keywords: `missing` are keywords it ranks in the top 20 for that you do not appear for at all in your
 * Search Console queries; `behind` are ones you do appear for, at least five places further down than it and outside your own top 10.
 * Most prize first (volume x how much its rank collects). Keywords with no volume are kept last, not dropped: the panel has no number
 * for many long phrases.
 */
export function computeGap(competitor: string, ranked: RankedKeyword[], own: OwnQuery[], o: { minVolume?: number; limit?: number } = {}): GapRow[] {
	const { minVolume = 20, limit = 40 } = o;
	const mine = new Map(own.map((q) => [norm(q.query), q]));
	const out: GapRow[] = [];
	for (const k of ranked) {
		if (k.rank == null || k.rank > 20) continue;
		if (k.volume != null && k.volume < minVolume) continue;
		const m = mine.get(norm(k.keyword));
		const base = { keyword: k.keyword, competitor, competitorRank: k.rank, competitorUrl: k.url, volume: k.volume, kd: k.kd, intent: k.intent, serpTypes: k.serpTypes, score: (k.volume ?? 0) * rankWeight(k.rank) };
		if (!m) out.push({ ...base, kind: 'missing', ownPosition: null });
		else if (m.position > 10 && m.position - k.rank >= 5) out.push({ ...base, kind: 'behind', ownPosition: Math.round(m.position * 10) / 10 });
	}
	return out.sort((a, b) => b.score - a.score || a.keyword.localeCompare(b.keyword)).slice(0, limit);
}

/** The competitors worth studying: not platforms, not you, most visible first. */
export function studyList(c: Competitor[], own: string, n = 3): Competitor[] {
	const me = bareDomain(own);
	return c.filter((x) => !x.platform && x.domain !== me && !x.domain.endsWith('.' + me)).sort((a, b) => b.visibility - a.visibility || a.avgPosition - b.avgPosition).slice(0, n);
}

/** Words in common, for a quick relevance check of a gap keyword against a page's words. */
export const sharedWords = (a: string, b: string) => queryTokens(a).filter((t) => queryTokens(b).includes(t));
