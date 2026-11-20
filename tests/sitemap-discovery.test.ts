import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { getSite } from '../src/lib/server/clients';
import { discoverSitemaps, foundSitemaps, syncSitemapUrls } from '../src/lib/server/sitemapcov';
import { autoSubmitFoundSitemaps } from '../src/lib/server/submission';
import type { GscClient } from '../src/lib/server/google';

const SITE = 'sc-domain:x.example';
const xml = (urls: string[]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
const none: GscClient = { listSitemaps: async () => [] } as never;
const listed = (paths: string[]): GscClient => ({ listSitemaps: async () => paths.map((path) => ({ path })) }) as never;
/** A tiny web server: the files given, 404 for everything else; every address asked for is recorded. */
const serve = (files: Record<string, string>, calls: string[] = []) =>
	(async (u: string) => {
		calls.push(u);
		const f = files[u];
		return f === undefined ? new Response('nope', { status: 404 }) : new Response(f, { status: 200, headers: { 'content-type': u.endsWith('.txt') ? 'text/plain' : 'application/xml' } });
	}) as never;
const submitted = () => (db().prepare("SELECT detail FROM audit_log WHERE action = 'sitemap.submitted' ORDER BY id").all() as { detail: string }[]).map((r) => r.detail);

beforeEach(async () => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	await ensureDemoAccounts();
	db().prepare('UPDATE sites SET site_url = ? WHERE id = 1').run(SITE);
});
afterEach(() => delete process.env.READ_ONLY);

describe('finding a sitemap Search Console does not list', () => {
	it("takes robots.txt's Sitemap lines first, keeping only real sitemaps inside the property", async () => {
		const r = await discoverSitemaps(SITE, serve({
			'https://x.example/robots.txt': 'User-agent: *\nDisallow:\nSitemap: https://x.example/posts.xml\nsitemap:https://other.example/s.xml\nSitemap: https://x.example/broken.xml',
			'https://x.example/posts.xml': xml(['https://x.example/a']),
			'https://x.example/broken.xml': '<html>login</html>',
			'https://x.example/sitemap.xml': xml(['https://x.example/b'])
		}));
		expect(r).toEqual({ feeds: ['https://x.example/posts.xml'], from: 'robots' });
	});

	it('falls back to the usual addresses, on the www. host of a Domain property too', async () => {
		const calls: string[] = [];
		const r = await discoverSitemaps(SITE, serve({ 'https://www.x.example/wp-sitemap.xml': xml(['https://www.x.example/a']) }, calls));
		expect(r).toEqual({ feeds: ['https://www.x.example/wp-sitemap.xml'], from: 'usual' });
		expect(calls).toContain('https://x.example/sitemap.xml');
		expect(await discoverSitemaps(SITE, serve({}))).toEqual({ feeds: [], from: null });
	});

	it('looks only inside a URL-prefix property folder', async () => {
		const calls: string[] = [];
		await discoverSitemaps('https://x.example/blog/', serve({}, calls));
		expect(calls.filter((c) => !c.endsWith('robots.txt')).every((c) => c.startsWith('https://x.example/blog/'))).toBe(true);
	});

	it('reads a found sitemap during the daily read, remembers it, and forgets it once Search Console lists one', async () => {
		const files = { 'https://x.example/robots.txt': 'Sitemap: https://x.example/s.xml', 'https://x.example/s.xml': xml(['https://x.example/a', 'https://x.example/b']) };
		const r = await syncSitemapUrls(1, { client: none, fetchImpl: serve(files) });
		expect(r).toMatchObject({ urls: 2, found: ['https://x.example/s.xml'], error: null });
		expect(foundSitemaps(1)).toMatchObject({ feeds: ['https://x.example/s.xml'], from: 'robots' });

		await syncSitemapUrls(1, { client: listed(['https://x.example/s.xml']), fetchImpl: serve(files) });
		expect(foundSitemaps(1)).toBeNull();
	});

	it('says plainly when there is nothing to find', async () => {
		const r = await syncSitemapUrls(1, { client: none, fetchImpl: serve({}) });
		expect(r.found).toEqual([]);
		expect(r.error).toMatch(/none was found in robots\.txt/);
	});
});

describe('submitting a found sitemap', () => {
	it('only for a site that opted into sitemap writes, and never in READ_ONLY mode', async () => {
		const feeds = ['https://x.example/s.xml'];
		expect(await autoSubmitFoundSitemaps(getSite(1)!, feeds)).toEqual([]);
		db().prepare('UPDATE sites SET sitemap_auto = 1 WHERE id = 1').run();
		process.env.READ_ONLY = '1';
		expect(await autoSubmitFoundSitemaps(getSite(1)!, feeds)).toEqual([]);
		delete process.env.READ_ONLY;
		expect(submitted()).toEqual([]);
		expect(await autoSubmitFoundSitemaps(getSite(1)!, feeds)).toEqual(feeds);
		expect(submitted()).toEqual(['https://x.example/s.xml (auto)']);
	});
});
