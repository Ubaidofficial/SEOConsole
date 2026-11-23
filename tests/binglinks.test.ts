import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { RealBingClient, type BingLinksClient } from '../src/lib/server/bing';
import { saveIntegration, linksFor } from '../src/lib/server/links';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { DemoBing } from '../src/lib/server/demo-channels';
import { LINKS_EVERY_MS, bingDeadPages, bingLinksDue, bingLinksFor, syncBingLinks } from '../src/lib/server/binglinks';
import { actionsFor } from '../src/lib/server/actions';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';
import { analyseBingLinks, kindOfCode, parseCrawlIssues, parseLinkCounts, parseUrlLinks } from '../src/lib/binglinks';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Microsoft's own sample answers (Microsoft Learn, IWebmasterApi, read 2026-11-15), unwrapped from the "d" the client already strips.
const MS_LINK_COUNTS = { __type: 'LinkCounts:#Microsoft.Bing.Webmaster.Api', Links: [{ __type: 'LinkCount:#Microsoft.Bing.Webmaster.Api', Count: 14, Url: 'http://example.com/page1.html' }], TotalPages: 3 };
const MS_URL_LINKS = { __type: 'LinkDetails:#Microsoft.Bing.Webmaster.Api', Details: [{ __type: 'LinkDetail:#Microsoft.Bing.Webmaster.Api', AnchorText: 'link', Url: 'http://example.com/page1.html' }], TotalPages: 3 };
const MS_CRAWL_ISSUES = [{ __type: 'UrlWithCrawlIssues:#Microsoft.Bing.Webmaster.Api', HttpCode: 200, Issues: 32, Url: 'http://example.com/url1.htm', InLinks: 10 }];

describe('parsing Microsoft\'s documented shapes', () => {
	it('link counts', () => expect(parseLinkCounts(MS_LINK_COUNTS)).toEqual({ links: [{ url: 'http://example.com/page1.html', count: 14 }], totalPages: 3 }));
	it('url links', () => expect(parseUrlLinks(MS_URL_LINKS)).toEqual({ sources: [{ url: 'http://example.com/page1.html', anchor: 'link' }], totalPages: 3 }));
	it('crawl issues', () => expect(parseCrawlIssues(MS_CRAWL_ISSUES)).toEqual([{ url: 'http://example.com/url1.htm', httpCode: 200, issues: 32, inLinks: 10 }]));
	it('survive nonsense', () => {
		expect(parseLinkCounts(null)).toEqual({ links: [], totalPages: 1 });
		expect(parseLinkCounts({ Links: [{ Count: 'x' }, { Url: 'u', Count: -3 }], TotalPages: 'many' })).toEqual({ links: [{ url: 'u', count: 0 }], totalPages: 1 });
		expect(parseCrawlIssues('no')).toEqual([]);
		expect(parseUrlLinks({})).toEqual({ sources: [], totalPages: 0 });
	});
});

describe('what an HTTP code means', () => {
	it('separates gone, server error and blocked, and ignores the rest', () => {
		expect([404, 410, 400, 451].map(kindOfCode)).toEqual(['gone', 'gone', 'gone', 'gone']);
		expect([500, 503].map(kindOfCode)).toEqual(['error', 'error']);
		expect([401, 403, 429].map(kindOfCode)).toEqual(['blocked', 'blocked', 'blocked']);
		expect([200, 301, 408, 0].map(kindOfCode)).toEqual([null, null, null, null]);
	});
});

describe('analyseBingLinks', () => {
	const live = [{ url: 'https://x.test/lists/best-self-help-books', clicks: 4, impressions: 300 }, { url: 'https://x.test/people/tim', clicks: 1, impressions: 40 }];
	const counts = [{ url: 'https://www.x.test/lists/best-self-help-book/', count: 6 }, { url: 'https://x.test/', count: 30 }];
	const issues = [
		{ url: 'https://x.test/lists/best-self-help-book', httpCode: 404, issues: 1, inLinks: 2 }, // the link list says 6: the larger wins, URL variants match
		{ url: 'https://x.test/gone-nobody-links', httpCode: 404, issues: 1, inLinks: 0 },
		{ url: 'https://x.test/checkout', httpCode: 503, issues: 2, inLinks: 3 },
		{ url: 'https://x.test/members', httpCode: 403, issues: 4, inLinks: 5 },
		{ url: 'https://x.test/fine', httpCode: 200, issues: 8, inLinks: 9 },
		{ url: 'https://x.test/hacked', httpCode: 200, issues: 32, inLinks: 1 },
		{ url: 'https://x.test/lists/best-self-help-book/', httpCode: 404, issues: 1, inLinks: 1 } // the same page again
	];
	const r = analyseBingLinks(counts, issues, live);
	it('lists failing pages that still have links, most first, taking the larger count and counting each page once', () => {
		expect(r.dead.map((d) => [d.url, d.kind, d.inLinks])).toEqual([['https://x.test/lists/best-self-help-book', 'gone', 6], ['https://x.test/checkout', 'error', 3]]);
	});
	it('suggests the closest live page for a gone page only', () => {
		expect(r.dead[0].redirectTo).toBe('https://x.test/lists/best-self-help-books');
		expect(r.dead[0].match).toBeGreaterThan(0.5);
		expect(r.dead[1].redirectTo).toBeNull();
	});
	it('does not list a dead page nobody links to, a blocked page or a healthy one, but counts them by kind', () => {
		expect(r.dead.some((d) => /nobody|members|fine/.test(d.url))).toBe(false);
		expect(r.issueCounts).toEqual({ gone: 3, error: 1, blocked: 1, malware: 1 });
	});
	it('puts malware first in the headline, and reports the most-linked pages', () => {
		expect(r.malware).toEqual(['https://x.test/hacked']);
		expect(r.headline).toMatch(/malware/);
		expect(r.mostLinked[0]).toEqual({ url: 'https://x.test/', count: 30 });
		expect(r.totals).toEqual({ pagesWithLinks: 2, links: 36, truncated: false });
	});
	it('has honest headlines when there is nothing wrong, or nothing at all', () => {
		expect(analyseBingLinks(counts, [], live).headline).toMatch(/Bing knows 36 inbound links to 2 of your pages, and none of the pages it found failing has any/);
		expect(analyseBingLinks([], [], live).headline).toBe('Bing has no inbound links on record for this site yet.');
	});
});

