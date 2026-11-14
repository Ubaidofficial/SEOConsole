/**
 * Link health: broken internal links and links that go through a redirect, found from the pages the link crawl already fetched.
 * Pure functions, no I/O.
 *
 * Why it matters before any link building: a broken link wastes the visitor's click and the crawler's time, and a link to a URL that
 * redirects sends visitors (and a little of the page's value) through a detour. Fixing them is free and certain.
 *
 * What it can and cannot see: the crawl keeps only the final URL after redirects, so it cannot count hops in a chain; it can say that a
 * link points at a URL that ends up somewhere else. A 401, 403 or 429 is not called broken (a site's own bot protection often answers
 * like that to a crawler); timeouts and refused connections are "unreachable", not broken.
 */
import { normalizeUrl } from './analytics';
import type { PageLink } from './linking';

export interface CrawlPage { url: string; finalUrl: string; status: number; error: string | null; links: PageLink[] }
export interface TargetCheck { status: number; finalUrl: string | null; error: string | null }

export type TargetState = 'ok' | 'broken' | 'redirect' | 'blocked' | 'unreachable';

/** What a fetch result means for a link pointing at it. `asked` and `final` are normalised URLs. */
export function targetState(c: TargetCheck, asked: string): TargetState {
	if (c.status === 404 || c.status === 410 || (c.status >= 400 && c.status < 500 && ![401, 403, 408, 429].includes(c.status)) || c.status >= 500) return 'broken';
	if ([401, 403, 429].includes(c.status)) return 'blocked';
	if (c.status === 0 || c.status === 408) return 'unreachable';
	if (c.finalUrl && normalizeUrl(c.finalUrl) !== asked) return 'redirect';
	if (c.error && c.status < 200) return 'unreachable';
	return 'ok';
}

export interface LinkSource { page: string; anchor: string; chrome: boolean }
export interface BadTarget { target: string; status: number; finalUrl: string | null; sources: LinkSource[]; /** clicks the linking pages earned in the period */ clicks: number }
export interface LinkHealth {
	pagesCrawled: number;
	targets: number;
	checked: number;
	/** distinct link targets that were neither crawled nor checked: the view is blind to them */
	unchecked: string[];
	broken: BadTarget[];
	redirected: BadTarget[];
	blocked: number;
	unreachable: number;
	headline: string;
}

/**
 * `pages` are the crawled pages; `checks` the verified link targets that were not crawled (keyed by normalised URL);
 * `clicks` the clicks per normalised page URL, to put the pages that matter first.
 */
export function linkHealth(pages: CrawlPage[], checks: Map<string, TargetCheck>, clicks: Map<string, number> = new Map()): LinkHealth {
	const known = new Map<string, TargetCheck>();
	for (const p of pages) {
		const c: TargetCheck = { status: p.status, finalUrl: p.finalUrl, error: p.error };
		known.set(normalizeUrl(p.url), c);
		const f = normalizeUrl(p.finalUrl);
		if (!known.has(f)) known.set(f, { status: p.status, finalUrl: p.finalUrl, error: p.error }); // a link may point straight at where it ended up
	}
	for (const [k, c] of checks) if (!known.has(k)) known.set(k, c);

	const bySource = new Map<string, LinkSource[]>();
	for (const p of pages) {
		if (p.error && p.status === 0) continue; // an unreadable page has no links to judge
		const self = new Set([normalizeUrl(p.url), normalizeUrl(p.finalUrl)]);
		const seen = new Set<string>();
		for (const l of p.links) {
			const t = normalizeUrl(l.url);
			if (self.has(t) || seen.has(t)) continue;
			seen.add(t);
			(bySource.get(t) ?? bySource.set(t, []).get(t)!).push({ page: p.url, anchor: l.anchor, chrome: l.chrome });
		}
	}

	const broken: BadTarget[] = [];
	const redirected: BadTarget[] = [];
	const unchecked: string[] = [];
	let blocked = 0;
	let unreachable = 0;
	for (const [target, sources] of bySource) {
		const c = known.get(target);
		if (!c) { unchecked.push(target); continue; }
		const state = targetState(c, target);
		const total = sources.reduce((a, s) => a + (clicks.get(normalizeUrl(s.page)) ?? 0), 0);
		const row: BadTarget = { target, status: c.status, finalUrl: c.finalUrl, sources: sources.sort((a, b) => Number(a.chrome) - Number(b.chrome)), clicks: total };
		if (state === 'broken') broken.push(row);
		else if (state === 'redirect') redirected.push(row);
		else if (state === 'blocked') blocked++;
		else if (state === 'unreachable') unreachable++;
	}
	// The worst first: a link in the menu appears on every page, then by how many pages link, then by the clicks those pages earn.
	const rank = (a: BadTarget, b: BadTarget) => b.sources.length - a.sources.length || b.clicks - a.clicks || a.target.localeCompare(b.target);
	broken.sort(rank);
	redirected.sort(rank);
	unchecked.sort((a, b) => (bySource.get(b)!.length - bySource.get(a)!.length) || a.localeCompare(b));

	const headline = !pages.length ? 'No pages crawled yet: run the crawl first (Internal links tab).'
		: broken.length || redirected.length
			? `${broken.length} broken ${broken.length === 1 ? 'link target' : 'link targets'} and ${redirected.length} ${redirected.length === 1 ? 'link' : 'links'} through a redirect, found on ${pages.length} crawled pages${unchecked.length ? `; ${unchecked.length} other link targets have not been checked` : ''}.`
			: `No broken or redirected internal links among the ${bySource.size - unchecked.length} link targets checked${unchecked.length ? ` (${unchecked.length} more have not been checked)` : ''}.`;
	return { pagesCrawled: pages.length, targets: bySource.size, checked: bySource.size - unchecked.length, unchecked, broken, redirected, blocked, unreachable, headline };
}
