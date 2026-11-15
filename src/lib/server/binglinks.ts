import { db, audit } from './db';
import { linksFor } from './links';
import type { SiteRow } from './clients';
import { periodFor } from './queries';
import { normalizeUrl } from '../analytics';
import type { BingLinksClient } from './bing';
import { analyseBingLinks, kindOfCode, type BingCrawlIssue, type BingLinkCount, type BingLinksReport } from '../binglinks';

/**
 * Bing's inbound links and crawl issues, read once a week with the Bing key the site already has (free, no credits) and kept. A failed read
 * keeps the previous data and records why. Never throws: it runs at the end of the Bing sync and must not make that sync fail.
 */
export const LINKS_EVERY_MS = 7 * 86_400_000;
export const RETRY_AFTER_ERROR_MS = 86_400_000;
/** What is kept: the pages with the most links, and the issues with the most links, so one huge site cannot fill the database. */
const KEEP_COUNTS = 400;
const KEEP_ISSUES = 600;

interface Stored { counts: BingLinkCount[]; issues: BingCrawlIssue[]; pagesWithLinks: number; links: number; truncated: boolean }
interface Row { fetched_at: number; payload: string; error: string | null; error_at: number | null }
const rowOf = (siteId: number) => db().prepare('SELECT fetched_at, payload, error, error_at FROM bing_links WHERE site_id = ?').get(siteId) as Row | undefined;

export function bingLinksDue(siteId: number, now = Date.now()): boolean {
	const r = rowOf(siteId);
	if (!r) return true;
	if (r.error && r.error_at && now - r.error_at < RETRY_AFTER_ERROR_MS) return false; // failed today: not again until tomorrow
	return now - r.fetched_at > LINKS_EVERY_MS;
}

export async function syncBingLinks(siteId: number, client: Partial<BingLinksClient>, now = Date.now()): Promise<{ ok: boolean; pages?: number; issues?: number; error?: string }> {
	const link = linksFor(siteId).bing;
	if (!link) return { ok: false, error: 'This site is not linked to Bing.' };
	if (typeof client.linkCounts !== 'function' || typeof client.crawlIssues !== 'function') return { ok: false, error: 'This Bing connection cannot read link data.' };
	try {
		const c = await client.linkCounts(link.external_id);
		const issues = await client.crawlIssues(link.external_id);
		const counts = [...c.links].sort((a, b) => b.count - a.count).slice(0, KEEP_COUNTS);
		const stored: Stored = { counts, issues: [...issues].sort((a, b) => b.inLinks - a.inLinks).slice(0, KEEP_ISSUES), pagesWithLinks: c.links.length, links: c.links.reduce((a, l) => a + l.count, 0), truncated: c.truncated };
		db().prepare('INSERT INTO bing_links (site_id, fetched_at, payload, error, error_at) VALUES (?,?,?,NULL,NULL) ON CONFLICT(site_id) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload, error = NULL, error_at = NULL').run(siteId, now, JSON.stringify(stored));
		return { ok: true, pages: c.links.length, issues: issues.length };
	} catch (e) {
		// A message from Bing, never the request (its URL carries the API key); BingApiError messages are already clean.
		const msg = e instanceof Error ? e.message.slice(0, 300) : 'Bing did not answer.';
		db().prepare("INSERT INTO bing_links (site_id, fetched_at, payload, error, error_at) VALUES (?,0,'{}',?,?) ON CONFLICT(site_id) DO UPDATE SET error = excluded.error, error_at = excluded.error_at").run(siteId, msg, now);
		return { ok: false, error: msg };
	}
}

/** Failing pages as Bing reports them (gone, by HTTP code), for other features to treat as known dead. Keyed by normalised URL. */
export function bingDeadPages(siteId: number): Map<string, { httpCode: number; inLinks: number }> {
	const r = rowOf(siteId);
	const out = new Map<string, { httpCode: number; inLinks: number }>();
	if (!r || !r.fetched_at) return out;
	for (const i of (JSON.parse(r.payload) as Stored).issues ?? []) if (kindOfCode(i.httpCode) === 'gone') out.set(normalizeUrl(i.url), { httpCode: i.httpCode, inLinks: i.inLinks });
	return out;
}

export interface SiteBingLinks { fetchedAt: number | null; error: string | null; errorAt: number | null; report: BingLinksReport | null }

/** The stored data analysed against what the site earns now. Reads only; null when this site has never been read. */
export function bingLinksFor(site: SiteRow, days = 90): SiteBingLinks | null {
	const r = rowOf(site.id);
	if (!r) return null;
	if (!r.fetched_at) return { fetchedAt: null, error: r.error, errorAt: r.error_at, report: null };
	const s = JSON.parse(r.payload) as Stored;
	const dead = new Set((s.issues ?? []).filter((i) => kindOfCode(i.httpCode) === 'gone' || kindOfCode(i.httpCode) === 'error').map((i) => normalizeUrl(i.url)));
	const p = periodFor(site, days);
	const live = (db().prepare('SELECT page, SUM(clicks) c, SUM(impressions) i FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY page HAVING SUM(impressions) > 0 ORDER BY i DESC LIMIT 300').all(site.id, p.start, p.end) as { page: string; c: number; i: number }[])
		.filter((x) => !dead.has(normalizeUrl(x.page))).map((x) => ({ url: x.page, clicks: x.c, impressions: x.i }));
	return { fetchedAt: r.fetched_at, error: r.error, errorAt: r.error_at, report: analyseBingLinks(s.counts ?? [], s.issues ?? [], live, { pagesWithLinks: s.pagesWithLinks, links: s.links, truncated: s.truncated }) };
}

export const logBingLinks = (siteId: number, detail: string) => audit('bing.links', { siteId, detail });
