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
import { backlinkPlan, gapPlan, researchFor, runBacklinks, runGap, runSerp, serpPlan } from '../src/lib/server/openseoresearch';
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
		expect(plan.credits).toBeCloseTo(plan.keywords.length * 2.5, 5);
		const out = await runSerp(1, plan.keywords);
		expect(out.checks).toHaveLength(plan.keywords.length);
		expect(Object.values(out.summary).reduce((a, b) => a + b, 0)).toBe(out.checks.length);
		expect(researchFor(1).serp?.data.asked).toBe(plan.keywords.length);
		expect(researchFor(1).serp?.credits).toBeCloseTo(plan.credits, 5);
	});
	it('serp: a search that failed at the provider is kept as "could not tell", not dropped', async () => {
		const api: OseoApi = { callTool: async () => ({ results: [{ keyword: 'x', ok: false, error: 'boom' }] }) };
		const out = await runSerp(1, [{ keyword: 'x', page: null, position: 5, impressions: 100, clicks: 0, missing: 3 }], { api });
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
