/**
 * Backlink reclaim: links other sites already give you that point at a page which no longer works. Pure functions.
 * The parser follows OpenSEO's `get_backlinks_profile` as returned by a live instance on 2026-11-14:
 * `{ backlinks: { rows: [{ domainFrom, urlFrom, urlTo, anchor, isDofollow, spamScore, domainFromRank, firstSeen, lastSeen, isLost, isBroken }], totalCount, hasMore } }`.
 *
 * A link to a dead page is the cheapest link you will ever get: somebody already chose to give it. Redirecting the dead address to the closest live page
 * passes most of its value on (as far as is publicly known; there is no number for how much). Links the provider scores as spam are shown but never
 * recommended; this app does not suggest disavowing anything.
 */
import { normalizeUrl } from './analytics';
import { queryTokens } from './groups';

export interface Backlink { domainFrom: string; urlFrom: string; urlTo: string; anchor: string; dofollow: boolean; spam: number | null; domainRank: number | null; firstSeen: string | null; lastSeen: string | null; lost: boolean; broken: boolean }

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseBacklinks(out: unknown): { rows: Backlink[]; total: number; hasMore: boolean } {
	const b = (out as { backlinks?: { rows?: unknown[]; totalCount?: unknown; hasMore?: unknown } } | null)?.backlinks;
	const rows = (Array.isArray(b?.rows) ? b!.rows! : []).map((r) => {
		const x = r as Record<string, unknown>;
		return { domainFrom: str(x.domainFrom).toLowerCase(), urlFrom: str(x.urlFrom), urlTo: str(x.urlTo), anchor: str(x.anchor), dofollow: x.isDofollow === true, spam: num(x.spamScore), domainRank: num(x.domainFromRank), firstSeen: str(x.firstSeen) || null, lastSeen: str(x.lastSeen) || null, lost: x.isLost === true, broken: x.isBroken === true } satisfies Backlink;
	}).filter((r) => r.urlTo && r.domainFrom);
	return { rows, total: num(b?.totalCount) ?? rows.length, hasMore: b?.hasMore === true };
}

/** The provider's spam score at or above which a link is treated as spam here. Its own tool hides links at 40 and above by default. */
export const SPAM_AT = 40;

export interface LinkProfile { backlinks: number; referringDomains: number; dofollow: number; nofollow: number; spammy: number; live: number; lost: number; broken: number; quality: 'none' | 'tiny' | 'some'; headline: string }
export function linkProfile(rows: Backlink[], total: number): LinkProfile {
	const live = rows.filter((r) => !r.lost);
	const domains = new Set(live.map((r) => r.domainFrom));
	const dofollow = live.filter((r) => r.dofollow).length;
	const spammy = live.filter((r) => (r.spam ?? 0) >= SPAM_AT).length;
	const good = live.filter((r) => r.dofollow && (r.spam ?? 0) < SPAM_AT).length;
	const quality = total === 0 ? 'none' : good < 5 ? 'tiny' : 'some';
	const headline = total === 0 ? 'No backlinks found at all.'
		: quality === 'tiny' ? `${total} backlink${total === 1 ? '' : 's'} from ${domains.size} site${domains.size === 1 ? '' : 's'}; only ${good} ${good === 1 ? 'is' : 'are'} followed and not scored as spam. That is a very thin link profile. This says nothing about whether links are what limits the site.`
		: `${total} backlinks from ${domains.size}+ sites; ${good} followed and not scored as spam.`;
	return { backlinks: total, referringDomains: domains.size, dofollow, nofollow: live.length - dofollow, spammy, live: live.length, lost: rows.length - live.length, broken: live.filter((r) => r.broken).length, quality, headline };
}

export interface ReclaimLink { from: string; domain: string; anchor: string; dofollow: boolean; spam: number | null; domainRank: number | null }
export interface ReclaimRow { target: string; why: string; links: ReclaimLink[]; dofollow: number; redirectTo: string | null; match: number }

const slug = (u: string) => { try { return new URL(u).pathname.replace(/[-_/]+/g, ' '); } catch { return u; } };

/**
 * The live page whose address shares the most words with a dead one (a guess to check by eye): Jaccard overlap of the words in the two
 * paths, at least a third, nudged towards pages that get impressions. `score` is that weighted overlap; null when nothing is close.
 */
export function closestLive(target: string, live: { url: string; clicks: number; impressions: number }[]): { url: string; score: number } | null {
	const words = (u: string) => new Set(queryTokens(slug(u)));
	const a = words(target);
	let best: { url: string; score: number } | null = null;
	for (const l of live) {
		if (normalizeUrl(l.url) === normalizeUrl(target)) continue;
		const b = words(l.url);
		const inter = [...a].filter((t) => b.has(t)).length;
		const score = a.size + b.size - inter > 0 ? inter / (a.size + b.size - inter) : 0;
		const weighted = score * (1 + Math.log10(1 + l.impressions) / 10);
		if (score >= 0.34 && (!best || weighted > best.score)) best = { url: l.url, score: weighted };
	}
	return best;
}

/**
 * `dead` maps the normalised URL of every page known to be gone (crawl 404, checked 404...) to the reason; a link the provider itself flags as
 * broken counts too. `live` are the working pages worth sending the links to, with what they earn. Redirect suggestions are by shared words in the
 * address, a guess to check by eye.
 */
export function reclaimPlan(rows: Backlink[], dead: Map<string, string>, live: { url: string; clicks: number; impressions: number }[]): ReclaimRow[] {
	const groups = new Map<string, ReclaimRow>();
	for (const r of rows) {
		if (r.lost || (r.spam ?? 0) >= SPAM_AT) continue;
		const key = normalizeUrl(r.urlTo);
		const why = dead.get(key) ?? (r.broken ? 'The link provider reports the target as broken.' : null);
		if (!why) continue;
		const g = groups.get(key) ?? { target: r.urlTo, why, links: [], dofollow: 0, redirectTo: null, match: 0 };
		g.links.push({ from: r.urlFrom, domain: r.domainFrom, anchor: r.anchor, dofollow: r.dofollow, spam: r.spam, domainRank: r.domainRank });
		if (r.dofollow) g.dofollow++;
		groups.set(key, g);
	}
	for (const g of groups.values()) {
		const best = closestLive(g.target, live);
		g.redirectTo = best?.url ?? null;
		g.match = best ? Math.round(Math.min(1, best.score) * 100) / 100 : 0;
	}
	return [...groups.values()].sort((a, b) => b.dofollow - a.dofollow || b.links.length - a.links.length || a.target.localeCompare(b.target));
}
