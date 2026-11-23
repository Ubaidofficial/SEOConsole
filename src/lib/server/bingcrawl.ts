import { audit, db } from './db';
import { pacificToday } from './dates';
import type { BingCrawlClient, BingCrawlDay, BingFeed } from './bing';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * Bing's crawl statistics and the sitemaps it knows, read at the end of every Bing sync with the key the site already has. Each is
 * extra data: a failure is recorded on the site, keeps the previous rows, and never fails the sync. A client without these methods
 * (an older test double) is skipped. Never throws.
 */
export async function syncBingExtras(siteId: number, siteUrl: string, client: Partial<BingCrawlClient>, o: MirrorOpts = {}): Promise<{ crawl: boolean; feeds: boolean; mirrored: MirrorResult | null }> {
	const d = db();
	const out: { crawl: boolean; feeds: boolean; mirrored: MirrorResult | null } = { crawl: false, feeds: false, mirrored: null };
	if (typeof client.crawlStats !== 'function' && typeof client.feeds !== 'function') return out;
	if (typeof client.crawlStats === 'function') {
		try {
			const days = await client.crawlStats(siteUrl);
			const ins = d.prepare('INSERT OR REPLACE INTO bing_crawl VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
			d.transaction(() => {
				d.prepare('DELETE FROM bing_crawl WHERE site_id = ?').run(siteId);
				for (const r of days) ins.run(siteId, r.date, r.crawled, r.crawlErrors, r.inIndex, r.inLinks, r.code2xx, r.code301, r.code302, r.code4xx, r.code5xx, r.otherCodes, r.blockedByRobots, r.malware, r.dnsFailures, r.timeouts);
				d.prepare('UPDATE sites SET bing_crawl_error = NULL WHERE id = ?').run(siteId);
			})();
			out.crawl = true;
		} catch (e) {
			d.prepare('UPDATE sites SET bing_crawl_error = ? WHERE id = ?').run(msg(e), siteId);
		}
	}
	if (typeof client.feeds === 'function') {
		try {
			const feeds = await client.feeds(siteUrl);
			storeFeeds(siteId, feeds);
			out.feeds = true;
			out.mirrored = await mirrorSitemapsToBing(siteId, siteUrl, client, feeds, o);
			// Bing lists what was just sent once it has taken it: read again so the table shows it today rather than tomorrow.
			if (out.mirrored?.submitted.length) storeFeeds(siteId, await client.feeds(siteUrl).catch(() => feeds));
		} catch (e) {
			d.prepare('UPDATE sites SET bing_feeds_error = ? WHERE id = ?').run(msg(e), siteId);
		}
	}
	d.prepare('UPDATE sites SET bing_extras_at = ? WHERE id = ?').run(Date.now(), siteId);
	return out;
}

function storeFeeds(siteId: number, feeds: BingFeed[]) {
	const d = db();
	const ins = d.prepare('INSERT OR REPLACE INTO bing_feeds VALUES (?,?,?,?,?,?,?)');
	d.transaction(() => {
		d.prepare('DELETE FROM bing_feeds WHERE site_id = ?').run(siteId);
		for (const f of feeds) ins.run(siteId, f.url, f.type, f.status, f.urlCount, f.submitted, f.lastCrawled);
		d.prepare('UPDATE sites SET bing_feeds_error = NULL WHERE id = ?').run(siteId);
	})();
}

export type MirrorResult = { day: string; submitted: string[]; failed: { path: string; error: string }[] };
export type MirrorOpts = {
	/** The site's sitemaps: what Search Console lists, or what a read found on the site. Without it nothing is sent. */
	wanted?: () => Promise<string[]>;
	today?: string;
	readOnly?: boolean;
};
const mirrorKey = (siteId: number) => `bing_sitemap_mirror:${siteId}`;
const sameFeed = (a: string, b: string) => a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();

/** Send sitemaps to Bing one by one (SubmitFeed). Never throws: each refusal is returned with Bing's message. */
export async function sendFeeds(client: Partial<BingCrawlClient>, siteUrl: string, feeds: string[]): Promise<{ submitted: string[]; failed: { path: string; error: string }[] }> {
	const submitted: string[] = [];
	const failed: { path: string; error: string }[] = [];
	for (const f of feeds) {
		if (typeof client.submitFeed !== 'function') {
			failed.push({ path: f, error: 'This Bing connection cannot submit sitemaps.' });
			continue;
		}
		try {
			await client.submitFeed(siteUrl, f);
			submitted.push(f);
		} catch (e) {
			failed.push({ path: f, error: msg(e) });
		}
	}
	return { submitted, failed };
}

/**
 * Give Bing the sitemaps the site already has in Search Console (or, when Search Console lists none, the ones found on the site) that
 * Bing does not list yet. Automatic for every site with Bing linked: these are the owner's own sitemaps, already public in robots.txt
 * or submitted to Google. At most one try a day per site, so a refusal is retried the next day, not on every sync. The outcome is kept
 * and shown with Bing's sitemaps. Never throws.
 */
export async function mirrorSitemapsToBing(siteId: number, siteUrl: string, client: Partial<BingCrawlClient>, known: BingFeed[], o: MirrorOpts): Promise<MirrorResult | null> {
	if (!o.wanted || o.readOnly || typeof client.submitFeed !== 'function') return null;
	const today = o.today ?? pacificToday();
	if (lastMirror(siteId)?.day === today) return null;
	let wanted: string[];
	try {
		wanted = [...new Set((await o.wanted()).map((f) => f.trim()).filter((f) => /^https?:\/\/\S+$/i.test(f)))].slice(0, 10);
	} catch {
		return null; // Search Console could not be asked: try again on the next sync
	}
	const missing = wanted.filter((f) => !known.some((k) => sameFeed(k.url, f)));
	if (!missing.length) return null;
	const r: MirrorResult = { day: today, ...(await sendFeeds(client, siteUrl, missing)) };
	db().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(mirrorKey(siteId), JSON.stringify(r));
	if (r.submitted.length) audit('sitemap.bing', { siteId, detail: `${r.submitted.join(', ')} (auto)` });
	return r;
}

/** The last automatic sitemap submission to Bing for this site, if any. */
export function lastMirror(siteId: number): MirrorResult | null {
	const v = (db().prepare('SELECT value FROM kv WHERE key = ?').get(mirrorKey(siteId)) as { value: string } | undefined)?.value;
	try {
		return v ? JSON.parse(v) : null;
	} catch {
		return null;
	}
}

export type CrawlRow = BingCrawlDay;
type Row = { date: string; crawled: number; crawl_errors: number; in_index: number; in_links: number; code2xx: number; code301: number; code302: number; code4xx: number; code5xx: number; other_codes: number; blocked_robots: number; malware: number; dns_failures: number; timeouts: number };

/**
 * Bing's crawl over a window: pages crawled and crawl errors per day, the newest pages-in-index count against the first in the window,
 * and status codes summed. Null before the first read. Bing keeps about six months, so a longer window starts where Bing's data does.
 */
export function bingCrawlReport(siteId: number, start: string, end: string) {
	const d = db();
	const meta = d.prepare('SELECT bing_extras_at at, bing_crawl_error crawlError, bing_feeds_error feedsError FROM sites WHERE id = ?').get(siteId) as { at: number | null; crawlError: string | null; feedsError: string | null } | undefined;
	if (!meta?.at) return null;
	const rows = d.prepare('SELECT * FROM bing_crawl WHERE site_id = ? AND date BETWEEN ? AND ? ORDER BY date').all(siteId, start, end) as Row[];
	const sum = (k: keyof Row) => rows.reduce((a, r) => a + Number(r[k]), 0);
	const indexed = rows.filter((r) => r.in_index > 0);
	const feeds = (d.prepare('SELECT url, type, status, url_count urlCount, submitted, last_crawled lastCrawled FROM bing_feeds WHERE site_id = ? ORDER BY url').all(siteId) as Omit<BingFeed, 'fileSize' | 'compressed'>[]);
	return {
		fetchedAt: meta.at,
		crawlError: meta.crawlError,
		feedsError: meta.feedsError,
		days: rows.map((r) => ({ date: r.date, crawled: r.crawled, errors: r.crawl_errors, inIndex: r.in_index })),
		totals: rows.length
			? {
					crawled: sum('crawled'),
					crawlErrors: sum('crawl_errors'),
					inIndex: indexed.at(-1)?.in_index ?? null,
					inIndexBefore: indexed.length > 1 ? indexed[0].in_index : null,
					codes: { '2xx': sum('code2xx'), '301': sum('code301'), '302': sum('code302'), '4xx': sum('code4xx'), '5xx': sum('code5xx'), other: sum('other_codes') },
					blockedByRobots: sum('blocked_robots'),
					dnsFailures: sum('dns_failures'),
					timeouts: sum('timeouts'),
					malware: sum('malware')
				}
			: null,
		feeds,
		sentBySeoConsole: lastMirror(siteId)
	};
}

/**
 * The searches that showed one page on Bing, read live (GetPageQueryStats; Bing updates it weekly, so rows are weekly) and summed over
 * the window. Nothing is stored. Throws BingApiError when Bing refuses, or an Error when the connection cannot read per-page queries.
 */
export async function bingPageQueries(client: Partial<BingCrawlClient>, siteUrl: string, page: string, start: string, end: string) {
	if (typeof client.pageQueryStats !== 'function') throw new Error('This Bing connection cannot read queries per page.');
	const rows = await client.pageQueryStats(siteUrl, page);
	const by = new Map<string, { query: string; clicks: number; impressions: number; posWeight: number; posImpr: number }>();
	for (const r of rows) {
		if (r.date < start || r.date > end) continue;
		const cur = by.get(r.term) ?? { query: r.term, clicks: 0, impressions: 0, posWeight: 0, posImpr: 0 };
		cur.clicks += r.clicks;
		cur.impressions += r.impressions;
		if (r.imprPos != null) (cur.posWeight += r.imprPos * r.impressions), (cur.posImpr += r.impressions);
		by.set(r.term, cur);
	}
	return {
		page,
		weeksInBing: new Set(rows.map((r) => r.date)).size,
		queries: [...by.values()]
			.map((q) => ({ query: q.query, clicks: q.clicks, impressions: q.impressions, ctr: q.impressions ? q.clicks / q.impressions : 0, position: q.posImpr ? q.posWeight / q.posImpr : null }))
			.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
	};
}
