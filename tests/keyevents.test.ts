import { beforeAll, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts, upsertGoogleAccount } from '../src/lib/server/accounts';
import { autoMatchGa4, autoMatchGtm } from '../src/lib/server/connect';
import { queueDepth } from '../src/lib/server/jobs';
import { linksFor } from '../src/lib/server/links';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';
import { applyKeyEvent, checkInput, demoKeyEvents, planKeyEvent, realEventWriter, realKeyEventAdmin, tagBody, triggerBody, variableBody } from '../src/lib/server/keyevents';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const drain = async () => {
	const end = Date.now() + 30_000;
	while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
};
const PARAMS = ['alert_form', 'alert_frequency', 'alert_has_role', 'alert_remote'];

describe('what is sent to Tag Manager', () => {
	it('a Data Layer Variable reads the parameter from dataLayer version 2', () => {
		expect(variableBody('alert_form')).toMatchObject({ name: 'DLV - alert_form', type: 'v', parameter: expect.arrayContaining([{ type: 'template', key: 'name', value: 'alert_form' }, { type: 'integer', key: 'dataLayerVersion', value: '2' }]) });
	});
	it('the trigger fires on exactly that dataLayer event', () => {
		expect(triggerBody('job_alert_signup')).toMatchObject({ name: 'Event - job_alert_signup', type: 'customEvent', customEventFilter: [{ type: 'equals', parameter: [{ key: 'arg0', value: '{{_event}}' }, { key: 'arg1', value: 'job_alert_signup' }] }] });
	});
	it('the GA4 event tag sends the event name, measurement ID and each parameter from its variable, fired by the trigger', () => {
		const t = tagBody('job_alert_signup', 'G-71YY5G1HY9', ['alert_form', 'alert_remote'], '42');
		expect(t).toMatchObject({ type: 'gaawe', firingTriggerId: ['42'] });
		expect(t.parameter).toContainEqual({ type: 'template', key: 'eventName', value: 'job_alert_signup' });
		expect(t.parameter).toContainEqual({ type: 'template', key: 'measurementIdOverride', value: 'G-71YY5G1HY9' });
		const table = t.parameter.find((p) => p.key === 'eventSettingsTable') as { list: { map: { key: string; value: string }[] }[] };
		expect(table.list.map((r) => Object.fromEntries(r.map.map((m) => [m.key, m.value])))).toEqual([
			{ parameter: 'alert_form', parameterValue: '{{DLV - alert_form}}' },
			{ parameter: 'alert_remote', parameterValue: '{{DLV - alert_remote}}' }
		]);
		expect(tagBody('x', 'G-ABCD1234', [], '1').parameter.some((p) => p.key === 'eventSettingsTable')).toBe(false);
		// the flags every current GA4 Event tag carries; without migratedToV2 Tag Manager reported a "Conflicting Google tag" on a real container
		for (const [key, value] of [['sendEcommerceData', 'false'], ['enableUserProperties', 'true'], ['enableEuid', 'true'], ['migratedToV2', 'true'], ['demoV2', 'false']]) expect(t.parameter, key).toContainEqual({ type: 'boolean', key, value });
	});
	it('names are checked the way GA4 accepts them', () => {
		expect(checkInput({ event: 'job_alert_signup', params: ['alert_form', 'alert_form', ' '] })).toEqual({ event: 'job_alert_signup', params: ['alert_form'], measurementId: null });
		for (const bad of ['', '1signup', 'job-alert', 'ga_signup', 'x'.repeat(41)]) expect(checkInput({ event: bad }), bad).toHaveProperty('error');
		expect(checkInput({ event: 'ok', params: ['bad-name'] })).toHaveProperty('error');
		expect(checkInput({ event: 'ok', params: Array.from({ length: 11 }, (_, i) => `p${i}`) })).toHaveProperty('error');
		expect(checkInput({ event: 'ok', measurementId: 'UA-1' })).toHaveProperty('error');
		expect(checkInput({ event: 'ok', measurementId: 'g-71yy5g1hy9' })).toMatchObject({ measurementId: 'G-71YY5G1HY9' });
	});
});