describe('RealBingClient: the three link methods', () => {
	beforeEach(() => { globalThis.__openSiteConsoleDb = openDb(':memory:'); });
	const mk = (f: (url: string) => Response) => {
		const id = saveIntegration('bing', 'k', { apiKey: 'SECRETKEY' });
		const calls: string[] = [];
		const client = new RealBingClient(id, { fetchImpl: (async (u: string) => (calls.push(u), f(u))) as never, sleepImpl: async () => {} });
		return { client, calls };
	};
	it('reads every result page of GetLinkCounts, numbered from 0, and stops at the cap', async () => {
		const { client, calls } = mk((u) => json({ d: { Links: [{ Url: `http://x.test/p${new URL(u).searchParams.get('page')}`, Count: 2 }], TotalPages: 3 } }));
		const r = await client.linkCounts('http://x.test/');
		expect(r.links.map((l) => l.url)).toEqual(['http://x.test/p0', 'http://x.test/p1', 'http://x.test/p2']);
		expect(calls.map((c) => new URL(c).searchParams.get('page'))).toEqual(['0', '1', '2']);
		expect(calls[0]).toContain('https://ssl.bing.com/webmaster/api.svc/json/GetLinkCounts?');
		expect(new URL(calls[0]).searchParams.get('siteUrl')).toBe('http://x.test/');
		expect(r.truncated).toBe(false);
		const big = mk(() => json({ d: { Links: [{ Url: 'http://x.test/a', Count: 1 }], TotalPages: 99 } }));
		const t = await big.client.linkCounts('http://x.test/', 4);
		expect(big.calls).toHaveLength(4);
		expect(t).toMatchObject({ totalPages: 99, truncated: true });
	});
	it('GetUrlLinks sends the link as a JSON string literal first, as Microsoft\'s sample does, then the plain address if that finds nothing', async () => {
		const { client, calls } = mk((u) => json({ d: { Details: new URL(u).searchParams.get('link')!.startsWith('"') ? [] : [{ Url: 'http://blog.test/a', AnchorText: 'tools' }], TotalPages: 1 } }));
		const r = await client.urlLinks('http://x.test/', 'http://x.test/old');
		expect(r).toEqual([{ url: 'http://blog.test/a', anchor: 'tools' }]);
		expect(new URL(calls[0]).searchParams.get('link')).toBe('"http://x.test/old"');
		expect(new URL(calls[1]).searchParams.get('link')).toBe('http://x.test/old');
	});
	it('GetCrawlIssues is one call with just the site, and the key never appears in an error', async () => {
		const { client, calls } = mk(() => json({ d: MS_CRAWL_ISSUES }));
		expect(await client.crawlIssues('http://x.test/')).toHaveLength(1);
		expect(new URL(calls[0]).searchParams.get('siteUrl')).toBe('http://x.test/');
		const bad = mk(() => json({ ErrorCode: 3, Message: 'InvalidApiKey' }, 400));
		const e = (await bad.client.crawlIssues('http://x.test/').catch((x) => x)) as Error;
		expect(e.message).not.toContain('SECRETKEY');
	});
});

