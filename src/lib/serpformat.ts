/**
 * SERP format check: for a search you already rank for, what does the results page actually look like, and does your page fit it?
 * Pure functions, no I/O. Parsers follow the answers of OpenSEO's `get_serp_results` as returned by a live instance on 2026-11-14:
 * `{ results: [{ keyword, ok, items: [{ type, rank, organicRank, title, url, domain, description }] }] }`, where `type` is a SERP element
 * ("organic", "ai_overview", "people_also_ask", ...), `rank` counts every element and `organicRank` only organic results. That instance
 * returned `google.com/goto?url=...` redirect links in place of the real addresses for organic results, so the **titles** (not the
 * domains) are what is classified here; if real domains come back they are kept.
 *
 * Two questions, both answered with rules of thumb that are this app's own (English only):
 *  - Format: are most organic results lists, tools, comparisons, how-tos or product pages, and is yours one of those?
 *  - Crowding: how many elements (an AI overview, an answer box, shopping, video...) sit above the first organic result?
 * Neither proves why a page is or is not clicked. They tell you what to look at before spending a week rewriting.
 */
export type Format = 'list' | 'tool' | 'compare' | 'howto' | 'product' | 'reference';
export const FORMAT_LABEL: Record<Format, string> = { list: 'List / roundup', tool: 'Tool / calculator', compare: 'Comparison / alternatives', howto: 'How-to / guide', product: 'Product / pricing', reference: 'Reference / profile' };

const RULES: [Format, RegExp][] = [
	['tool', /\b(calculator|generator|converter|checker|compressor|template|planner|finder|tracker|quiz|simulator|maker)\b/i],
	['compare', /\b(vs\.?|versus|alternatives?|compared?|comparison|reviews?)\b/i],
	['product', /\b(buy|pric(e|es|ing)|cost|cheap(est)?|discount|deals?|sale|shop|coupon)\b/i],
	['howto', /\b(how (to|do|can)|tutorial|step[- ]by[- ]step|guide|what is|explained|tips)\b/i],
	['list', /\b(best|top\s*\d*|\d+\s+(best|top|great)|greatest|must[- ]read|lists?|ranked|ranking|in order|reading list|recommended|recommendations?|complete series)\b/i]
];
/** What kind of page a title (or a URL slug with the dashes taken out) describes. Anything that matches nothing is a reference page. */
export function formatOf(text: string): Format {
	const t = text.replace(/[-_/]+/g, ' ');
	for (const [f, re] of RULES) if (re.test(t)) return f;
	return 'reference';
}

/** The kind of page a URL is, from its folder and slug. */
export function pageFormat(url: string): Format {
	let path = url;
	try { path = new URL(url).pathname; } catch { /* keep as is */ }
	return formatOf(path);
}

export interface SerpItem { type: string; rank: number | null; organicRank: number | null; title: string | null; domain: string | null; url: string | null }
export interface SerpKeyword { keyword: string; ok: boolean; error: string | null; items: SerpItem[]; device: string | null }

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const numOr = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Read get_serp_results defensively: a keyword that failed is kept with its error, items without a type are dropped. */
export function parseSerp(out: unknown): SerpKeyword[] {
	const results = (out as { results?: unknown[] } | null)?.results;
	if (!Array.isArray(results)) return [];
	return results.map((r) => {
		const o = r as { keyword?: unknown; ok?: unknown; error?: unknown; items?: unknown; device?: unknown };
		const items = (Array.isArray(o.items) ? o.items : []).map((i) => {
			const x = i as Record<string, unknown>;
			return { type: str(x.type) ?? '', rank: numOr(x.rank), organicRank: numOr(x.organicRank), title: str(x.title), domain: str(x.domain), url: str(x.url) } satisfies SerpItem;
		}).filter((i) => i.type);
		return { keyword: str(o.keyword) ?? '', ok: o.ok === true, error: str(o.error), items, device: str(o.device) };
	}).filter((k) => k.keyword);
}

/** Elements that push the organic results down the page. People Also Ask, related searches and images count less and are listed apart. */
const PUSH = new Set(['ai_overview', 'featured_snippet', 'answer_box', 'knowledge_graph', 'popular_products', 'shopping', 'paid', 'local_pack', 'video', 'top_stories', 'google_flights', 'google_hotels', 'carousel', 'map']);
const SOFT = new Set(['people_also_ask', 'related_searches', 'images', 'discussions_and_forums', 'perspectives', 'twitter']);
export const FEATURE_LABEL: Record<string, string> = {
	ai_overview: 'an AI overview', featured_snippet: 'a featured snippet', answer_box: 'an answer box', knowledge_graph: 'a knowledge panel', popular_products: 'a shopping carousel', shopping: 'shopping results', paid: 'ads',
	local_pack: 'a local map pack', video: 'videos', top_stories: 'top stories', people_also_ask: 'People Also Ask', related_searches: 'related searches', images: 'images', discussions_and_forums: 'forum results', carousel: 'a carousel'
};

