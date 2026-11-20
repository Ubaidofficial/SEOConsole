import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each Google account gets its own fake GA4 / Tag Manager inventory; the sync queue is a no-op (matching is what is tested).
const inventory: Record<number, { props: { property: string; displayName: string; url: string }[]; containers: { path: string; publicId: string; name: string; domains: string[]; usage: string[] }[] }> = {};
const calls: string[] = [];
const failing = new Set<number>();
vi.mock('../src/lib/server/channels', async (orig) => ({
	...(await orig<typeof import('../src/lib/server/channels')>()),
	ga4SourceFor: (id: number) => ({
		listProperties: async () => (calls.push(`ga4:${id}`), (inventory[id]?.props ?? []).map((p) => ({ property: p.property, displayName: p.displayName, account: '' }))),
		streamUrls: async (property: string) => (inventory[id]?.props ?? []).filter((p) => p.property === property).map((p) => p.url)
	}),
	gtmSourceFor: (id: number) => ({ listContainers: async () => { calls.push(`gtm:${id}`); if (failing.has(id)) throw new Error('Tag Manager is down'); return inventory[id]?.containers ?? []; }, liveVersion: async () => null })
}));
vi.mock('../src/lib/server/jobs', async (orig) => ({ ...(await orig<typeof import('../src/lib/server/jobs')>()), enqueueLinkSync: () => true }));

const { db, openDb } = await import('../src/lib/server/db');
const { autoLinkNewSites, autoMatchGa4, autoMatchGtm, ga4PropertiesWithUrls } = await import('../src/lib/server/connect');
const { allCandidates, autoLinkable, linksFor, removeLink, setLink, skipAutoLink } = await import('../src/lib/server/links');
const { SCOPE_GA4 } = await import('../src/lib/server/ga4');
const { SCOPE_GTM_READ } = await import('../src/lib/server/google');

beforeEach(() => {
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	calls.length = 0;
	failing.clear();
	for (const k of Object.keys(inventory)) delete inventory[Number(k)];
	const d = db();
	const acc = d.prepare("INSERT INTO accounts (id, google_sub, email, status, scopes, created_at) VALUES (?, ?, ?, 'active', ?, 1)");
	acc.run(1, 's1', 'owner@example.com', `${SCOPE_GA4} ${SCOPE_GTM_READ}`);
	acc.run(2, 's2', 'agency@example.com', `${SCOPE_GA4} ${SCOPE_GTM_READ}`);
	const site = d.prepare("INSERT INTO sites (id, account_id, site_url, permission, hidden, created_at) VALUES (?, 1, ?, 'siteOwner', 0, 1)");
	site.run(1, 'sc-domain:alpha.example');
	site.run(2, 'sc-domain:beta.example');
});

describe('GA4 matching', () => {
	it('looks in the other connected accounts when the site owner cannot see a property, and links with the account that can', async () => {
		inventory[2] = { props: [{ property: 'properties/22', displayName: 'Alpha', url: 'https://alpha.example/' }], containers: [] };
		const r = await autoMatchGa4();
		expect(r.matched).toBe(1);
		expect(linksFor(1).ga4).toMatchObject({ external_id: 'properties/22', account_id: 2 });
		expect(r.unmatchedSites).toEqual(['sc-domain:beta.example']);
	});

	it("prefers the site's own account when both can see a matching property", async () => {
		inventory[1] = { props: [{ property: 'properties/11', displayName: 'Alpha (own)', url: 'https://alpha.example/' }], containers: [] };
		inventory[2] = { props: [{ property: 'properties/22', displayName: 'Alpha (agency)', url: 'https://alpha.example/' }], containers: [] };
		await autoMatchGa4();
		expect(linksFor(1).ga4).toMatchObject({ external_id: 'properties/11', account_id: 1 });
	});

	it('saves several equally good properties as choices instead of guessing; linking one clears them', async () => {
		inventory[1] = { props: [{ property: 'properties/1', displayName: 'Alpha A', url: 'https://alpha.example/' }, { property: 'properties/2', displayName: 'Alpha B', url: 'https://www.alpha.example/' }], containers: [] };
		const r = await autoMatchGa4();
		expect(r.matched).toBe(0);
		expect(r.ambiguous).toEqual(['sc-domain:alpha.example']);
		expect(linksFor(1).ga4).toBeUndefined();
		expect(allCandidates().map((c) => [c.site_id, c.kind, c.external_id, c.account_id])).toEqual([
			[1, 'ga4', 'properties/1', 1],
			[1, 'ga4', 'properties/2', 1]
		]);
		setLink(1, 'ga4', { accountId: 1, externalId: 'properties/2' });
		expect(allCandidates()).toEqual([]);
	});

	it('reads at most `max` properties for their stream addresses', async () => {
		const streams: string[] = [];
		const src = { listProperties: async () => Array.from({ length: 7 }, (_, i) => ({ property: `properties/${i}`, displayName: `P${i}`, account: '' })), streamUrls: async (p: string) => (streams.push(p), []) };
		expect(await ga4PropertiesWithUrls(src, 3)).toHaveLength(3);
		expect(streams).toHaveLength(3);
	});
});

