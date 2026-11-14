import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { OWNER, accessRefusal } from '../src/lib/server/roles';
import { authorityMap, authorityOf, authFor, saveError, saveValue } from '../src/lib/server/authority';
import { MozError, connectMoz, daAnyDue, daDue, mozEveryDays, mozIntegration, mozMonthlyRows, mozStatus, parseUrlMetrics, queryDomainAuthority, rowsUsed, syncDaAll } from '../src/lib/server/moz';
import { enqueueDaAll } from '../src/lib/server/jobs';
import { privacySections } from '../src/lib/legal';

/**
 * Moz Domain Authority from a fake of the shape third parties describe for Moz's API v2. It has never run against Moz itself: these
 * tests pin the app's own rules (thrift, the row budget, failure handling), not Moz's behaviour.
 */
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 14, 12);
type Call = { method: string; auth: string | null; body: { targets: string[] } };

function fakeMoz(das: Record<string, number>, status = 200, echoPage = true) {
	const calls: Call[] = [];
	const impl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body ?? '{}'));
		calls.push({ method: String(init?.method), auth: new Headers(init?.headers).get('authorization'), body });
		if (status !== 200) return new Response(JSON.stringify({ message: 'nope' }), { status });
		const results = (body.targets as string[]).map((t) => (t in das ? { ...(echoPage ? { page: t + '/' } : {}), domain_authority: das[t] } : { ...(echoPage ? { page: t + '/' } : {}), domain_authority: null }));
		return new Response(JSON.stringify({ results }), { status: 200 });
	}) as typeof fetch;
	return { impl, calls };
}
const noWait = async () => {};

beforeEach(() => {
	process.env.SCHEDULER = '0';
	process.env.APP_SECRET = 'test-secret-'.repeat(4);
	delete process.env.DEMO_MODE;
	delete process.env.MOZ_MONTHLY_ROWS;
	delete process.env.MOZ_DA_EVERY_DAYS;
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	const d = db();
	d.prepare("INSERT INTO accounts (id, google_sub, email, status, created_at) VALUES (1, 's', 'o@example.com', 'active', 1)").run();
	const ins = d.prepare('INSERT INTO sites (id, account_id, site_url, permission, hidden, created_at) VALUES (?, 1, ?, ?, ?, 1)');
	ins.run(1, 'sc-domain:alpha.com', 'siteOwner', 0);
	ins.run(2, 'https://www.beta.io/', 'siteOwner', 0);
	ins.run(3, 'https://alpha.com/', 'siteOwner', 0);
	ins.run(4, 'sc-domain:hidden.net', 'siteOwner', 1);
});

describe('parsing and the request', () => {
	it('reads domain_authority by the page Moz echoes (any scheme, case, slash or path), or by position when it echoes none', () => {
		const m = parseUrlMetrics({ results: [{ page: 'HTTPS://A.com/', domain_authority: 41 }, { page: 'b.com/some/path', domain_authority: 0 }, { page: 'c.com/', domain_authority: null }, { page: 'd.com/', domain_authority: 900 }] }, ['a.com', 'b.com', 'c.com', 'd.com']);
		expect([...m]).toEqual([['a.com', 41], ['b.com', 0]]); // a real 0 is kept; null and nonsense are dropped
		expect([...parseUrlMetrics({ results: [{ domain_authority: 12 }, { domain_authority: 30 }] }, ['x.com', 'y.com'])]).toEqual([['x.com', 12], ['y.com', 30]]);
		expect(() => parseUrlMetrics({}, [])).toThrow(MozError);
	});
	it('is a POST with HTTP Basic credentials and the targets, 25 at a time and spaced apart', async () => {
		const f = fakeMoz({});
		const waits: number[] = [];
		await queryDomainAuthority('ID', 'SECRET', Array.from({ length: 60 }, (_, i) => `d${i}.com`), { fetchImpl: f.impl, sleep: async (ms) => void waits.push(ms) });
		expect(f.calls.map((c) => c.body.targets.length)).toEqual([25, 25, 10]);
		expect(f.calls[0]).toMatchObject({ method: 'POST', auth: 'Basic ' + Buffer.from('ID:SECRET').toString('base64') });
		expect(waits).toEqual([10_500, 10_500]); // none before the first request
	});
	it('says what is wrong: bad credentials, a limit, another error, no connection', async () => {
		await expect(queryDomainAuthority('i', 's', ['a.com'], { fetchImpl: fakeMoz({}, 401).impl })).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/rejected the Access ID/) });
		await expect(queryDomainAuthority('i', 's', ['a.com'], { fetchImpl: fakeMoz({}, 429).impl })).rejects.toMatchObject({ status: 429 });
		await expect(queryDomainAuthority('i', 's', ['a.com'], { fetchImpl: fakeMoz({}, 400).impl })).rejects.toMatchObject({ message: 'Moz: nope' });
		await expect(queryDomainAuthority('i', 's', ['a.com'], { fetchImpl: (async () => { throw new Error('x'); }) as unknown as typeof fetch })).rejects.toMatchObject({ message: 'Could not reach Moz.' });
	});
});

