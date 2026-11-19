import { beforeAll, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { autoMatchGa4, autoMatchGtm } from '../src/lib/server/connect';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';
import { demoSetup } from '../src/lib/server/demo-channels';

describe('MCP setup_google_tag', () => {
	let key = '';
	const id = (host: string) => String((db().prepare('SELECT id FROM sites WHERE site_url LIKE ?').get(`%${host}%`) as { id: number }).id);
	const call = async (args: object, k = key) => {
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'setup_google_tag', arguments: args } }) }));
		const r = (await res.json()).result;
		return { isError: !!r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
	};
	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		delete process.env.READ_ONLY;
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
		await autoMatchGa4();
		await autoMatchGtm();
		key = createApiKey('w', null, null, 'submit').key;
	}, 120_000);

	it('preview lists what will happen and changes nothing; publish adds the Google tag where it is missing', async () => {
		const before = demoSetup.ga4Tags.size;
		const p = await call({ site: id('ledgerly') });
		expect(p.isError, p.data).toBe(false);
		expect(p.data).toMatchObject({ ok: true, ready: true, canPublish: true, next: expect.stringMatching(/mode publish/) });
		expect(p.data.changes.join(' ')).toMatch(/Add "Google tag \(added by SEOConsole\)" for G-/);
		expect(demoSetup.ga4Tags.size).toBe(before);
		const r = await call({ site: id('ledgerly'), mode: 'publish' });
		expect(r.data, JSON.stringify(r.data)).toMatchObject({ ok: true, published: true });
		expect(demoSetup.ga4Tags.size).toBe(before + 1);
	});

	it('a container that already has a Google tag gets nothing; an unsafe publish is refused but a workspace is allowed', async () => {
		const g = await call({ site: id('greenleaf'), mode: 'publish' });
		expect(g.data).toMatchObject({ ok: true, nothingToDo: true });
		expect(g.data.changes.join(' ')).toMatch(/already has/);
		const t = await call({ site: id('trailmaps'), mode: 'publish' });
		expect(t.data).toMatchObject({ ok: false, canPublish: false });
		expect(t.data.error).toBeTruthy();
		expect((await call({ site: id('trailmaps'), mode: 'workspace' })).data).toMatchObject({ ok: true, published: false });
	});

	it('refuses a bad mode and a read-only key', async () => {
		expect((await call({ site: id('greenleaf'), mode: 'later' })).isError).toBe(true);
		expect((await call({ site: id('greenleaf') }, createApiKey('r', null).key)).isError).toBe(true);
	});
});
