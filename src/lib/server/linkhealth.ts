import { db, audit } from './db';
import { getSite, type SiteRow } from './clients';
import { periodFor } from './queries';
import { crawledLinkPages, type CrawledLinkPage } from './internallinks';
import { fetchPage, guardedFetch, hostAllowed } from './onpage';
import { demoPageFetch } from './demo-channels';
import { normalizeUrl } from '../analytics';
import { linkHealth, type LinkHealth, type TargetCheck } from '../linkhealth';

/** At most this many link targets are fetched in one go: it is the site's own server being asked, so be gentle. */
export const VERIFY_MAX = 60;
/** A verified target is trusted this long. */
export const CHECK_TTL_MS = 7 * 86_400_000;

function storedChecks(siteId: number, now = Date.now()): Map<string, TargetCheck> {
	const rows = db().prepare('SELECT norm, status, final_url, error FROM link_checks WHERE site_id = ? AND checked_at > ?').all(siteId, now - CHECK_TTL_MS) as { norm: string; status: number; final_url: string | null; error: string | null }[];
	return new Map(rows.map((r) => [r.norm, { status: r.status, finalUrl: r.final_url, error: r.error }]));
}

/** Broken and redirected internal links from the stored crawl and the stored target checks. Fetches nothing. */
export function linkHealthFor(site: SiteRow, days = 90, pages: CrawledLinkPage[] = crawledLinkPages(site.id)): LinkHealth & { crawledAt: number | null } {
	const p = periodFor(site, days);
	const clicks = new Map<string, number>();
	for (const r of db().prepare('SELECT page, SUM(clicks) c FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY page').all(site.id, p.start, p.end) as { page: string; c: number }[]) clicks.set(normalizeUrl(r.page), r.c);
	const h = linkHealth(pages.map((x) => ({ url: x.url, finalUrl: x.finalUrl, status: x.status, error: x.error, links: x.links })), storedChecks(site.id), clicks);
	return { ...h, crawledAt: pages.length ? Math.max(...pages.map((x) => x.fetchedAt)) : null };
}

/**
 * Fetch link targets the crawl did not cover, most-linked first, and keep what each answers. Same hardened fetcher as the crawl (this
 * site's own host only, private addresses refused at connect time), three at a time. Returns what was checked.
 */
export async function verifyLinkTargets(siteId: number, o: { fetchImpl?: typeof fetch; max?: number } = {}): Promise<{ checked: number; broken: number; redirected: number; skipped: number }> {
	const site = getSite(siteId);
	if (!site) throw new Error('No such site.');
	const pages = crawledLinkPages(siteId); // read once: the crawl does not change while targets are checked
	const before = linkHealthFor(site, 90, pages);
	const max = Math.min(VERIFY_MAX, Math.max(1, o.max ?? VERIFY_MAX));
	// The original URLs, not the normalised ones: what the pages actually link to.
	const urlOf = new Map<string, string>();
	for (const pg of pages) for (const l of pg.links) { const k = normalizeUrl(l.url); if (!urlOf.has(k)) urlOf.set(k, l.url); }
	const todo = before.unchecked.map((k) => urlOf.get(k)).filter((u): u is string => !!u && hostAllowed(u, site.site_url));
	const skipped = before.unchecked.length - todo.length;
	const batch = todo.slice(0, max);
	const isDemo = !!(db().prepare('SELECT is_demo FROM accounts WHERE id = ?').get(site.account_id) as { is_demo: number } | undefined)?.is_demo;
	const fetchImpl = o.fetchImpl ?? (isDemo ? demoPageFetch(site.site_url) : guardedFetch);
	const results: { url: string; status: number; finalUrl: string; error: string | null }[] = [];
	const queue = [...batch];
	const worker = async () => {
		for (let u = queue.shift(); u; u = queue.shift()) {
			const f = await fetchPage(u, site.site_url, fetchImpl);
			results.push({ url: u, status: f.status, finalUrl: f.finalUrl, error: f.error ?? null });
		}
	};
	await Promise.all([worker(), worker(), worker()]);
	const put = db().prepare('INSERT OR REPLACE INTO link_checks (site_id, norm, url, status, final_url, error, checked_at) VALUES (?,?,?,?,?,?,?)');
	const now = Date.now();
	db().transaction(() => { for (const r of results) put.run(siteId, normalizeUrl(r.url), r.url, r.status, r.finalUrl, r.error, now); })();
	const after = linkHealthFor(site, 90, pages);
	audit('links.verify', { siteId, detail: `${results.length} link targets checked, ${after.broken.length} broken in all` });
	return { checked: results.length, broken: after.broken.length, redirected: after.redirected.length, skipped };
}

