import { beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { connectOpenSeo } from '../src/lib/server/connect';
import { syncSitemapUrls } from '../src/lib/server/sitemapcov';
import { crawlLinks } from '../src/lib/server/internallinks';
import { diagnoseSite } from '../src/lib/server/diagnose';
import { publishingFor } from '../src/lib/server/publishing';
import { linkHealthFor, verifyLinkTargets } from '../src/lib/server/linkhealth';
import { nicheFor } from '../src/lib/server/nichefit';
import { backlinkPlan, gapPlan, researchFor, runBacklinks, runGap, runSerp, serpPlan, serpPlanFrom } from '../src/lib/server/openseoresearch';
import type { OseoApi } from '../src/lib/server/openseolink';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp, resetRateLimits } from '../src/lib/server/mcp';

const site = () => getSite(1)!;

beforeAll(async () => {
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	delete process.env.READ_ONLY;
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
	const client = new DemoClient('demo-a');
	let guard = 0;
	await syncSite(1, { client, backfillChunkDays: 120 });
	while (!getSite(1)!.backfill_done && guard++ < 12) await syncSite(1, { client, backfillChunkDays: 120 });
	await syncSitemapUrls(1, { client });
	await connectOpenSeo('https://openseo.example', 'demo');
	await crawlLinks(1, { max: 40 });
}, 240_000);

describe('drop diagnosis on demo data', () => {
	it('returns a complete, ordered answer from stored data', () => {
		const d = diagnoseSite(site(), 28);
		expect(d.comparable).toBe(true);
		expect(d.headline.length).toBeGreaterThan(10);
		expect(d.steps.map((s) => s.n)).toEqual([...d.steps.map((s) => s.n)].sort((a, b) => a - b));
		expect(d.split.demand + d.split.clickRate).toBeCloseTo(d.clicks.change, 3);
		expect(d.period.end).toBe(site().synced_through);
	});
});

describe('publishing health on demo data', () => {
	it('groups the sitemap by folder with shown shares between 0 and 1', () => {
		const r = publishingFor(site(), 90);
		expect(r.synced).toBe(true);
		expect(r.totals.urls).toBeGreaterThan(0);
		for (const s of r.sections) { expect(s.shownShare).toBeGreaterThanOrEqual(0); expect(s.shownShare).toBeLessThanOrEqual(1); expect(s.shown).toBeLessThanOrEqual(s.urls); }
		expect(r.sections.reduce((a, s) => a + s.urls, 0)).toBe(r.totals.urls);
		expect(r.cohorts.reduce((a, c) => a + c.urls, 0)).toBe(r.totals.urls);
	});
});

describe('niche fit on demo data', () => {
	it('builds a profile and scores candidates', () => {
		const n = nicheFor(site(), 90, ['houseplant care', 'cheap flights to rome']);
		expect(n.profile.topics.length).toBeGreaterThan(0);
		expect(n.candidates).toHaveLength(2);
		expect(n.candidates[0].score).toBeGreaterThanOrEqual(n.candidates[1].score);
	});
});

describe('link health on demo data', () => {
	it('finds the pages the demo site has made 404 and verifies unchecked link targets', async () => {
		const before = linkHealthFor(site());
		expect(before.pagesCrawled).toBeGreaterThan(0);
		const r = await verifyLinkTargets(1, { max: 30 });
		expect(r.checked).toBeGreaterThan(0);
		const after = linkHealthFor(site());
		expect(after.checked).toBeGreaterThanOrEqual(before.checked);
		expect(after.unchecked.length).toBeLessThanOrEqual(before.unchecked.length);
	});
});

