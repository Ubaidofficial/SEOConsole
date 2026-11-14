import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db, openDb } from '../src/lib/server/db';
import { OWNER, accessRefusal } from '../src/lib/server/roles';
import { AhrefsError, ahrefsIntegration, ahrefsStatus, connectAhrefs, domainTarget, drAnyDue, drBadge, drDue, drFor, normaliseTarget, parseDomainRatings, queryDomainRatings, syncDrAll } from '../src/lib/server/ahrefs';
import { enqueueDrAll } from '../src/lib/server/jobs';
import { privacySections } from '../src/lib/legal';

/**
 * Ahrefs Domain Rating through the FREE public endpoint, from a fake of its documented shape (which, as seen once live, answers each
 * target with a trailing slash). Nothing here reaches Ahrefs.
 */
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 14, 12);
type Call = { url: string; method: string; auth: string | null; body: { targets: string[]; version: string } };

function fakeAhrefs(drs: Record<string, number>, status = 200) {
	const calls: Call[] = [];
	const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body ?? '{}'));
		calls.push({ url: String(url), method: String(init?.method), auth: new Headers(init?.headers).get('authorization'), body });
		if (status !== 200) return new Response(JSON.stringify({ error: 'nope' }), { status });
		const targets = (body.targets as string[]).filter((t) => normaliseTarget(t) in drs).map((t) => ({ target: normaliseTarget(t) + '/', domain_rating: drs[normaliseTarget(t)] }));
		return new Response(JSON.stringify({ domain_rating: { targets, license: 'http://ahrefs.com/legal/domain-rating-license' } }), { status: 200 });
	}) as typeof fetch;
	return { impl, calls };
}

beforeEach(() => {
	process.env.SCHEDULER = '0';
	process.env.APP_SECRET = 'test-secret-'.repeat(4);
	delete process.env.DEMO_MODE;
	delete process.env.AHREFS_DR_VERSION;
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	const d = db();
	d.prepare("INSERT INTO accounts (id, google_sub, email, status, created_at) VALUES (1, 's', 'o@example.com', 'active', 1)").run();
	const ins = d.prepare('INSERT INTO sites (id, account_id, site_url, permission, hidden, created_at) VALUES (?, 1, ?, ?, ?, 1)');
	ins.run(1, 'sc-domain:alpha.com', 'siteOwner', 0);
	ins.run(2, 'https://www.beta.io/', 'siteOwner', 0);
	ins.run(3, 'https://alpha.com/', 'siteOwner', 0); // the same domain as site 1
	ins.run(4, 'sc-domain:hidden.net', 'siteOwner', 1);
	ins.run(5, 'sc-domain:gone.net', 'none', 0);
});

describe('targets and parsing', () => {
	it('asks about the domain: a Domain property\'s domain, a URL-prefix property\'s host without www', () => {
		expect(domainTarget('sc-domain:Example.com')).toBe('example.com');
		expect(domainTarget('https://www.example.com/blog/')).toBe('example.com');
		expect(domainTarget('https://blog.example.co.uk/')).toBe('blog.example.co.uk');
		for (const bad of ['sc-domain:', 'https://localhost/', 'not a url', 'sc-domain:no_dots']) expect(domainTarget(bad), bad).toBeNull();
	});
	it('matches answers by target without scheme, case or the trailing slash Ahrefs adds', () => {
		expect(normaliseTarget('Example.COM/')).toBe('example.com');
		expect(normaliseTarget('https://www.example.com/')).toBe('www.example.com');
		const m = parseDomainRatings({ domain_rating: { targets: [{ target: 'example.com/', domain_rating: 42.5 }, { target: 'zero.com/', domain_rating: 0 }, { target: 'bad.com/', domain_rating: 'x' }, { target: 'big.com/', domain_rating: 400 }, { target: 'null.com/', domain_rating: null }] } });
		expect([...m]).toEqual([['example.com', 42.5], ['zero.com', 0]]); // a real 0 is kept; nonsense is dropped
	});
	it('refuses an answer in a shape it does not know', () => {
		for (const bad of [null, {}, { domain_rating: {} }, { domain_rating: { targets: 'x' } }]) expect(() => parseDomainRatings(bad), JSON.stringify(bad)).toThrow(AhrefsError);
	});
});