describe('the real clients', () => {
	it('lists and creates in the workspace, and marks a key event (a 409 means it already is one)', async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		const id = upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.edit tagmanager.edit.containers' });
		const calls: { url: string; method: string; body?: any }[] = [];
		const f = vi.fn(async (u: string, init?: RequestInit) => {
			calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
			if (u.endsWith('/variables') && init?.method !== 'POST') return json({ variable: [{ variableId: '7', name: 'DLV - alert_form' }] });
			if (u.endsWith('/triggers') && init?.method !== 'POST') return json({});
			if (u.endsWith('/tags') && init?.method !== 'POST') return json({ tag: [{ tagId: '3', name: 'x', type: 'gaawe', parameter: [{ key: 'eventName', value: 'other' }] }] });
			if (u.endsWith('/triggers')) return json({ triggerId: '9' });
			if (u.endsWith('/variables')) return json({ variableId: '8' });
			if (u.includes('/keyEvents?')) return json({ keyEvents: [{ eventName: 'purchase' }] });
			if (u.endsWith('/keyEvents')) return json({ error: { code: 409, message: 'already exists', status: 'ALREADY_EXISTS' } }, 409);
			return json({});
		});
		const w = realEventWriter(id, { fetchImpl: f as never });
		await w.deleteWorkspace('accounts/1/containers/2/workspaces/4');
		expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2/workspaces/4' });
		const ws = 'accounts/1/containers/2/workspaces/3';
		expect(await w.list(ws)).toEqual({ variables: [{ id: '7', name: 'DLV - alert_form' }], triggers: [], tags: [{ id: '3', name: 'x', type: 'gaawe', eventName: 'other' }] });
		expect(await w.createTrigger(ws, triggerBody('job_alert_signup'))).toEqual({ triggerId: '9' });
		expect(calls.find((c) => c.method === 'POST')?.url).toBe(`https://tagmanager.googleapis.com/tagmanager/v2/${ws}/triggers`);
		const admin = realKeyEventAdmin(id, { fetchImpl: f as never });
		expect(await admin.listKeyEvents('properties/5')).toEqual(['purchase']);
		await expect(admin.createKeyEvent('properties/5', 'job_alert_signup')).resolves.toBeUndefined();
		const post = calls.find((c) => c.url === 'https://analyticsadmin.googleapis.com/v1beta/properties/5/keyEvents');
		expect(post).toMatchObject({ method: 'POST', body: { eventName: 'job_alert_signup', countingMethod: 'ONCE_PER_EVENT' } });
	});
});