describe('OpenSEO research (demo OpenSEO)', () => {
	it('serp: previews the cost, then looks up and judges each search', async () => {
		const plan = serpPlan(1, 8);
		expect(plan.keywords.length).toBeGreaterThan(0);
		expect(plan.keywords.length).toBeLessThanOrEqual(8);
		expect(plan.credits).toBe(plan.keywords.length * 5); // OpenSEO's stated price, as an upper bound
		expect(plan.available).toBeGreaterThanOrEqual(plan.keywords.length);
		const out = await runSerp(1, plan.keywords);
		expect(out.checks).toHaveLength(plan.keywords.length);
		expect(Object.values(out.summary).reduce((a, b) => a + b, 0)).toBe(out.checks.length);
		expect(researchFor(1).serp?.data.asked).toBe(plan.keywords.length);
		expect(researchFor(1).serp?.credits).toBe(plan.credits);
	});
	it('serp: a search that failed at the provider is kept as "could not tell", not dropped', async () => {
		const api: OseoApi = { callTool: async () => ({ results: [{ keyword: 'x', ok: false, error: 'boom' }] }) };
		const out = await runSerp(1, [{ keyword: 'x', page: null, position: 5, impressions: 100, clicks: 0, missing: 3 }], { api, force: true });
		expect(out.checks[0].verdict).toBe('unclear');
		expect(out.failed).toBe(1);
	});
	it('gap: studies competitors that are not platforms and fits each keyword to the niche', async () => {
		const plan = gapPlan(1, 20);
		expect(plan.priced).toBe(false);
		expect(plan.calls).toBe(1 + plan.study);
		const out = await runGap(1, plan.keywords);
		expect(out.studied.length).toBeGreaterThan(0);
		expect(out.studied).not.toContain('en.wikipedia.org');
		expect(out.rows.every((r) => ['missing', 'behind'].includes(r.kind))).toBe(true);
		expect(out.rows.every((r) => r.fit)).toBe(true);
		expect(out.rows.map((r) => r.score)).toEqual([...out.rows.map((r) => r.score)].sort((a, b) => b - a));
	});
	it('backlinks: reclaims links to the dead page, skips spam and lost links, and profiles the rest', async () => {
		expect(backlinkPlan(1).credits).toBe(30);
		const out = await runBacklinks(1);
		expect(out.profile.backlinks).toBe(6);
		const row = out.reclaim.find((r) => r.target.endsWith('/discontinued-page'))!;
		expect(row.links).toHaveLength(2);
		expect(row.dofollow).toBe(2);
		expect(out.spamSample).toHaveLength(1);
		expect(out.profile.lost).toBe(1);
	});
	it('refuses to spend credits in READ_ONLY mode, and for a site not linked to OpenSEO', async () => {
		process.env.READ_ONLY = '1';
		await expect(runBacklinks(1)).rejects.toThrow(/READ_ONLY/);
		delete process.env.READ_ONLY;
		await expect(runBacklinks(2)).rejects.toThrow(/not linked to an OpenSEO project/);
	});
	it('reading stored results never calls OpenSEO', () => {
		const r = researchFor(1);
		expect(r.serp && r.gap && r.backlinks).toBeTruthy();
		expect(r.linked).toBe(true);
		expect(researchFor(2).serp).toBeNull();
	});
});

describe('MCP: the five new read-only tools', () => {
	const rpc = (key: string, body: object) => handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) })).then(async (r) => (await r.json()).result);
	const NEW = ['get_drop_diagnosis', 'get_publishing_health', 'get_niche_fit', 'get_link_health', 'get_research_findings'];
	it('are listed as read-only', async () => {
		const key = createApiKey('research-read', null).key;
		resetRateLimits();
		const tools = (await rpc(key, { method: 'tools/list' })).tools as { name: string; annotations: { readOnlyHint: boolean } }[];
		for (const n of NEW) expect(tools.find((t) => t.name === n)?.annotations.readOnlyHint, n).toBe(true);
	});
	it('answer for a site, and never call OpenSEO', async () => {
		const key = createApiKey('research-read2', null).key;
		resetRateLimits();
		const call = async (name: string, args: object) => { const r = await rpc(key, { method: 'tools/call', params: { name, arguments: args } }); expect(r.isError, name).toBeFalsy(); return JSON.parse(r.content[0].text); };
		const d = await call('get_drop_diagnosis', { site: '1' });
		expect(d).toMatchObject({ comparable: true, headline: expect.any(String), steps: expect.any(Array), split: expect.any(Object) });
		const p = await call('get_publishing_health', { site: '1' });
		expect(p.sections.length).toBeGreaterThan(0);
		expect(p.sections[0]).toMatchObject({ section: expect.any(String), verdict: expect.any(String), advice: expect.any(String) });
		const n = await call('get_niche_fit', { site: '1', keywords: 'houseplant care\ncheap flights' });
		expect(n.candidates).toHaveLength(2);
		expect(n.topics.length).toBeGreaterThan(0);
		const l = await call('get_link_health', { site: '1' });
		expect(l).toMatchObject({ pagesCrawled: expect.any(Number), notChecked: expect.any(Number), broken: expect.any(Array) });
		const f = await call('get_research_findings', { site: '1' });
		expect(f.openseoLinked).toBe(true);
		expect(f.serp.searches.length).toBeGreaterThan(0);
		expect(f.gap.keywords.length).toBeGreaterThan(0);
		expect(f.backlinks.profile.backlinks).toBe(6);
		const none = await call('get_research_findings', { site: '2' });
		expect(none.serp).toBeNull();
	});
});

