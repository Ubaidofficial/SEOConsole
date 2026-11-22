import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { RealBingClient, optBingDate, parseCrawlStats, parseFeeds } from '../src/lib/server/bing';
import { saveIntegration } from '../src/lib/server/links';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { DemoBing } from '../src/lib/server/demo-channels';
import { syncBing } from '../src/lib/server/channels';
import { bingCrawlReport, bingPageQueries, syncBingExtras } from '../src/lib/server/bingcrawl';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Shaped like Microsoft's GetCrawlStats sample (CrawlStats class property names). */
const MS_CRAWL = [
	{ Date: '/Date(1763452800000-0800)/', AllOtherCodes: 0, BlockedByRobotsTxt: 2, Code2xx: 90, Code301: 3, Code302: 1, Code4xx: 4, Code5xx: 2, ConnectionTimeout: 0, ContainsMalware: 0, CrawlErrors: 6, CrawledPages: 100, DnsFailures: 0, InIndex: 500, InLinks: 40 },
	{ Date: '/Date(1763366400000-0800)/', AllOtherCodes: 0, BlockedByRobotsTxt: 2, Code2xx: 50, Code301: 0, Code302: 0, Code4xx: 0, Code5xx: 0, CrawlErrors: 0, CrawledPages: 50, InIndex: 480, InLinks: 40 }
];
const MS_FEEDS = [
	{ Compressed: false, FileSize: 1200, LastCrawled: '/Date(1763452800000-0800)/', Status: 'Success', Submitted: '/Date(1700000000000-0800)/', Type: 'Sitemap', Url: 'https://x.test/sitemap.xml', UrlCount: 120 },
	{ Compressed: false, FileSize: 0, LastCrawled: '/Date(-62135596800000)/', Status: 'Pending', Submitted: '/Date(1763452800000-0800)/', Type: 'Sitemap', Url: 'https://x.test/new.xml', UrlCount: 0 }
];

describe('parsing Bing crawl stats and feeds', () => {
	it('maps Microsoft\'s field names, sorts days, and reads Bing\'s "never" date as null', () => {
		const days = parseCrawlStats(MS_CRAWL);
		expect(days.map((d) => d.date)).toEqual(['2025-11-17', '2025-11-18']);
		expect(days[1]).toMatchObject({ crawled: 100, crawlErrors: 6, inIndex: 500, code4xx: 4, code5xx: 2, blockedByRobots: 2, dnsFailures: 0, timeouts: 0 });
		const feeds = parseFeeds(MS_FEEDS);
		expect(feeds[0]).toMatchObject({ url: 'https://x.test/sitemap.xml', status: 'Success', urlCount: 120, lastCrawled: '2025-11-18' });
		expect(feeds[1].lastCrawled).toBeNull();
		expect(optBingDate('garbage')).toBeNull();
		expect(parseCrawlStats(null)).toEqual([]);
	});

	it('the real client calls GetCrawlStats, GetFeeds and GetPageQueryStats with the documented parameters', async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		const id = saveIntegration('bing', 'k', { apiKey: 'SECRETKEY' });
		const calls: string[] = [];
		const answer = (u: string) => {
			const m = new URL(u).pathname.split('/').pop();
			if (m === 'GetCrawlStats') return json({ d: MS_CRAWL });
			if (m === 'GetFeeds') return json({ d: MS_FEEDS });
			return json({ d: [{ Date: '/Date(1763452800000-0800)/', Query: 'garden tools', Clicks: 3, Impressions: 40, AvgClickPosition: 2, AvgImpressionPosition: 4 }] });
		};
		const c = new RealBingClient(id, { fetchImpl: (async (u: string) => (calls.push(u), answer(u))) as never, sleepImpl: async () => {} });
		expect(await c.crawlStats('https://x.test/')).toHaveLength(2);
		expect(await c.feeds('https://x.test/')).toHaveLength(2);
		const q = await c.pageQueryStats('https://x.test/', 'https://x.test/a');
		expect(q[0]).toMatchObject({ term: 'garden tools', clicks: 3, imprPos: 4 });
		const u = calls.map((x) => new URL(x));
		expect(u.map((x) => x.pathname.split('/').pop())).toEqual(['GetCrawlStats', 'GetFeeds', 'GetPageQueryStats']);
		expect(u[2].searchParams.get('siteUrl')).toBe('https://x.test/');
		expect(u[2].searchParams.get('page')).toBe('https://x.test/a');
	});
});