describe('plan and apply on demo data', () => {
	let siteId = 0;
	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		delete process.env.READ_ONLY;
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
		await autoMatchGa4();
		await autoMatchGtm();
		await drain();
		siteId = (db().prepare("SELECT id FROM sites WHERE site_url LIKE '%greenleaf%'").get() as { id: number }).id;
		expect(linksFor(siteId).gtm && linksFor(siteId).ga4).toBeTruthy();
	}, 120_000);

	it('the preview lists every change, takes the measurement ID from the linked GA4 property, and changes nothing', async () => {
		const p = await planKeyEvent(siteId, { event: 'job_alert_signup', params: PARAMS });
		expect(p.ok, p.error).toBe(true);
		expect(p.measurementId).toMatch(/^G-/);
		expect(p.changes).toHaveLength(PARAMS.length + 3); // a variable per parameter, the trigger, the tag, the GA4 key event
		expect(p.changes!.at(-1)).toMatch(/mark job_alert_signup as a key event/);
		expect(p).toMatchObject({ canMarkKeyEvent: true, alreadyKeyEvent: false, alreadyTagged: false });
		expect(demoKeyEvents.items.size).toBe(0);
		expect(demoKeyEvents.keyEvents.size).toBe(0);
	});

	it('apply creates variables, trigger and tag in a workspace, publishes, marks the key event, and a second run creates nothing new', async () => {
		const r = await applyKeyEvent(siteId, { event: 'job_alert_signup', params: PARAMS }, 'publish');
		expect(r, r.error).toMatchObject({ ok: true, published: true, keyEvent: 'marked' });
		const items = [...demoKeyEvents.items.values()][0];
		expect(items.variables.map((v) => v.name)).toEqual(PARAMS.map((p) => `DLV - ${p}`));
		expect(items.triggers.map((t) => t.name)).toContain('Event - job_alert_signup');
		expect(items.tags).toEqual([expect.objectContaining({ type: 'gaawe', eventName: 'job_alert_signup' })]);
		expect([...demoKeyEvents.keyEvents.values()][0]).toEqual(['job_alert_signup']);
		const again = await applyKeyEvent(siteId, { event: 'job_alert_signup', params: PARAMS }, 'workspace');
		expect(again).toMatchObject({ ok: true, keyEvent: 'already' });
		expect(items.variables).toHaveLength(PARAMS.length);
		expect(items.tags).toHaveLength(1);
		const audit = (db().prepare("SELECT action FROM audit_log WHERE action LIKE 'gtm.key_event%' OR action LIKE 'ga4.key_event%' ORDER BY id").all() as { action: string }[]).map((x) => x.action);
		expect(audit).toEqual(['gtm.key_event_published', 'ga4.key_event_created', 'gtm.key_event_prepared']);
	});

	it('deletes only its own unpublished workspace for the same event before trying again, and says so in the preview', async () => {
		const container = linksFor(siteId).gtm!.external_id;
		demoKeyEvents.workspaces.set(container, [
			{ path: `${container}/workspaces/4`, name: 'SEOConsole key event lead_form 2026-11-19' },
			{ path: `${container}/workspaces/5`, name: 'SEOConsole key event lead_form_v2 2026-11-19' },
			{ path: `${container}/workspaces/6`, name: 'Marketing changes' }
		]);
		const p = await planKeyEvent(siteId, { event: 'lead_form' });
		expect(p.staleWorkspaces?.map((w) => w.name)).toEqual(['SEOConsole key event lead_form 2026-11-19']);
		expect(p.changes![0]).toMatch(/^Delete the workspace "SEOConsole key event lead_form 2026-11-19"/);
		expect(demoKeyEvents.workspaces.get(container)).toHaveLength(3); // the preview deleted nothing
		const r = await applyKeyEvent(siteId, { event: 'lead_form' }, 'publish');
		expect(r).toMatchObject({ ok: true, published: true });
		expect(demoKeyEvents.workspaces.get(container)!.map((w) => w.name)).toEqual(['SEOConsole key event lead_form_v2 2026-11-19', 'Marketing changes']);
		expect(db().prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'gtm.key_event_workspace_deleted'").get()).toEqual({ n: 1 });
	});

	it('refuses without permission, on a read-only server, and for bad input; MCP preview changes nothing', async () => {
		expect(await planKeyEvent(siteId, { event: 'bad-name' })).toMatchObject({ ok: false });
		process.env.READ_ONLY = '1';
		try {
			expect((await planKeyEvent(siteId, { event: 'job_alert_signup' })).error).toMatch(/READ_ONLY/);
		} finally {
			delete process.env.READ_ONLY;
		}
		const key = createApiKey('w', null, null, 'submit').key;
		const call = async (args: object) => {
			const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'track_key_event', arguments: { site: String(siteId), ...args } } }) }));
			const r = (await res.json()).result;
			return { isError: !!r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
		};
		const before = [...demoKeyEvents.keyEvents.values()].flat().length;
		const p = await call({ event: 'sign_up', params: ['plan'] });
		expect(p.isError, p.data).toBe(false);
		expect(p.data).toMatchObject({ ok: true, next: expect.stringMatching(/mode publish/) });
		expect([...demoKeyEvents.keyEvents.values()].flat().length).toBe(before);
		expect((await call({ event: 'sign_up', mode: 'later' })).isError).toBe(true);
		const done = await call({ event: 'sign_up', params: ['plan'], mode: 'publish' });
		expect(done.data).toMatchObject({ ok: true, keyEvent: 'marked' });
		// a read-only key may not use it at all
		const reader = createApiKey('r', null).key;
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${reader}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'track_key_event', arguments: { site: String(siteId), event: 'x' } } }) }));
		expect((await res.json()).result.isError).toBe(true);
	}, 30_000);
});