describe('connecting', () => {
	it('checks the credentials with one lookup, counts that row, stores them encrypted, and refuses bad ones without saving', async () => {
		await expect(connectMoz('id', 'bad', { fetchImpl: fakeMoz({}, 403).impl, now: T0 })).rejects.toMatchObject({ status: 403 });
		expect(mozIntegration()).toBeUndefined();
		await connectMoz(' ID123 ', ' SECRET456 ', { fetchImpl: fakeMoz({ 'moz.com': 90 }).impl, now: T0 });
		expect(mozIntegration()).toBeTruthy();
		expect(rowsUsed(T0)).toBe(1); // only the accepted check cost a row; a refused attempt cost nothing
		const raw = (db().prepare("SELECT secret_enc FROM integrations WHERE kind = 'moz'").get() as { secret_enc: string }).secret_enc;
		expect(raw).not.toContain('SECRET456');
		await expect(connectMoz('', 'x')).rejects.toMatchObject({ status: 400 });
	});
});

describe('looking sites up thriftily', () => {
	beforeEach(async () => {
		await connectMoz('i', 's', { fetchImpl: fakeMoz({ 'moz.com': 90 }).impl, now: T0 });
	});

	it('asks once per distinct domain, only for sites the dashboard shows, and stores what comes back', async () => {
		const f = fakeMoz({ 'alpha.com': 33, 'beta.io': 0 });
		const r = await syncDaAll({ fetchImpl: f.impl, sleep: noWait, now: T0 });
		expect(f.calls).toHaveLength(1);
		expect([...f.calls[0].body.targets].sort()).toEqual(['alpha.com', 'beta.io']);
		expect(r).toEqual({ stored: 3, missing: 0, deferred: 0 });
		expect(authorityOf(1).da).toEqual({ value: 33, date: '2026-11-14' });
		expect(authorityOf(3).da?.value).toBe(33);
		expect(authorityOf(2).da?.value).toBe(0);
		expect(authFor(4, 'da')).toBeUndefined();
	});

	it('is due monthly (MOZ_DA_EVERY_DAYS, never under 7), and not retried within a day of a failure', async () => {
		await syncDaAll({ fetchImpl: fakeMoz({ 'alpha.com': 1, 'beta.io': 2 }).impl, sleep: noWait, now: T0 });
		expect(daAnyDue(T0 + 29 * DAY)).toBe(false);
		expect(daAnyDue(T0 + 30 * DAY)).toBe(true);
		process.env.MOZ_DA_EVERY_DAYS = '2';
		expect(mozEveryDays()).toBe(7);
		process.env.MOZ_DA_EVERY_DAYS = '14';
		expect(daDue(1, T0 + 14 * DAY)).toBe(true);
		saveError(1, 'da', 'x', T0 + 14 * DAY);
		expect(daDue(1, T0 + 14 * DAY + 3600_000)).toBe(false);
		expect(daDue(1, T0 + 15 * DAY + 1)).toBe(true);
	});

	it('never spends more than the monthly row budget: sites with no value go first, the rest wait', async () => {
		process.env.MOZ_MONTHLY_ROWS = '2'; // 1 row is already used by connecting, so only one more domain fits
		expect(mozMonthlyRows()).toBe(2);
		saveValue(2, 'da', 55, T0 - 40 * DAY); // beta.io already has a (stale) value; alpha.com has none
		const f = fakeMoz({ 'alpha.com': 10, 'beta.io': 99 });
		const r = await syncDaAll({ fetchImpl: f.impl, sleep: noWait, now: T0 });
		expect(f.calls[0].body.targets).toEqual(['alpha.com']);
		expect(r).toMatchObject({ stored: 2, deferred: 1 }); // alpha.com's two sites; beta.io waits
		expect(authorityOf(2).da?.value).toBe(55);
		expect(rowsUsed(T0)).toBe(2);
		// next month the budget is fresh
		const next = T0 + 31 * DAY;
		await syncDaAll({ fetchImpl: f.impl, sleep: noWait, now: next });
		expect(authorityOf(2).da?.value).toBe(99);
	});

	it('with the budget used up it makes no request and says so', async () => {
		process.env.MOZ_MONTHLY_ROWS = '1';
		const f = fakeMoz({ 'alpha.com': 10 });
		const r = await syncDaAll({ fetchImpl: f.impl, sleep: noWait, now: T0 });
		expect(f.calls).toHaveLength(0);
		expect(r.stored).toBe(0);
		expect(mozStatus(T0)).toMatchObject({ rowsUsed: 1, rowBudget: 1, lastError: expect.stringMatching(/budget/) });
	});

	it('a domain Moz did not answer keeps its last value and records why; a rejected key stops further asking', async () => {
		await syncDaAll({ fetchImpl: fakeMoz({ 'alpha.com': 40, 'beta.io': 7 }).impl, sleep: noWait, now: T0 });
		const r = await syncDaAll({ fetchImpl: fakeMoz({ 'alpha.com': 41 }).impl, sleep: noWait, now: T0 + 31 * DAY });
		expect(r).toMatchObject({ stored: 2, missing: 1 });
		expect(authFor(2, 'da')).toMatchObject({ value: 7, error: expect.stringContaining('beta.io') });
		expect(authorityOf(2).da?.value).toBe(7);
		await expect(syncDaAll({ fetchImpl: fakeMoz({}, 401).impl, sleep: noWait, now: T0 + 62 * DAY })).rejects.toMatchObject({ status: 401 });
		expect(mozIntegration()).toBeUndefined();
		expect(mozStatus()).toMatchObject({ rejected: true });
		expect(daAnyDue(T0 + 200 * DAY)).toBe(false);
		expect(enqueueDaAll(true)).toBe(false);
	});
});