describe('storing and reporting', () => {
	let siteId = 1;
	beforeEach(async () => {
		process.env.SCHEDULER = '0';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
		siteId = 1;
		const id = saveIntegration('bing', 'demo', { apiKey: 'demo' }, {}, true);
		db().prepare('INSERT INTO site_links (site_id, kind, integration_id, external_id, label, sync_status, created_at) VALUES (?,?,?,?,?,?,?)').run(siteId, 'bing', id, 'https://www.greenleaf.example/', 'b', 'idle', Date.now());
	});

	it('a Bing sync stores crawl stats and sitemaps; the report sums the window', async () => {
		await syncBing(siteId);
		const c = bingCrawlReport(siteId, '2000-01-01', '2100-01-01')!;
		expect(c.crawlError).toBeNull();
		expect(c.days.length).toBeGreaterThan(150);
		expect(c.totals!.crawled).toBe(c.days.reduce((a, d) => a + d.crawled, 0));
		expect(c.totals!.inIndex).toBe(c.days.at(-1)!.inIndex);
		expect(c.totals!.inIndexBefore).toBe(c.days[0].inIndex);
		expect(c.totals!.codes['5xx']).toBeGreaterThan(0);
		expect(c.feeds.map((f) => f.status)).toEqual(['Failed', 'Success']);
	});

	it('a failure keeps the previous rows and is shown; a client without the methods is skipped', async () => {
		await syncBingExtras(siteId, 'x', new DemoBing());
		const before = bingCrawlReport(siteId, '2000-01-01', '2100-01-01')!.days.length;
		const r = await syncBingExtras(siteId, 'x', { crawlStats: async () => Promise.reject(new Error('Bing API 500')), feeds: async () => [] });
		expect(r).toEqual({ crawl: false, feeds: true });
		const c = bingCrawlReport(siteId, '2000-01-01', '2100-01-01')!;
		expect(c.crawlError).toBe('Bing API 500');
		expect(c.days.length).toBe(before);
		expect(c.feeds).toEqual([]);
		expect(await syncBingExtras(siteId, 'x', {})).toEqual({ crawl: false, feeds: false });
	});

	it('page queries are summed over the window, newest weeks only', async () => {
		const rows = [
			{ date: '2026-11-01', term: 'a', clicks: 2, impressions: 10, clickPos: 1, imprPos: 2 },
			{ date: '2026-11-08', term: 'a', clicks: 3, impressions: 30, clickPos: 1, imprPos: 4 },
			{ date: '2026-01-01', term: 'old', clicks: 9, impressions: 90, clickPos: 1, imprPos: 1 }
		];
		const r = await bingPageQueries({ pageQueryStats: async () => rows }, 'x', 'https://x.test/a', '2026-10-25', '2026-11-20');
		expect(r.queries).toEqual([{ query: 'a', clicks: 5, impressions: 40, ctr: 5 / 40, position: 3.5 }]);
		expect(r.weeksInBing).toBe(3);
		await expect(bingPageQueries({}, 'x', 'y', 'a', 'b')).rejects.toThrow('cannot read queries per page');
	});

	it('get_bing_performance views crawl and page_queries', async () => {
		await syncBing(siteId);
		const { key } = createApiKey('t', null);
		const call = async (args: object) => {
			const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_bing_performance', arguments: { site: String(siteId), ...args } } }) }));
			return (await res.json()).result;
		};
		const crawl = await call({ view: 'crawl', days: 90 });
		expect(crawl.isError, crawl.content[0].text).toBeFalsy();
		const body = JSON.parse(crawl.content[0].text);
		expect(body.totals.crawled).toBeGreaterThan(0);
		expect(body.sitemaps).toHaveLength(2);
		const pq = await call({ view: 'page_queries', page: 'https://www.greenleaf.example/blog/x', days: 480 });
		expect(pq.isError, pq.content[0].text).toBeFalsy();
		expect(JSON.parse(pq.content[0].text).queries.length).toBeGreaterThan(0);
		const bad = await call({ view: 'page_queries', page: 'not a url' });
		expect(bad.isError).toBe(true);
	});
});
