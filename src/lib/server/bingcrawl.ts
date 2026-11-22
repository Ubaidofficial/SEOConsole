import { db } from './db';
import type { BingCrawlClient, BingCrawlDay, BingFeed } from './bing';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * Bing's crawl statistics and the sitemaps it knows, read at the end of every Bing sync with the key the site already has. Each is
 * extra data: a failure is recorded on the site, keeps the previous rows, and never fails the sync. A client without these methods
 * (an older test double) is skipped. Never throws.
 */
export async function syncBingExtras(siteId: number, siteUrl: string, client: Partial<BingCrawlClient>): Promise<{ crawl: boolean; feeds: boolean }> {
	const d = db();
	const out = { crawl: false, feeds: false };
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
			const ins = d.prepare('INSERT OR REPLACE INTO bing_feeds VALUES (?,?,?,?,?,?,?)');
			d.transaction(() => {
				d.prepare('DELETE FROM bing_feeds WHERE site_id = ?').run(siteId);
				for (const f of feeds) ins.run(siteId, f.url, f.type, f.status, f.urlCount, f.submitted, f.lastCrawled);
				d.prepare('UPDATE sites SET bing_feeds_error = NULL WHERE id = ?').run(siteId);
			})();
			out.feeds = true;
		} catch (e) {
			d.prepare('UPDATE sites SET bing_feeds_error = ? WHERE id = ?').run(msg(e), siteId);
		}
	}
	d.prepare('UPDATE sites SET bing_extras_at = ? WHERE id = ?').run(Date.now(), siteId);
	return out;
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
		feeds
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