describe('paid runs cannot be repeated by accident', () => {
	const kw = [{ keyword: 'x', page: null, position: 5, impressions: 100, clicks: 0, missing: 3 }];
	it('refuses the same analysis again within half an hour, and says how long to wait', async () => {
		let calls = 0;
		const api: OseoApi = { callTool: async () => { calls++; return { results: [{ keyword: 'x', ok: true, items: [{ type: 'organic', rank: 1, organicRank: 1, title: 't' }] }] }; } };
		const t0 = 1_800_000_000_000;
		await runSerp(1, kw, { api, now: t0, force: true });
		await expect(runSerp(1, kw, { api, now: t0 + 5 * 60_000 })).rejects.toThrow(/5 minutes ago .* try again in 25 minutes/);
		expect(calls).toBe(1); // the second never reached OpenSEO
		await runSerp(1, kw, { api, now: t0 + 31 * 60_000 }); // after the cooldown it runs
		expect(calls).toBe(2);
	});
	it('hands the claim back when OpenSEO fails, so a provider error does not lock you out', async () => {
		const bad: OseoApi = { callTool: async () => { throw new Error('Internal SE Server Error'); } };
		const t0 = 1_900_000_000_000;
		await expect(runSerp(1, kw, { api: bad, now: t0, force: true })).rejects.toThrow(/OpenSEO: Internal SE Server Error/);
		const ok: OseoApi = { callTool: async () => ({ results: [] }) };
		await expect(runSerp(1, kw, { api: ok, now: t0 + 60_000 })).resolves.toBeTruthy(); // immediately again: allowed
	});
	it('also hands the claim back when the connection itself fails (before any call), for results pages and competitors', async () => {
		const t0 = 2_100_000_000_000;
		const failing: OseoApi = { callTool: async () => { throw new Error('Could not reach OpenSEO'); } };
		await expect(runSerp(1, kw, { api: failing, now: t0, force: true })).rejects.toThrow(/Could not reach OpenSEO/);
		await expect(runGap(1, ['a b c'], { api: failing, now: t0, force: true })).rejects.toThrow(/Could not reach OpenSEO/);
		const ok: OseoApi = { callTool: async (name) => (name === 'find_serp_competitors' ? { competitors: [] } : { results: [] }) };
		await expect(runSerp(1, kw, { api: ok, now: t0 + 1000 })).resolves.toBeTruthy();
		await expect(runGap(1, ['a b c'], { api: ok, now: t0 + 1000 })).resolves.toBeTruthy();
	});
	it('a stamp from the future does not block (the clock was stepped back)', async () => {
		const api: OseoApi = { callTool: async () => ({ backlinks: { rows: [], totalCount: 0 } }) };
		await runBacklinks(1, { api, now: 3_000_000_000_000, force: true });
		await expect(runBacklinks(1, { api, now: 2_900_000_000_000 })).resolves.toBeTruthy();
	});
	it('each analysis has its own cooldown', async () => {
		const api: OseoApi = { callTool: async (name) => (name === 'get_backlinks_profile' ? { backlinks: { rows: [], totalCount: 0 } } : { competitors: [] }) };
		const t0 = 2_000_000_000_000;
		await runBacklinks(1, { api, now: t0, force: true });
		await expect(runBacklinks(1, { api, now: t0 + 1000 })).rejects.toThrow(/ago/);
		await expect(runGap(1, ['a b c'], { api, now: t0 + 1000 })).resolves.toBeTruthy(); // gap is a different analysis
	});
});

