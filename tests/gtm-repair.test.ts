import { beforeAll, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { autoMatchGa4, autoMatchGtm } from '../src/lib/server/connect';
import { syncGtm } from '../src/lib/server/channels';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { demoGtmLive, demoRepaired } from '../src/lib/server/demo-channels';
import { planTagIdRepair, repairedTag, repairTagIdViaGtm, type GtmTagEditor, type RawTag } from '../src/lib/server/gtmwrite';
import { summarizeVersion, type GtmLive, type GtmSource } from '../src/lib/server/gtm';
import { trackingHealth } from '../src/lib/server/tracking';
import { getSite } from '../src/lib/server/clients';
import { linksFor } from '../src/lib/server/links';
import { buildActions } from '../src/lib/server/actions';

// The value found in a real published container on 2026-11-14.
const PASTED = `<!-- Google tag (gtag.js) --> <script async src="https://www.googletagmanager.com/gtag/js?id=G-PCTSPWJHR2"></script> <script>   window.dataLayer = window.dataLayer || [];   function gtag(){dataLayer.push(arguments);}   gtag('js', new Date());    gtag('config', 'G-PCTSPWJHR2'); </script>`;
const rawTag = (over: Partial<RawTag> = {}): RawTag => ({ tagId: '3', name: 'GA4', type: 'googtag', fingerprint: 'fp1', firingTriggerId: ['2147479573'], tagFiringOption: 'oncePerEvent', parameter: [{ type: 'template', key: 'tagId', value: PASTED }, { type: 'boolean', key: 'sendPageView', value: 'true' }], ...over });

describe('repairedTag', () => {
	it('replaces only the malformed ID and leaves everything else on the tag exactly as it was', () => {
		const t = rawTag();
		const r = repairedTag(t, 'G-PCTSPWJHR2');
		expect(r.key).toBe('tagId');
		expect(r.was).toBe(PASTED);
		expect(r.tag.parameter).toEqual([{ type: 'template', key: 'tagId', value: 'G-PCTSPWJHR2' }, { type: 'boolean', key: 'sendPageView', value: 'true' }]);
		expect({ ...r.tag, parameter: undefined }).toEqual({ ...t, parameter: undefined }); // name, triggers, fingerprint, firing option untouched
		expect(t.parameter![0].value).toBe(PASTED); // the input is not mutated
	});
	it('refuses, changing nothing, when the tag has a real ID or a variable by now', () => {
		for (const ok of ['G-GOOD1234', '{{GA4 ID}}', 'GT-ABC1234']) expect(() => repairedTag(rawTag({ parameter: [{ key: 'tagId', value: ok }] }), 'G-X1234'), ok).toThrow(/no longer has a malformed ID/);
		expect(() => repairedTag(rawTag({ parameter: [] }), 'G-X1234')).toThrow(/no longer/);
	});
	it('works on the older GA4 configuration tag (measurementId) and follows the order the reader uses', () => {
		const t = rawTag({ type: 'gaawc', parameter: [{ key: 'measurementId', value: 'oops' }, { key: 'other', value: 'x' }] });
		expect(repairedTag(t, 'G-ABCD1234').tag.parameter![0]).toEqual({ key: 'measurementId', value: 'G-ABCD1234' });
		// tagId is what the reader sees first: a good tagId means nothing is malformed, whatever measurementIdOverride holds
		expect(() => repairedTag(rawTag({ parameter: [{ key: 'measurementIdOverride', value: 'junk' }, { key: 'tagId', value: 'G-GOOD1234' }] }), 'G-X1234')).toThrow();
	});
});

describe('Tag ID repair against a container with a malformed Google tag', () => {
	const siteId = (host: string) => (db().prepare('SELECT id FROM sites WHERE site_url LIKE ?').get(`%${host}%`) as { id: number }).id;
	let id: number;
	let container: string;

	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		delete process.env.READ_ONLY;
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
		for (const [i, sub] of [[1, 'demo-a'], [2, 'demo-a'], [3, 'demo-a'], [4, 'demo-b'], [5, 'demo-b'], [6, 'demo-b']] as const) await syncSite(i, { client: new DemoClient(sub), mode: 'incremental' });
		await autoMatchGa4();
		await autoMatchGtm();
		id = siteId('coffeelab');
		container = linksFor(id).gtm!.external_id;
		await syncGtm(id);
	}, 120_000);

	/** A live version with one malformed tag, a fake editor that records every call, and a fake source. */
	const rig = (o: { live?: string | null; latest?: string | null; fail?: 'update' | 'version' } = {}) => {
		const calls: string[] = [];
		const written: { workspace: string; tagId: string; tag: RawTag }[] = [];
		const live: GtmLive = summarizeVersion({ containerVersionId: o.live === undefined ? '12' : (o.live ?? ''), tag: [{ tagId: '3', name: 'GA4', type: 'googtag', firingTriggerId: ['2'], parameter: [{ key: 'tagId', value: PASTED }] }], trigger: [{ triggerId: '2', name: 'All Pages' }] });
		const source: GtmSource = { listContainers: async () => [{ path: container, publicId: 'GTM-TEST', name: 'test', domains: [], usage: ['web'], accountName: 'a' }], liveVersion: async () => (o.live === null ? null : live) };
		const writer: GtmTagEditor = {
			latestVersionId: async () => (o.latest === undefined ? '12' : o.latest),
			createWorkspace: async (c) => (calls.push('workspace'), { path: `${c}/workspaces/55`, workspaceId: '55' }),
			createTag: async () => { throw new Error('the repair must never create a tag'); },
			getTag: async (_w, tagId) => (calls.push('getTag'), rawTag({ tagId })),
			updateTag: async (w, tagId, tag) => { calls.push('updateTag'); if (o.fail === 'update') throw new Error('fingerprint mismatch'); written.push({ workspace: w, tagId, tag }); },
			createVersion: async () => (calls.push('version'), o.fail === 'version' ? { path: '', versionId: '', compilerError: true } : { path: `${container}/versions/13`, versionId: '13', compilerError: false }),
			publish: async () => (calls.push('publish'), { versionId: '13', compilerError: false })
		};
		return { calls, written, source, writer };
	};

	it('the demo container carries the planted problem, as a critical, blocking finding', () => {
		const health = trackingHealth(getSite(id)!, 28);
		expect(health.findings.find((f) => f.id === 'gtm-tag-id-malformed')).toMatchObject({ severity: 'critical' });
		const item = buildActions(getSite(id)!, 28).find((a) => a.key === 'tracking:gtm-tag-id-malformed');
		expect(item).toMatchObject({ type: 'tracking', blocking: true, href: `/sites/${id}/tags` });
		expect(item!.how).toMatch(/Tag Manager tab|Tag ID/);
	});

	it('the plan reads the live tag, offers the ID inside and the linked property\'s, and preselects only when it is clear', async () => {
		const r = rig();
		const p = await planTagIdRepair(id, { source: r.source, writer: r.writer, ga4Ids: ['G-PCTSPWJHR2'] });
		expect(p.ok).toBe(true);
		expect(p.tags).toHaveLength(1);
		expect(p.tags![0]).toMatchObject({ tagId: '3', name: 'GA4', recommended: 'G-PCTSPWJHR2', candidates: [{ id: 'G-PCTSPWJHR2', from: 'inside' }] });
		expect(p.tags![0].current.length).toBeLessThanOrEqual(120);
		expect(p.canPublish).toBe(true);
		expect(r.calls).toEqual([]); // planning changes nothing
		// the ID inside differs from the linked property: both offered, none preselected
		const differs = await planTagIdRepair(id, { source: r.source, writer: r.writer, ga4Ids: ['G-OTHER9999'] });
		expect(differs.tags![0].recommended).toBeNull();
		expect(differs.tags![0].candidates.map((c) => c.id)).toEqual(['G-PCTSPWJHR2', 'G-OTHER9999']);
	});

	it('publish: new workspace, read the tag there, write it back with only the ID changed, then version and publish, in that order', async () => {
		const r = rig();
		const res = await repairTagIdViaGtm(id, { tagId: '3', newId: ' g-pctspwjhr2 ' }, 'publish', { source: r.source, writer: r.writer, ga4Ids: ['G-PCTSPWJHR2'] });
		expect(res).toMatchObject({ ok: true, published: true, versionId: '13' });
		expect(r.calls).toEqual(['workspace', 'getTag', 'updateTag', 'version', 'publish']);
		expect(r.written).toHaveLength(1);
		expect(r.written[0].workspace).toBe(`${container}/workspaces/55`);
		expect(r.written[0].tag.parameter).toEqual([{ type: 'template', key: 'tagId', value: 'G-PCTSPWJHR2' }, { type: 'boolean', key: 'sendPageView', value: 'true' }]);
		const log = db().prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'gtm.tagid%' ORDER BY id DESC LIMIT 1").get() as { action: string; detail: string };
		expect(log.action).toBe('gtm.tagid_published');
		expect(log.detail).toContain('G-PCTSPWJHR2');
	});

	it('workspace-only: prepares the fix and never versions or publishes', async () => {
		const r = rig();
		const res = await repairTagIdViaGtm(id, { tagId: '3', newId: 'G-PCTSPWJHR2' }, 'workspace', { source: r.source, writer: r.writer });
		expect(res).toMatchObject({ ok: true, published: false });
		expect(res.reviewUrl).toMatch(/tagmanager\.google\.com.*workspaces\/55/);
		expect(r.calls).toEqual(['workspace', 'getTag', 'updateTag']);
	});

	it('refuses to publish when the newest version is not the live one, before touching anything', async () => {
		const r = rig({ latest: '13' });
		const res = await repairTagIdViaGtm(id, { tagId: '3', newId: 'G-PCTSPWJHR2' }, 'publish', { source: r.source, writer: r.writer });
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/newer version/);
		expect(r.calls).toEqual([]);
	});

	it('refuses what is not a measurement ID, a tag that is not malformed, an unpublished container and READ_ONLY, all before any write', async () => {
		const r = rig();
		for (const bad of ['', 'G-', '<script>', 'UA-123456-1', 'G-AB']) expect((await repairTagIdViaGtm(id, { tagId: '3', newId: bad }, 'workspace', { source: r.source, writer: r.writer })).error, bad).toMatch(/measurement ID/);
		expect((await repairTagIdViaGtm(id, { tagId: '999', newId: 'G-PCTSPWJHR2' }, 'workspace', { source: r.source, writer: r.writer })).error).toMatch(/no longer has a malformed ID/);
		expect((await repairTagIdViaGtm(id, { tagId: '3', newId: 'G-PCTSPWJHR2' }, 'workspace', { source: rig({ live: null }).source, writer: r.writer })).error).toMatch(/never been published/);
		process.env.READ_ONLY = '1';
		expect((await repairTagIdViaGtm(id, { tagId: '3', newId: 'G-PCTSPWJHR2' }, 'workspace', { source: r.source, writer: r.writer })).error).toMatch(/READ_ONLY/);
		delete process.env.READ_ONLY;
		expect(r.calls).toEqual([]);
	});

	it('refuses without the separate edit permission, offering the grant', async () => {
		const accId = linksFor(id).gtm!.account_id!;
		const before = db().prepare('SELECT is_demo, scopes FROM accounts WHERE id = ?').get(accId) as { is_demo: number; scopes: string };
		db().prepare("UPDATE accounts SET is_demo = 0, scopes = 'https://www.googleapis.com/auth/tagmanager.readonly' WHERE id = ?").run(accId);
		try {
			const r = rig();
			const p = await planTagIdRepair(id, { source: r.source, writer: r.writer });
			expect(p).toMatchObject({ ok: false, needsGrant: true });
			expect((await repairTagIdViaGtm(id, { tagId: '3', newId: 'G-PCTSPWJHR2' }, 'workspace', { source: r.source, writer: r.writer })).ok).toBe(false);
			expect(r.calls).toEqual([]);
		} finally {
			db().prepare('UPDATE accounts SET is_demo = ?, scopes = ? WHERE id = ?').run(before.is_demo, before.scopes, accId);
		}
	});

	it('a failure while writing stops there: no version, no publish, and it is logged as failed', async () => {
		const r = rig({ fail: 'update' });
		const res = await repairTagIdViaGtm(id, { tagId: '3', newId: 'G-PCTSPWJHR2' }, 'publish', { source: r.source, writer: r.writer });
		expect(res).toMatchObject({ ok: false, published: false });
		expect(res.error).toMatch(/fingerprint mismatch/);
		expect(res.error).toMatch(/already created the empty workspace "SEOConsole fix Tag ID/);
		expect(r.calls).toEqual(['workspace', 'getTag', 'updateTag']);
		expect((db().prepare("SELECT action FROM audit_log WHERE action LIKE 'gtm.tagid%' ORDER BY id DESC LIMIT 1").get() as { action: string }).action).toBe('gtm.tagid_failed');
		const v = rig({ fail: 'version' });
		const res2 = await repairTagIdViaGtm(id, { tagId: '3', newId: 'G-PCTSPWJHR2' }, 'publish', { source: v.source, writer: v.writer });
		expect(res2.ok).toBe(false);
		expect(v.calls).not.toContain('publish');
	});

	it('end to end in demo mode: the finding disappears after the fix and the next sync', async () => {
		expect(demoGtmLive(container)!.tags[0].badTagId).toBeTruthy();
		const res = await repairTagIdViaGtm(id, { tagId: '1', newId: 'G-DEMOCOFFEE1' }, 'publish');
		expect(res).toMatchObject({ ok: true, published: true });
		expect(demoRepaired.get(container)).toBe('G-DEMOCOFFEE1');
		const fixed = demoGtmLive(container)!.tags[0];
		expect(fixed.measurementId).toBe('G-DEMOCOFFEE1');
		expect(fixed.badTagId).toBeFalsy();
		await syncGtm(id);
		expect(trackingHealth(getSite(id)!, 28).findings.map((f) => f.id)).not.toContain('gtm-tag-id-malformed');
		expect(buildActions(getSite(id)!, 28).some((a) => a.key === 'tracking:gtm-tag-id-malformed')).toBe(false);
		expect((await planTagIdRepair(id)).error).toMatch(/No Google tag .* malformed/); // nothing left to fix
	});
});