describe('Tag Manager matching', () => {
	it('offers both containers when two match a site equally, and links when a later account has a unique one', async () => {
		const c = (path: string, id: string, domain: string) => ({ path, publicId: id, name: id, domains: [domain], usage: ['web'] });
		inventory[1] = { props: [], containers: [c('accounts/1/containers/1', 'GTM-A1', 'alpha.example'), c('accounts/1/containers/2', 'GTM-A2', 'alpha.example')] };
		const r = await autoMatchGtm();
		expect(r.ambiguous).toEqual(['sc-domain:alpha.example']);
		expect(allCandidates().filter((x) => x.kind === 'gtm').map((x) => x.external_id)).toEqual(['accounts/1/containers/1', 'accounts/1/containers/2']);

		inventory[2] = { props: [], containers: [c('accounts/2/containers/9', 'GTM-B9', 'beta.example')] };
		const again = await autoMatchGtm();
		expect(linksFor(2).gtm).toMatchObject({ external_id: 'accounts/2/containers/9', account_id: 2 });
		expect(again.ambiguous).toEqual(['sc-domain:alpha.example']);
	});
});

describe('autoLinkNewSites', () => {
	it('never links back a source someone unlinked on purpose; linking by hand lifts that', async () => {
		inventory[1] = { props: [{ property: 'properties/11', displayName: 'Alpha', url: 'https://alpha.example/' }], containers: [] };
		await autoLinkNewSites();
		expect(linksFor(1).ga4?.external_id).toBe('properties/11');

		removeLink(1, 'ga4');
		skipAutoLink(1, 'ga4');
		const r = await autoLinkNewSites();
		expect(r.ga4).toBe(0);
		expect(linksFor(1).ga4).toBeUndefined();
		expect(autoLinkable(1, 'ga4')).toBe(false);

		setLink(1, 'ga4', { accountId: 1, externalId: 'properties/11' });
		removeLink(1, 'ga4');
		expect(autoLinkable(1, 'ga4')).toBe(true);
	});

	it('asks no API anything when every site is already linked or skipped', async () => {
		for (const id of [1, 2]) {
			setLink(id, 'ga4', { accountId: 1, externalId: `properties/${id}` });
			skipAutoLink(id, 'gtm');
		}
		const r = await autoLinkNewSites();
		expect(calls).toEqual([]);
		expect(r).toMatchObject({ ga4: 0, gtm: 0, bing: 0, openseo: 0, errors: [] });
	});

	it('keeps going when one source fails, and reports it', async () => {
		inventory[2] = { props: [{ property: 'properties/22', displayName: 'Beta', url: 'https://beta.example/' }], containers: [] };
		failing.add(1);
		const r = await autoLinkNewSites();
		expect(r.errors).toEqual(['Tag Manager: Tag Manager is down']);
		expect(r.ga4).toBe(1);
		expect(linksFor(2).ga4?.account_id).toBe(2);
	});
});