describe('publishing findings wait for the history', () => {
	it('while the 90 days are still downloading nothing is called stalled, and the report says why', async () => {
		const { db } = await import('../src/lib/server/db');
		const { buildActions } = await import('../src/lib/server/actions');
		const d = db();
		const before = d.prepare('SELECT backfill_done, backfilled_to FROM sites WHERE id = 1').get() as { backfill_done: number; backfilled_to: string };
		try {
			d.prepare('UPDATE sites SET backfill_done = 0, backfilled_to = ? WHERE id = 1').run('2026-11-10'); // newer than the window's start
			const r = publishingFor(site(), 90);
			expect(r.historyComplete).toBe(false);
			expect(buildActions(site(), 28).filter((i) => i.type === 'publishing')).toEqual([]);
			const key = createApiKey('hist', null).key;
			resetRateLimits();
			const out = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_publishing_health', arguments: { site: '1' } } }) })).then(async (x) => JSON.parse((await x.json()).result.content[0].text));
			expect(out.historyComplete).toBe(false);
			expect(out.warning).toMatch(/still downloading/);
		} finally {
			d.prepare('UPDATE sites SET backfill_done = ?, backfilled_to = ? WHERE id = 1').run(before.backfill_done, before.backfilled_to);
		}
		expect(publishingFor(site(), 90).historyComplete).toBe(true);
	});
});

describe('the new findings reach the action queue', () => {
	it('a stalled section and broken internal links become ranked, explained items', async () => {
		const { db } = await import('../src/lib/server/db');
		const { buildActions } = await import('../src/lib/server/actions');
		const { TYPE_EXPLAIN, TYPE_LABEL } = await import('../src/lib/explain');
		const d = db();
		// 60 sitemap pages under /stalled/, none of which Search Console has ever shown
		const put = d.prepare('INSERT OR REPLACE INTO sitemap_urls (site_id, url, norm, lastmod, lastmod_bad, sitemap) VALUES (1, ?, ?, ?, 0, ?)');
		for (let i = 0; i < 60; i++) put.run(`https://greenleaf.example/stalled/p${i}`, `greenleaf.example/stalled/p${i}`, `2026-0${(i % 6) + 1}-0${(i % 8) + 1}`, 'https://greenleaf.example/sitemap.xml');
		// a link target the crawl found broken, linked from a crawled page
		const page = crawled()[0];
		d.prepare('UPDATE link_pages SET links = ? WHERE site_id = 1 AND url = ?').run(JSON.stringify([{ url: 'https://greenleaf.example/gone-forever', anchor: 'gone', chrome: false }]), page.url);
		d.prepare('INSERT OR REPLACE INTO link_checks (site_id, norm, url, status, final_url, error, checked_at) VALUES (1, ?, ?, 404, NULL, ?, ?)').run('greenleaf.example/gone-forever', 'https://greenleaf.example/gone-forever', 'The page answered 404.', Date.now());

		const items = buildActions(site(), 28);
		const pub = items.find((i) => i.type === 'publishing');
		expect(pub, 'publishing item').toBeTruthy();
		expect(pub!.title).toMatch(/0 of 60 pages in \/stalled\//);
		expect(pub!.href).toBe('/sites/1/health#publishing');
		expect(pub!.impact).toBeNull();
		const links = items.find((i) => i.type === 'broken-links');
		expect(links, 'broken-links item').toBeTruthy();
		expect(links!.title).toMatch(/1 broken internal link target found/);
		expect(links!.evidence[0]).toMatch(/gone-forever \(404\), linked from 1 page/);
		expect(links!.href).toBe('/sites/1/health#links');
		for (const t of ['publishing', 'broken-links'] as const) { expect(TYPE_LABEL[t].length).toBeGreaterThan(2); expect(TYPE_EXPLAIN[t].length).toBeGreaterThan(40); }
	});
	it('the traffic-drop items open the Diagnose tab', async () => {
		const { buildActions } = await import('../src/lib/server/actions');
		for (const i of buildActions(site(), 28).filter((x) => x.type === 'sitewide' || x.type === 'anomaly')) expect(i.href).toBe('/sites/1/diagnose');
	});
});

import { crawledPages } from '../src/lib/server/internallinks';
const crawled = () => crawledPages(1);

describe('the price follows the number asked for', () => {
	it('prices any count the page offers at the stated upper bound, never above the number that qualifies', () => {
		const all = Array.from({ length: 12 }, (_, i) => ({ keyword: `k${i}`, page: null, position: 5, impressions: 100, clicks: 0, missing: 1 }));
		expect(serpPlanFrom(all, 10)).toMatchObject({ credits: 50, perKeyword: 5, available: 12 });
		expect(serpPlanFrom(all, 30).keywords).toHaveLength(12);
		expect(serpPlanFrom(all, 30).credits).toBe(60);
		expect(serpPlanFrom(all, 0).keywords).toHaveLength(1);
	});
});