describe('the request', () => {
	it('is one free POST with the bearer key and the targets, asking for dr3 unless AHREFS_DR_VERSION=dr4', async () => {
		const f = fakeAhrefs({ 'a.com': 1 });
		await queryDomainRatings('KEY123', ['a.com'], f.impl);
		expect(f.calls[0]).toMatchObject({ url: 'https://api.ahrefs.com/v3/public/domain-rating-free', method: 'POST', auth: 'Bearer KEY123', body: { targets: ['a.com'], version: 'dr3' } });
		process.env.AHREFS_DR_VERSION = 'dr4';
		await queryDomainRatings('KEY123', ['a.com'], f.impl);
		expect(f.calls[1].body.version).toBe('dr4');
		process.env.AHREFS_DR_VERSION = 'bogus';
		await queryDomainRatings('KEY123', ['a.com'], f.impl);
		expect(f.calls[2].body.version).toBe('dr3');
	});
	it('splits more than 1,000 domains into batches of at most 1,000', async () => {
		const f = fakeAhrefs({});
		await queryDomainRatings('k', Array.from({ length: 2300 }, (_, i) => `d${i}.com`), f.impl);
		expect(f.calls.map((c) => c.body.targets.length)).toEqual([1000, 1000, 300]);
	});
	it('says what is wrong: a rejected key, a rate limit, another error, no connection', async () => {
		await expect(queryDomainRatings('k', ['a.com'], fakeAhrefs({}, 401).impl)).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/rejected the API key/) });
		await expect(queryDomainRatings('k', ['a.com'], fakeAhrefs({}, 429).impl)).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/rate limiting/) });
		await expect(queryDomainRatings('k', ['a.com'], fakeAhrefs({}, 400).impl)).rejects.toMatchObject({ status: 400, message: 'Ahrefs: nope' });
		await expect(queryDomainRatings('k', ['a.com'], (async () => { throw new Error('down'); }) as unknown as typeof fetch)).rejects.toMatchObject({ message: 'Could not reach Ahrefs.' });
	});
});

describe('connecting', () => {
	it('checks the key for free against ahrefs.com, stores it encrypted, and refuses a rejected one without saving it', async () => {
		await expect(connectAhrefs('badkey', { fetchImpl: fakeAhrefs({}, 401).impl })).rejects.toMatchObject({ status: 401 });
		expect(ahrefsIntegration()).toBeUndefined();
		const f = fakeAhrefs({ 'ahrefs.com': 91 });
		await connectAhrefs('  GOODKEY  ', { fetchImpl: f.impl });
		expect(f.calls[0].body.targets).toEqual(['ahrefs.com']);
		expect(ahrefsIntegration()).toBeTruthy();
		const raw = (db().prepare("SELECT secret_enc FROM integrations WHERE kind = 'ahrefs'").get() as { secret_enc: string }).secret_enc;
		expect(raw).not.toContain('GOODKEY');
	});
	it('a key that gets an answer without the probe domain is not accepted', async () => {
		await expect(connectAhrefs('k', { fetchImpl: fakeAhrefs({}).impl })).rejects.toMatchObject({ message: expect.stringMatching(/did not answer the check/) });
		await expect(connectAhrefs('   ')).rejects.toMatchObject({ status: 400 });
	});
	it('the word "demo" is only a key in demo mode', async () => {
		await expect(connectAhrefs('demo', { fetchImpl: fakeAhrefs({}, 401).impl })).rejects.toBeTruthy();
		process.env.DEMO_MODE = '1';
		await connectAhrefs('demo');
		expect(ahrefsIntegration()?.is_demo).toBe(1);
	});
});