describe('both scores together', () => {
	it('the dashboard gets a pair per site, either of which may be missing', () => {
		saveValue(1, 'dr', 3.24, T0);
		saveValue(1, 'da', 12, T0);
		saveValue(2, 'da', 0, T0);
		saveError(2, 'dr', 'secret failure text', T0);
		const m = authorityMap();
		expect(m.get(1)).toEqual({ dr: { value: 3.2, date: '2026-11-14' }, da: { value: 12, date: '2026-11-14' } });
		expect(m.get(2)).toEqual({ dr: null, da: { value: 0, date: '2026-11-14' } });
		expect(JSON.stringify(m.get(2))).not.toContain('secret failure');
		expect(m.get(3)).toBeUndefined();
	});
	it('the circles name both providers, and the privacy policy lists Moz', () => {
		const t = privacySections({ entity: 'X', contact: 'a@b.c', law: null, updated: '2026-11-14' }).map((s) => [...s.paras, ...(s.items ?? [])].join(' ')).join(' ');
		expect(t).toMatch(/Moz[^.]*domain names[^.]*Domain Authority/);
	});
	it('connecting and refreshing Moz are for admins', () => {
		const u = { ...OWNER, id: 7, role: 'editor' as const, siteIds: null };
		for (const a of ['mozKeys', 'mozRemove', 'mozRefresh']) expect(accessRefusal(u, 'POST', new URL(`http://x/connect?/${a}`)), a).toMatchObject({ kind: 'role', need: 'admin' });
	});
});
