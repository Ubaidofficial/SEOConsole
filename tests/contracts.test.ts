import { beforeAll, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { encrypt } from '../src/lib/server/crypto';
import { checkExpected, contractEvents, contractStatus, keyPaths, runContractChecks } from '../src/lib/server/contracts';

describe('reading the shape of an answer', () => {
	it('lists key paths, with lists as []', () => {
		const p = keyPaths({ rows: [{ keys: ['a'], clicks: 1 }], meta: { n: 1 } });
		expect([...p].sort()).toEqual(['meta', 'meta.n', 'rows', 'rows[]', 'rows[].clicks', 'rows[].keys', 'rows[].keys[]']);
		expect([...keyPaths([{ Url: 'x' }])]).toEqual(['[]', '[].Url']);
	});
	it('a field missing from a non-empty list is drift; under an empty list it cannot be checked', () => {
		expect(checkExpected({ rows: [{ clicks: 1 }] }, ['rows[].clicks', 'rows[].position']).missing).toEqual(['rows[].position']);
		const empty = checkExpected({ rows: [] }, ['rows[].clicks']);
		expect(empty.missing).toEqual([]);
		expect(empty.unverifiable).toEqual(['rows[].clicks']);
		expect(checkExpected({}, ['rows[].clicks']).unverifiable).toEqual(['rows[].clicks']);
		// A list at the very end: its presence is the check.
		expect(checkExpected({ rows: [{ x: 1 }] }, ['rows[].keys[]']).missing).toEqual(['rows[].keys[]']);
		expect(checkExpected({ DailyQuota: 10 }, ['DailyQuota', 'MonthlyQuota']).missing).toEqual(['MonthlyQuota']);
	});
});

describe('the daily run', () => {
	beforeAll(() => {
		process.env.SCHEDULER = '0';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		const d = db();
		// One live-looking Google account with a fresh token (so no token refresh is attempted) and one synced site.
		d.prepare("INSERT INTO accounts (id, google_sub, email, access_token_enc, expires_at, status, is_demo, created_at) VALUES (1, 'sub1', 'owner@example.com', ?, ?, 'active', 0, 0)").run(encrypt('tok'), Date.now() + 3600_000);
		d.prepare("INSERT INTO sites (id, account_id, site_url, permission, synced_through, hidden, created_at) VALUES (1, 1, 'sc-domain:example.com', 'siteOwner', '2026-11-20', 0, 0)").run();
	});

	let incidents: unknown = [{ id: 'a', service_name: 'Ranking', external_desc: 'March core update', begin: '2026-03-01T00:00:00Z' }];
	let gscRows: unknown = { rows: [{ keys: ['2026-11-20', 'q', 'https://example.com/', 'usa', 'DESKTOP'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }] };
	const fake: typeof fetch = async (input) => {
		const url = String(input);
		const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
		if (url.includes('status.search.google.com')) return json(incidents);
		if (url.endsWith('/webmasters/v3/sites')) return json({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] });
		if (url.includes('searchAnalytics')) return json(gscRows);
		if (url.includes('/sitemaps')) return json({ sitemap: [] });
		if (url.includes('urlInspection')) return new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), { status: 429 });
		return new Response('{}', { status: 404 });
	};

	it('records a baseline, skips what is not connected, and keeps errors without keys', async () => {
		const r = await runContractChecks({ fetchImpl: fake, notify: false, now: 1000 });
		const by = Object.fromEntries(r.map((x) => [x.probe, x]));
		expect(by['gsc.sites'].status).toBe('ok');
		expect(by['gsc.searchAnalytics'].status).toBe('ok');
		expect(by['gsc.sitemaps'].status).toBe('ok'); // empty list: nothing below it can be checked, not drift
		expect(by['gsc.urlInspection'].status).toBe('error');
		expect(by['ga4.runReport'].status).toBe('skipped');
		expect(by['bing.sites'].status).toBe('skipped');
		expect(by['openseo.list_projects'].status).toBe('skipped');
		expect(by['google.statusIncidents'].status).toBe('ok');
		expect(contractStatus().length).toBe(r.length);
	});

	it('notices a renamed field once, logs new fields, and notices the recovery', async () => {
		gscRows = { rows: [{ keys: ['x'], clicks: 1, impressions: 2, ctr: 0.5, avgPosition: 3 }] };
		incidents = [{ id: 'a', service_name: 'Ranking', external_desc: 'x', begin: '2026-03-01', severity: 'low' }];
		const r1 = await runContractChecks({ fetchImpl: fake, notify: false, now: 2000, only: ['gsc.searchAnalytics', 'google.statusIncidents'] });
		expect(r1.find((x) => x.probe === 'gsc.searchAnalytics')!.missing).toEqual(['rows[].position']);
		expect(r1.find((x) => x.probe === 'google.statusIncidents')!.added).toEqual(['[].severity']);
		await runContractChecks({ fetchImpl: fake, notify: false, now: 3000, only: ['gsc.searchAnalytics'] });
		gscRows = { rows: [{ keys: ['x'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }] };
		await runContractChecks({ fetchImpl: fake, notify: false, now: 4000, only: ['gsc.searchAnalytics'] });
		const kinds = contractEvents(50).filter((e) => e.probe === 'gsc.searchAnalytics').map((e) => e.kind);
		expect(kinds.filter((k) => k === 'drift')).toHaveLength(1); // the second run with the same drift is not logged again
		expect(kinds).toContain('recovered');
		expect(contractEvents(50).some((e) => e.kind === 'new-fields' && e.added.includes('[].severity'))).toBe(true);
		expect(contractStatus().find((c) => c.probe === 'gsc.searchAnalytics')!.status).toBe('ok');
	});
});