describe('looking every site up in one request', () => {
	beforeEach(async () => {
		await connectAhrefs('K', { fetchImpl: fakeAhrefs({ 'ahrefs.com': 91 }).impl });
	});

	it('sends each distinct domain once, only for the sites the dashboard shows, and stores what comes back', async () => {
		const f = fakeAhrefs({ 'alpha.com': 12.34, 'beta.io': 0 });
		const r = await syncDrAll({ fetchImpl: f.impl, now: T0 });
		expect(f.calls).toHaveLength(1);
		expect([...f.calls[0].body.targets].sort()).toEqual(['alpha.com', 'beta.io']); // not hidden.net or gone.net; alpha.com once
		expect(r).toEqual({ stored: 3, missing: 0 });
		expect(drBadge(drFor(1))).toEqual({ dr: 12.3, date: '2026-11-14' });
		expect(drBadge(drFor(3))).toEqual({ dr: 12.3, date: '2026-11-14' });
		expect(drBadge(drFor(2))).toEqual({ dr: 0, date: '2026-11-14' }); // zero is a value, not "none"
		expect(drFor(4)).toBeUndefined();
	});

	it('a domain Ahrefs did not answer keeps its last value and records why; the badge never shows an error', async () => {
		await syncDrAll({ fetchImpl: fakeAhrefs({ 'alpha.com': 40, 'beta.io': 7 }).impl, now: T0 });
		const r = await syncDrAll({ fetchImpl: fakeAhrefs({ 'alpha.com': 41 }).impl, now: T0 + 8 * DAY });
		expect(r).toMatchObject({ stored: 2, missing: 1 });
		expect(drFor(2)).toMatchObject({ dr: 7, error: expect.stringContaining('beta.io') });
		expect(drBadge(drFor(2))).toEqual({ dr: 7, date: '2026-11-14' });
		expect(drBadge(drFor(1))?.dr).toBe(41);
	});

	it('a rejected key stops further asking until it is replaced', async () => {
		await expect(syncDrAll({ fetchImpl: fakeAhrefs({}, 403).impl, now: T0 })).rejects.toMatchObject({ status: 403 });
		expect(ahrefsIntegration()).toBeUndefined();
		expect(ahrefsStatus()).toMatchObject({ rejected: true, withDr: 0, lastError: expect.stringMatching(/rejected/) });
		expect(drAnyDue(T0 + 30 * DAY)).toBe(false);
		await connectAhrefs('NEW', { fetchImpl: fakeAhrefs({ 'ahrefs.com': 91 }).impl });
		expect(ahrefsIntegration()).toBeTruthy();
	});

	it('is due weekly, retried a day after a failure, and nothing is due without a connection', async () => {
		expect(drDue(1, T0)).toBe(true); // never fetched
		await syncDrAll({ fetchImpl: fakeAhrefs({ 'alpha.com': 5, 'beta.io': 6 }).impl, now: T0 });
		expect(drAnyDue(T0 + 6 * DAY)).toBe(false);
		expect(drAnyDue(T0 + 7 * DAY)).toBe(true);
		await syncDrAll({ fetchImpl: fakeAhrefs({}, 429).impl, now: T0 + 8 * DAY }).catch(() => {});
		expect(drAnyDue(T0 + 8 * DAY + 3600_000)).toBe(false);
		expect(drAnyDue(T0 + 8 * DAY + 25 * 3600_000)).toBe(true);
		for (const i of [1, 2, 3, 4, 5]) db().prepare("UPDATE integrations SET status = 'active'").run(), expect(typeof drDue(i)).toBe('boolean');
		db().prepare("DELETE FROM integrations WHERE kind = 'ahrefs'").run();
		expect(drAnyDue(T0 + 90 * DAY)).toBe(false);
		expect(enqueueDrAll(true)).toBe(false);
	});
});

describe('how it is shown', () => {
	it('every chip carries the credit the licence requires, with Ahrefs linked to ahrefs.com and not hidden', () => {
		const chip = readFileSync('src/lib/components/DrChip.svelte', 'utf8');
		expect(chip).toContain('href="https://ahrefs.com/"');
		expect(chip).toMatch(/by <a[^>]*>Ahrefs<\/a>/);
		expect(chip).toContain('Domain Rating by Ahrefs');
		expect(chip.slice(chip.indexOf('</script>'))).not.toMatch(/display:\s*none|sr-only|\bhidden\b|opacity-0/); // the markup, not the comment above it
		// and it is used where a site is named: the dashboard card and the site header
		expect(readFileSync('src/routes/+page.svelte', 'utf8')).toContain('<DrChip');
		expect(readFileSync('src/routes/sites/[id]/+layout.svelte', 'utf8')).toContain('<DrChip');
	});
	it('the privacy policy says the domain names go to Ahrefs, and nothing else', () => {
		const t = privacySections({ entity: 'X', contact: 'a@b.c', law: null, updated: '2026-11-14' }).map((s) => [...s.paras, ...(s.items ?? [])].join(' ')).join(' ');
		expect(t).toMatch(/Ahrefs[^.]*domain names[^.]*Domain Rating/);
	});
	it('connecting and refreshing are for admins', () => {
		const u = { ...OWNER, id: 7, role: 'editor' as const, siteIds: null };
		for (const a of ['ahrefsKey', 'ahrefsRemove', 'ahrefsRefresh']) expect(accessRefusal(u, 'POST', new URL(`http://x/connect?/${a}`)), a).toMatchObject({ kind: 'role', need: 'admin' });
	});
});