describe('storing it', () => {
	const siteId = 1;
	beforeEach(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
		await syncSite(1, { client: new DemoClient('demo-a'), mode: 'incremental' });
		const id = saveIntegration('bing', 'demo', { apiKey: 'demo' });
		db().prepare('INSERT INTO site_links (site_id, kind, integration_id, external_id, label, sync_status, created_at) VALUES (?,?,?,?,?,?,?)').run(siteId, 'bing', id, 'https://www.greenleaf.example/', 'b', 'idle', Date.now());
	});
	const link = () => linksFor(siteId).bing!;

	it('reads with the demo client, keeps it, and analyses it against what the site earns', async () => {
		expect(link().external_id).toBe('https://www.greenleaf.example/');
		const r = await syncBingLinks(siteId, new DemoBing());
		expect(r).toMatchObject({ ok: true });
		const b = bingLinksFor(getSite(siteId)!)!;
		expect(b.error).toBeNull();
		expect(b.report!.dead.map((d) => d.url.replace(/^https?:\/\/[^/]+/, ''))).toEqual(expect.arrayContaining(['/discontinued-guide', '/old-products/legacy-kit', '/checkout']));
		expect(b.report!.dead.find((d) => d.url.endsWith('/discontinued-guide'))!.inLinks).toBeGreaterThanOrEqual(2);
		expect(b.report!.issueCounts.blocked).toBe(1);
		expect(bingDeadPages(siteId).size).toBe(3); // 404, 410 and the page nobody links to: "gone", for other features
	});
	it('a failed read keeps the last good data and says why; the key never reaches the message', async () => {
		await syncBingLinks(siteId, new DemoBing(), 1000);
		const before = bingLinksFor(getSite(siteId)!)!.report!.totals;
		const failing: BingLinksClient = { linkCounts: async () => { throw new Error('Bing API 500'); }, urlLinks: async () => [], crawlIssues: async () => [] };
		expect(await syncBingLinks(siteId, failing, 2000)).toMatchObject({ ok: false, error: 'Bing API 500' });
		const after = bingLinksFor(getSite(siteId)!)!;
		expect(after.error).toBe('Bing API 500');
		expect(after.report!.totals).toEqual(before);
	});
	it('a site that never read successfully has the error and no report', async () => {
		const failing: BingLinksClient = { linkCounts: async () => { throw new Error('nope'); }, urlLinks: async () => [], crawlIssues: async () => [] };
		await syncBingLinks(siteId, failing);
		expect(bingLinksFor(getSite(siteId)!)).toMatchObject({ fetchedAt: null, error: 'nope', report: null });
		expect(bingDeadPages(siteId).size).toBe(0);
	});
	it('reads weekly, retries a failure only after a day, and skips a client that has no link methods', async () => {
		const t0 = 1_800_000_000_000;
		expect(bingLinksDue(siteId, t0)).toBe(true);
		await syncBingLinks(siteId, new DemoBing(), t0);
		expect(bingLinksDue(siteId, t0 + LINKS_EVERY_MS - 1000)).toBe(false);
		expect(bingLinksDue(siteId, t0 + LINKS_EVERY_MS + 1000)).toBe(true);
		const failing: BingLinksClient = { linkCounts: async () => { throw new Error('x'); }, urlLinks: async () => [], crawlIssues: async () => [] };
		await syncBingLinks(siteId, failing, t0 + LINKS_EVERY_MS + 1000);
		expect(bingLinksDue(siteId, t0 + LINKS_EVERY_MS + 3_600_000)).toBe(false);
		expect(bingLinksDue(siteId, t0 + LINKS_EVERY_MS + 90_000_000)).toBe(true);
		expect(await syncBingLinks(siteId, {})).toMatchObject({ ok: false, error: expect.stringMatching(/cannot read link data/) });
	});
	it('a site that is not linked to Bing is refused', async () => {
		db().prepare('DELETE FROM site_links WHERE site_id = ?').run(siteId);
		expect(await syncBingLinks(siteId, new DemoBing())).toMatchObject({ ok: false });
	});

	it('the action queue lists the dead pages that still have links, links to the Bing tab, and lists nothing without data', async () => {
		expect(actionsFor(getSite(siteId)!).some((a) => a.type === 'reclaim')).toBe(false);
		await syncBingLinks(siteId, new DemoBing());
		const item = actionsFor(getSite(siteId)!).find((a) => a.type === 'reclaim')!;
		expect(item).toBeTruthy();
		expect(item.href).toMatch(/\/bing\?section=links#links$/);
		expect(item.title).toMatch(/no longer work/);
		expect(item.evidence.join(' ')).toMatch(/discontinued-guide/);
	});

	it('the MCP tool answers view=links from stored data, and says so when nothing is stored', async () => {
		const key = createApiKey('t', null).key;
		const call = async (args: object) => {
			const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_bing_performance', arguments: { site: String(siteId), ...args } } }) }));
			return JSON.parse((await res.json()).result.content[0].text);
		};
		expect(await call({ view: 'links' })).toMatchObject({ fetched: false });
		await syncBingLinks(siteId, new DemoBing());
		const r = await call({ view: 'links' });
		expect(r.dead.length).toBeGreaterThan(0);
		expect(r.note).toMatch(/Bing's view/);
		expect(await call({})).toHaveProperty('totals'); // the default view is unchanged
	});
});
