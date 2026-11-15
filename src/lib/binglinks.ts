/**
 * Bing's inbound-link and crawl-issue data for a site, turned into one answer: which of your pages have inbound links, and which pages that
 * still have links now fail. Pure functions, no I/O. Shapes follow Microsoft's reference for the Bing Webmaster API (read 2026-11-15):
 *  - GetLinkCounts(siteUrl, page): { d: { Links: [{ Url, Count }], TotalPages } }, pages numbered from 0
 *  - GetUrlLinks(siteUrl, link, page): { d: { Details: [{ Url, AnchorText }], TotalPages } }
 *  - GetCrawlIssues(siteUrl): { d: [{ Url, HttpCode, Issues, InLinks }] }, where Issues is a set of flag bits
 * Of those flag bits only one value is known from the documentation: 32 is shown as ContainsMalware in Microsoft's own sample. The others are
 * not interpreted here; a problem is judged by its HTTP code, which is plain.
 *
 * What this data is: what Bing's crawler knows about your site. A new or small site often has few links in it; it is not Google's view, and
 * Bing may take days to drop a fixed address from its list (Microsoft says so).
 */
import { normalizeUrl } from './analytics';
import { closestLive } from './reclaim';

export interface BingLinkCount { url: string; count: number }
export interface BingLinkSource { url: string; anchor: string }
export interface BingCrawlIssue { url: string; httpCode: number; issues: number; inLinks: number }

/** Value 32 of the Issues flags is ContainsMalware in Microsoft's sample response; no other flag is interpreted. */
export const FLAG_MALWARE = 32;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

export function parseLinkCounts(d: unknown): { links: BingLinkCount[]; totalPages: number } {
	const o = d as { Links?: unknown; TotalPages?: unknown } | null;
	const links = (Array.isArray(o?.Links) ? o!.Links : []).map((l) => ({ url: str((l as { Url?: unknown }).Url), count: int((l as { Count?: unknown }).Count) })).filter((l) => l.url);
	return { links, totalPages: Math.max(1, int(o?.TotalPages) || 1) };
}

export function parseUrlLinks(d: unknown): { sources: BingLinkSource[]; totalPages: number } {
	const o = d as { Details?: unknown; TotalPages?: unknown } | null;
	const sources = (Array.isArray(o?.Details) ? o!.Details : []).map((l) => ({ url: str((l as { Url?: unknown }).Url), anchor: str((l as { AnchorText?: unknown }).AnchorText) })).filter((l) => l.url);
	return { sources, totalPages: int(o?.TotalPages) };
}

export function parseCrawlIssues(d: unknown): BingCrawlIssue[] {
	return (Array.isArray(d) ? d : []).map((x) => {
		const o = x as { Url?: unknown; HttpCode?: unknown; Issues?: unknown; InLinks?: unknown };
		return { url: str(o.Url), httpCode: int(o.HttpCode), issues: int(o.Issues), inLinks: int(o.InLinks) };
	}).filter((i) => i.url);
}

export type DeadKind = 'gone' | 'error' | 'blocked';
/** What an HTTP code means for a page that has links: gone (404, 410, other 4xx), a server error (5xx), or blocked to the crawler (401, 403, 429). Anything else is not a problem. */
export function kindOfCode(code: number): DeadKind | null {
	if ([401, 403, 429].includes(code)) return 'blocked';
	if (code === 408) return null;
	if (code >= 500 && code < 600) return 'error';
	if (code >= 400 && code < 500) return 'gone';
	return null;
}

export interface DeadWithLinks { url: string; httpCode: number; kind: 'gone' | 'error'; inLinks: number; /** closest live page by the words in the address, for a gone page only */ redirectTo: string | null; match: number }
export interface BingLinksReport {
	totals: { pagesWithLinks: number; links: number; truncated: boolean };
	mostLinked: BingLinkCount[];
	/** failing pages that still have inbound links, most links first */
	dead: DeadWithLinks[];
	issueCounts: { gone: number; error: number; blocked: number; malware: number };
	malware: string[];
	headline: string;
}

/**
 * `counts` are the pages Bing knows inbound links for; `issues` its crawl problems; `live` working pages worth sending links to. A failing
 * page's link count is the larger of what the issue says and what the link list says. Only failing pages WITH links are listed: a dead page
 * nobody links to needs no redirect.
 */
export function analyseBingLinks(counts: BingLinkCount[], issues: BingCrawlIssue[], live: { url: string; clicks: number; impressions: number }[], o: { pagesWithLinks?: number; links?: number; truncated?: boolean } = {}): BingLinksReport {
	const byNorm = new Map<string, number>();
	for (const c of counts) byNorm.set(normalizeUrl(c.url), Math.max(byNorm.get(normalizeUrl(c.url)) ?? 0, c.count));
	const seen = new Set<string>();
	const dead: DeadWithLinks[] = [];
	const issueCounts = { gone: 0, error: 0, blocked: 0, malware: 0 };
	const malware: string[] = [];
	for (const i of issues) {
		const kind = kindOfCode(i.httpCode);
		if (kind) issueCounts[kind]++;
		if (i.issues & FLAG_MALWARE) (issueCounts.malware++, malware.push(i.url));
		if ((kind !== 'gone' && kind !== 'error') || seen.has(normalizeUrl(i.url))) continue;
		seen.add(normalizeUrl(i.url));
		const inLinks = Math.max(i.inLinks, byNorm.get(normalizeUrl(i.url)) ?? 0);
		if (inLinks < 1) continue;
		const best = kind === 'gone' ? closestLive(i.url, live) : null;
		dead.push({ url: i.url, httpCode: i.httpCode, kind, inLinks, redirectTo: best?.url ?? null, match: best ? Math.round(Math.min(1, best.score) * 100) / 100 : 0 });
	}
	dead.sort((a, b) => b.inLinks - a.inLinks || a.url.localeCompare(b.url));
	const mostLinked = [...counts].sort((a, b) => b.count - a.count || a.url.localeCompare(b.url)).slice(0, 15);
	const links = o.links ?? counts.reduce((a, c) => a + c.count, 0);
	const pagesWithLinks = o.pagesWithLinks ?? counts.length;
	const headline = malware.length ? `Bing flags ${malware.length} page${malware.length === 1 ? '' : 's'} as containing malware: check them first.`
		: dead.length ? `${dead.length} page${dead.length === 1 ? '' : 's'} that fail still ${dead.length === 1 ? 'has' : 'have'} inbound links in Bing's index (${dead.reduce((a, d) => a + d.inLinks, 0)} links).`
		: pagesWithLinks ? `Bing knows ${links} inbound links to ${pagesWithLinks} of your pages, and none of the pages it found failing has any.`
		: 'Bing has no inbound links on record for this site yet.';
	return { totals: { pagesWithLinks, links, truncated: !!o.truncated }, mostLinked, dead, issueCounts, malware, headline };
}
