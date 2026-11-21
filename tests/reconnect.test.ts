import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { autoMatchGa4 } from '../src/lib/server/connect';
import { queueDepth, resumeAccount } from '../src/lib/server/jobs';
import { load as layoutLoad } from '../src/routes/+layout.server';
import { load as dashboardLoad } from '../src/routes/+page.server';

const drain = async () => {
	const end = Date.now() + 30_000;
	while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
};
const link = (siteId: number) => db().prepare("SELECT sync_status s, sync_message m FROM site_links WHERE site_id = ? AND kind = 'ga4'").get(siteId) as { s: string; m: string | null };
const EXPIRED = 'Token has been expired or revoked.';

beforeEach(async () => {
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
	await autoMatchGa4();
	await drain();
}, 120_000);

describe('reconnecting a Google account', () => {
	it('syncs the GA4 properties read through it again at once, so the old "token expired" error clears; hidden sites stay paused', async () => {
		const acc = (db().prepare('SELECT account_id a FROM site_links WHERE site_id = 1 AND kind = ? ').get('ga4') as { a: number }).a;
		const sameAccount = (db().prepare("SELECT site_id id FROM site_links WHERE kind = 'ga4' AND account_id = ? AND site_id != 1").get(acc) as { id: number }).id;
		db().prepare("UPDATE site_links SET sync_status = 'error', sync_message = ? WHERE kind = 'ga4' AND account_id = ?").run(EXPIRED, acc);
		db().prepare('UPDATE sites SET hidden = 1 WHERE id = ?').run(sameAccount);
		const r = await resumeAccount(acc);
		await drain();
		expect(r.links).toBeGreaterThan(0);
		expect(link(1)).toEqual({ s: 'idle', m: null });
		expect(link(sameAccount)).toEqual({ s: 'error', m: EXPIRED });
	}, 60_000);
});

describe('telling people an account lost access', () => {
	it('the layout reads the page address, so SvelteKit reruns it (and its banner count) on every page change', () => {
		const read: string[] = [];
		const url = new Proxy(new URL('http://x/sites/1'), { get: (t, k) => (read.push(String(k)), Reflect.get(t, k)) });
		const d = layoutLoad({ locals: { authed: true, user: null }, url } as never) as { revoked: number };
		expect(read).toContain('pathname');
		db().prepare("UPDATE accounts SET status = 'revoked' WHERE id = 1").run();
		expect((layoutLoad({ locals: { authed: true, user: null }, url } as never) as { revoked: number }).revoked).toBe(d.revoked + 1);
	});

	it('the dashboard marks the cards of a revoked account instead of showing a calm "synced" time', () => {
		db().prepare("UPDATE accounts SET status = 'revoked' WHERE id = (SELECT account_id FROM sites WHERE id = 1)").run();
		const cards = (dashboardLoad({ url: new URL('http://x/'), locals: { user: null, authed: true } } as never) as { cards: { id: number; accountRevoked: boolean }[] }).cards;
		const acc1 = (db().prepare('SELECT account_id a FROM sites WHERE id = 1').get() as { a: number }).a;
		const ofAcc1 = new Set((db().prepare('SELECT id FROM sites WHERE account_id = ?').all(acc1) as { id: number }[]).map((r) => r.id));
		for (const c of cards) expect(c.accountRevoked, String(c.id)).toBe(ofAcc1.has(c.id));
		expect(cards.some((c) => !c.accountRevoked)).toBe(true);
	});
});