export type SerpVerdict = 'crowded' | 'mismatch' | 'both' | 'ok' | 'unclear';
export interface SerpCheck {
	keyword: string;
	/** your page for it, if known */
	page: string | null;
	pageFormat: Format | null;
	position: number | null;
	impressions: number | null;
	clicks: number | null;
	/** elements above the first organic result that push it down, in order */
	above: string[];
	/** softer elements anywhere on the page (People Also Ask...) */
	soft: string[];
	organicCount: number;
	formats: { format: Format; count: number }[];
	dominant: { format: Format; share: number } | null;
	verdict: SerpVerdict;
	note: string;
}

const listOf = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Judge one keyword's results page against the page you have for it. */
export function checkSerp(k: SerpKeyword, own: { page: string | null; position: number | null; impressions: number | null; clicks: number | null } = { page: null, position: null, impressions: null, clicks: null }): SerpCheck {
	const organic = k.items.filter((i) => i.type === 'organic').sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
	const firstRank = organic[0]?.rank ?? Infinity;
	const above = k.items.filter((i) => (i.rank ?? Infinity) < firstRank && PUSH.has(i.type)).map((i) => i.type);
	const soft = [...new Set(k.items.filter((i) => SOFT.has(i.type)).map((i) => i.type))];
	const counts = new Map<Format, number>();
	for (const o of organic) { const f = formatOf(o.title ?? ''); counts.set(f, (counts.get(f) ?? 0) + 1); }
	const formats = [...counts].map(([format, count]) => ({ format, count })).sort((a, b) => b.count - a.count);
	// "Reference" is what is left when nothing matched, so it is never called the dominant format.
	const top = formats.find((f) => f.format !== 'reference');
	const dominant = top && organic.length >= 5 && top.count / organic.length >= 0.5 ? { format: top.format, share: top.count / organic.length } : null;
	const mine = own.page ? pageFormat(own.page) : null;
	const crowded = above.length > 0;
	const mismatch = !!(dominant && mine && mine !== 'reference' && mine !== dominant.format);
	const verdict: SerpVerdict = !k.ok || !organic.length ? 'unclear' : crowded && mismatch ? 'both' : crowded ? 'crowded' : mismatch ? 'mismatch' : 'ok';
	const bits: string[] = [];
	if (!k.ok) bits.push(k.error ? `The lookup failed: ${k.error}` : 'The lookup failed.');
	else if (!organic.length) bits.push('No organic results came back.');
	else {
		if (crowded) bits.push(`${listOf([...new Set(above)].map((t) => FEATURE_LABEL[t] ?? t.replace(/_/g, ' ')))} sit${above.length === 1 ? 's' : ''} above the first organic result, so even rank 1 is pushed down the page.`);
		if (mismatch) bits.push(`Most results (${Math.round(dominant!.share * 100)}%) are ${FORMAT_LABEL[dominant!.format].toLowerCase()}; your page looks like ${FORMAT_LABEL[mine!].toLowerCase()}.`);
		else if (dominant && mine === dominant.format) bits.push(`Your page is the same kind as most results (${FORMAT_LABEL[dominant.format].toLowerCase()}).`);
		else if (!dominant) bits.push('The results are a mix of formats, so no single format is expected.');
		if (soft.length) bits.push(`The page also has ${listOf(soft.map((t) => FEATURE_LABEL[t] ?? t.replace(/_/g, ' ')))}.`);
	}
	return { keyword: k.keyword, page: own.page, pageFormat: mine, position: own.position, impressions: own.impressions, clicks: own.clicks, above, soft, organicCount: organic.length, formats, dominant, verdict, note: bits.join(' ') };
}

export const SERP_VERDICT_LABEL: Record<SerpVerdict, string> = { crowded: 'Pushed down by features', mismatch: 'Format mismatch', both: 'Features and format', ok: 'Looks fine', unclear: 'Could not tell' };

/** OpenSEO's own price for a SERP lookup, from the tool description (read 2026-11-14): about 5 credits a keyword at depth 20, 2.5 more per extra 10 rows. Approximate. */
export const serpCredits = (keywords: number, depth = 10) => Math.round(keywords * (5 + (depth - 20) / 10 * 2.5) * 10) / 10;
