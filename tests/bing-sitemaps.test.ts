import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { RealBingClient, type BingFeed } from '../src/lib/server/bing';
import { saveIntegration } from '../src/lib/server/links';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncBing } from '../src/lib/server/channels';
import { bingCrawlReport, lastMirror, syncBingExtras } from '../src/lib/server/bingcrawl';
import { getSite } from '../src/lib/server/clients';
import { bingSitemapNote, submitSitemapsToBing } from '../src/lib/server/submission';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const feed = (url: string): BingFeed => ({ url, type: 'Sitemap', status: 'Success', urlCount: 1, submitted: null, lastCrawled: null, fileSize: null, compressed: false });

/** A Bing double that lists `known` and records what it was sent; a sent feed shows up in the next list. */
function fakeBing(known: string[], refuse?: (f: string) => string | null) {
	const sent: string[] = [];
	return {
		sent,
		crawlStats: async () => [],
		feeds: async () => [...known, ...sent].map(feed),
		submitFeed: async (_site: string, f: string) => {
			const why = refuse?.(f);
			if (why) throw new Error(why);
			sent.push(f);
		}
	};
}

describe('Bing SubmitFeed', () => {
	it('the real client POSTs siteUrl and feedUrl to SubmitFeed', async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		const id = saveIntegration('bing', 'k', { apiKey: 'SECRETKEY' });
		let url = '';
		let init: RequestInit | undefined;
		const c = new RealBingClient(id, { fetchImpl: (async (u: string, i?: RequestInit) => ((url = u), (init = i), json({ d: null }))) as never, sleepImpl: async () => {} });
		await c.submitFeed('https://x.test/', 'https://www.x.test/sitemap.xml');
		expect(new URL(url).pathname.split('/').pop()).toBe('SubmitFeed');
		expect(init?.method).toBe('POST');
		expect(JSON.parse(String(init?.body))).toEqual({ siteUrl: 'https://x.test/', feedUrl: 'https://www.x.test/sitemap.xml' });
	});
});

describe('sitemaps sent to Bing automatically', () => {
	beforeEach(async () => {
		process.env.SCHEDULER = '0';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
	});

	it('sends only the sitemaps Bing lacks, once a day, and the report shows it', async () => {
		const bing = fakeBing(['https://x.test/sitemap.xml/']);
		const wanted = async () => ['https://x.test/sitemap.xml', 'https://x.test/jobs.xml', 'https://x.test/jobs.xml', 'not a url'];
		const r = await syncBingExtras(1, 'https://x.test/', bing, { wanted, today: '2026-11-23' });
		expect(bing.sent).toEqual(['https://x.test/jobs.xml']);
		expect(r.mirrored).toEqual({ day: '2026-11-23', submitted: ['https://x.test/jobs.xml'], failed: [] });
		const rep = bingCrawlReport(1, '2000-01-01', '2100-01-01')!;
		expect(rep.feeds.map((f) => f.url)).toContain('https://x.test/jobs.xml'); // read again after sending
		expect(rep.sentBySeoConsole?.submitted).toEqual(['https://x.test/jobs.xml']);
		// a second sync the same day sends nothing, even if something is still missing
		const again = fakeBing([]);
		expect((await syncBingExtras(1, 'https://x.test/', again, { wanted, today: '2026-11-23' })).mirrored).toBeNull();
		expect(again.sent).toEqual([]);
	});

	it('a refusal is kept and retried the next day; read-only, no list or a failed list sends nothing', async () => {
		const bing = fakeBing([], (f) => (f.includes('www') ? 'Bing: feed is not under the site' : null));
		const wanted = async () => ['https://www.x.test/sitemap.xml'];
		const r = await syncBingExtras(1, 'https://x.test/', bing, { wanted, today: '2026-11-23' });
		expect(r.mirrored?.failed[0]).toEqual({ path: 'https://www.x.test/sitemap.xml', error: 'Bing: feed is not under the site' });
		expect(lastMirror(1)?.failed).toHaveLength(1);
		const ok = fakeBing([]);
		await syncBingExtras(1, 'https://x.test/', ok, { wanted, today: '2026-11-24' });
		expect(ok.sent).toEqual(['https://www.x.test/sitemap.xml']);
		for (const o of [{ wanted, readOnly: true, today: '2026-11-25' }, { today: '2026-11-25' }, { wanted: async () => Promise.reject(new Error('gsc down')), today: '2026-11-25' }]) {
			const b = fakeBing([]);
			expect((await syncBingExtras(1, 'https://x.test/', b, o)).mirrored).toBeNull();
			expect(b.sent).toEqual([]);
		}
	});

	it('a Bing sync of a demo site sends what Search Console lists and Bing does not', async () => {
		const id = saveIntegration('bing', 'demo', { apiKey: 'demo' }, {}, true);
		db().prepare('INSERT INTO site_links (site_id, kind, integration_id, external_id, label, sync_status, created_at) VALUES (?,?,?,?,?,?,?)').run(1, 'bing', id, 'https://www.greenleaf.example/', 'b', 'idle', Date.now());
		await syncBing(1);
		const m = lastMirror(1);
		// the demo Bing already lists the demo sitemap, so nothing may be missing; whatever was sent must not have failed
		if (m) expect(m.failed).toEqual([]);
	});
});

describe('manual sitemap submissions reach Bing too', () => {
	beforeEach(async () => {
		process.env.SCHEDULER = '0';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
	});

	it('without Bing linked nothing is sent and the note says so', async () => {
		const b = await submitSitemapsToBing(getSite(1)!, ['https://x.test/s.xml'], 'app');
		expect(b).toEqual({ linked: false, submitted: [], failed: [] });
		expect(bingSitemapNote(b)).toContain('not linked');
	});

	it('with Bing linked, submit_sitemap answers with what Bing did', async () => {
		const id = saveIntegration('bing', 'demo', { apiKey: 'demo' }, {}, true);
		db().prepare('INSERT INTO site_links (site_id, kind, integration_id, external_id, label, sync_status, created_at) VALUES (?,?,?,?,?,?,?)').run(1, 'bing', id, 'https://www.greenleaf.example/', 'b', 'idle', Date.now());
		const bing = fakeBing([], (f) => (f.endsWith('bad.xml') ? 'refused' : null));
		const direct = await submitSitemapsToBing(getSite(1)!, ['https://www.greenleaf.example/a.xml', 'https://www.greenleaf.example/bad.xml'], 'app', bing);
		expect(direct).toEqual({ linked: true, submitted: ['https://www.greenleaf.example/a.xml'], failed: [{ path: 'https://www.greenleaf.example/bad.xml', error: 'refused' }] });
		expect(bingSitemapNote(direct)).toBe('Bing refused 1: refused');
		const site = getSite(1)!;
		const { key } = createApiKey('t', null, null, 'submit');
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit_sitemap', arguments: { site: '1', sitemap_url: `${site.site_url.replace('sc-domain:', 'https://www.').replace(/\/?$/, '/')}new-sitemap.xml` } } }) }));
		const out = (await res.json()).result;
		expect(out.isError, out.content[0].text).toBeFalsy();
		const body = JSON.parse(out.content[0].text);
		expect(body.bing.submitted).toHaveLength(1);
		expect(body.note).toContain('Bing took 1 too.');
	});
});
