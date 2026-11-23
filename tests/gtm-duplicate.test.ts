import { beforeAll, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { autoMatchGa4, autoMatchGtm } from '../src/lib/server/connect';
import { syncGtm } from '../src/lib/server/channels';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { demoGtmLive } from '../src/lib/server/demo-channels';
import { pauseDuplicateTagsViaGtm, planDuplicateFix, type GtmTagEditor, type RawTag } from '../src/lib/server/gtmwrite';
import { summarizeVersion, type GtmLive, type GtmSource } from '../src/lib/server/gtm';
import { auditTracking, duplicateGoogleTags, type TrackingTag } from '../src/lib/tracking';
import { trackingHealth } from '../src/lib/server/tracking';
import { getSite } from '../src/lib/server/clients';
import { linksFor } from '../src/lib/server/links';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';

const t = (id: string, name: string, type: string, firing: string[], measurementId: string | null, paused = false): TrackingTag => ({ id, name, type, firing, measurementId, paused });

describe('finding duplicate Google tags', () => {
	it('keeps the tag on the Initialization trigger and pauses the rest; events, paused tags and other IDs do not count', () => {
		// the shape of the real container: two Google Analytics destination tags for one ID, plus a GA4 event tag
		const tags = [
			t('5', 'Google Analytics (added by SEOConsole)', 'dest_ga', ['All Pages'], 'G-71YY5G1HY9'),
			t('9', 'Google Analytics G-71YY5G1HY9', 'dest_ga', ['Initialization - All Pages'], 'G-71YY5G1HY9'),
			t('7', 'GA4 event - job_alert_signup', 'gaawe', ['Event - job_alert_signup'], 'G-71YY5G1HY9'),
			t('8', 'Old config', 'gaawc', ['All Pages'], 'G-71YY5G1HY9', true),
			t('10', 'Other property', 'googtag', ['All Pages'], 'G-OTHER0001')
		];
		const g = duplicateGoogleTags(tags);
		expect(g).toHaveLength(1);
		expect(g[0].measurementId).toBe('G-71YY5G1HY9');
		expect(g[0].keep.name).toBe('Google Analytics G-71YY5G1HY9');
		expect(g[0].pause.map((x) => x.name)).toEqual(['Google Analytics (added by SEOConsole)']);
	});

	it('reads older snapshots that name built-in triggers by ID, and without an Initialization tag keeps one SEOConsole did not add, then the oldest', () => {
		expect(duplicateGoogleTags([t('5', 'A (added by SEOConsole)', 'googtag', ['All Pages'], 'G-X1234'), t('9', 'B', 'dest_ga', ['trigger 2147479573'], 'G-X1234')])[0].keep.name).toBe('B');
		expect(duplicateGoogleTags([t('2', 'Mine (added by SEOConsole)', 'googtag', ['All Pages'], 'G-X1234'), t('9', 'Theirs', 'googtag', ['All Pages'], 'G-X1234')])[0].keep.name).toBe('Theirs');
		expect(duplicateGoogleTags([t('9', 'Newer', 'googtag', ['All Pages'], 'G-X1234'), t('3', 'Older', 'gaawc', ['All Pages'], 'G-X1234')])[0].keep.name).toBe('Older');
		// a tag with no trigger never fires, so it is not a duplicate
		expect(duplicateGoogleTags([t('1', 'A', 'googtag', ['All Pages'], 'G-X1234'), t('2', 'B', 'googtag', [], 'G-X1234')])).toEqual([]);
	});

	it('the tracking audit warns, naming the tags, what to keep and what to pause', () => {
		const f = auditTracking({ gtm: { publicId: 'GTM-1', published: true, tags: [t('5', 'Dup', 'dest_ga', ['All Pages'], 'G-X1234'), t('9', 'Main', 'dest_ga', ['Initialization - All Pages'], 'G-X1234')] }, ga4: { measurementIds: ['G-X1234'] }, traffic: { days: 28, gscClicks: 0, ga4OrganicSessions: null } }).find((x) => x.id === 'gtm-duplicate-google-tag');
		expect(f).toMatchObject({ severity: 'warning', title: '2 tags load GA4 for G-X1234' });
		expect(f!.detail).toContain('Keep “Main” (on Initialization - All Pages)');
	});

	it('a duplicate put to rest is a note, not a "paused tag" warning; any other paused tag still warns', () => {
		const findings = (tags: TrackingTag[]) => auditTracking({ gtm: { publicId: 'GTM-1', published: true, tags }, ga4: { measurementIds: ['G-X1234'] }, traffic: { days: 28, gscClicks: 0, ga4OrganicSessions: null } });
		const rested = findings([t('5', 'Dup', 'dest_ga', ['All Pages'], 'G-X1234', true), t('9', 'Main', 'dest_ga', ['Initialization - All Pages'], 'G-X1234')]);
		expect(rested.map((f) => f.id)).toEqual(['gtm-paused-duplicate']);
		expect(rested[0]).toMatchObject({ severity: 'info', title: '1 duplicate Google tag paused' });
		// the only Google tag for an ID, paused: GA4 gets nothing, so it still warns
		expect(findings([t('5', 'Only', 'dest_ga', ['All Pages'], 'G-X1234', true)]).some((f) => f.id === 'gtm-paused')).toBe(true);
		expect(findings([t('1', 'Main', 'googtag', ['All Pages'], 'G-X1234'), t('2', 'Old remarketing', 'sp', ['All Pages'], null, true)]).find((f) => f.id === 'gtm-paused')!.detail).toContain('Old remarketing');
	});

	it('built-in triggers are named when the version is read', () => {
		const v = summarizeVersion({ containerVersionId: '3', tag: [{ tagId: '1', name: 'G', type: 'dest_ga', firingTriggerId: ['2147479573', '2147479553', '42'], parameter: [{ key: 'destinationId', value: 'G-X1234' }] }] });
		expect(v.tags[0].firing).toEqual(['Initialization - All Pages', 'All Pages', 'trigger 42']);
		expect(v.tags[0].measurementId).toBe('G-X1234');
	});
});

describe('pausing duplicates through Tag Manager', () => {
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
		id = siteId('pixelforge');
		container = linksFor(id).gtm!.external_id;
		await syncGtm(id);
	}, 120_000);

	const rig = (o: { latest?: string; alreadyPaused?: boolean } = {}) => {
		const calls: string[] = [];
		const written: { tagId: string; tag: RawTag }[] = [];
		const live: GtmLive = summarizeVersion({
			containerVersionId: '3',
			tag: [
				{ tagId: '5', name: 'Google Analytics (added by SEOConsole)', type: 'dest_ga', firingTriggerId: ['2147479553'], parameter: [{ key: 'destinationId', value: 'G-71YY5G1HY9' }] },
				{ tagId: '9', name: 'Google Analytics G-71YY5G1HY9', type: 'dest_ga', firingTriggerId: ['2147479573'], parameter: [{ key: 'destinationId', value: 'G-71YY5G1HY9' }] }
			]
		});
		const source: GtmSource = { listContainers: async () => [{ path: container, publicId: 'GTM-PV6WJZ8J', name: 'Six Figure Jobs', domains: [], usage: ['web'], accountName: 'a' }], liveVersion: async () => live };
		const writer: GtmTagEditor = {
			latestVersionId: async () => o.latest ?? '3',
			createWorkspace: async (c) => (calls.push('workspace'), { path: `${c}/workspaces/56`, workspaceId: '56' }),
			createTag: async () => { throw new Error('the fix must never create a tag'); },
			getTag: async (_w, tagId) => (calls.push(`get ${tagId}`), { tagId, name: 'x', type: 'dest_ga', fingerprint: 'fp', paused: o.alreadyPaused, parameter: [{ key: 'destinationId', value: 'G-71YY5G1HY9' }] }),
			updateTag: async (_w, tagId, tag) => void (calls.push(`update ${tagId}`), written.push({ tagId, tag })),
			createVersion: async () => (calls.push('version'), { path: `${container}/versions/4`, versionId: '4', compilerError: false }),
			publish: async () => (calls.push('publish'), { versionId: '4', compilerError: false })
		};
		return { calls, written, source, writer };
	};

	it('the plan names the tag kept and the one paused, and changes nothing', async () => {
		const r = rig();
		const p = await planDuplicateFix(id, { source: r.source, writer: r.writer });
		expect(p.ok).toBe(true);
		expect(p.groups).toEqual([{ measurementId: 'G-71YY5G1HY9', keep: { tagId: '9', name: 'Google Analytics G-71YY5G1HY9', firing: ['Initialization - All Pages'] }, pause: [{ tagId: '5', name: 'Google Analytics (added by SEOConsole)', firing: ['All Pages'] }] }]);
		expect(p.canPublish).toBe(true);
		expect(r.calls).toEqual([]);
	});

	it('publish: new workspace, only the duplicate paused with everything else kept, then version and publish', async () => {
		const r = rig();
		const res = await pauseDuplicateTagsViaGtm(id, 'publish', { source: r.source, writer: r.writer });
		expect(res).toMatchObject({ ok: true, published: true, versionId: '4', paused: ['Google Analytics (added by SEOConsole)'] });
		expect(r.calls).toEqual(['workspace', 'get 5', 'update 5', 'version', 'publish']);
		expect(r.written[0].tag).toMatchObject({ tagId: '5', paused: true, fingerprint: 'fp', parameter: [{ key: 'destinationId', value: 'G-71YY5G1HY9' }] });
		const log = db().prepare("SELECT action FROM audit_log WHERE action LIKE 'gtm.duplicate%' ORDER BY id DESC LIMIT 1").get() as { action: string };
		expect(log.action).toBe('gtm.duplicate_published');
	});

	it('refuses to publish over a newer unpublished version, and stops if the tag was paused meanwhile', async () => {
		const blocked = rig({ latest: '5' });
		const res = await pauseDuplicateTagsViaGtm(id, 'publish', { source: blocked.source, writer: blocked.writer });
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/newer version/);
		expect(blocked.calls).toEqual([]);
		const changed = rig({ alreadyPaused: true });
		const r2 = await pauseDuplicateTagsViaGtm(id, 'publish', { source: changed.source, writer: changed.writer });
		expect(r2.ok).toBe(false);
		expect(r2.error).toMatch(/already paused/);
		expect(changed.calls).toEqual(['workspace', 'get 5']);
	});

	it('demo, through the connector: a read-only key is refused, preview changes nothing, publish pauses the duplicate and the warning goes away', async () => {
		expect(trackingHealth(getSite(id)!, 28).findings.some((f) => f.id === 'gtm-duplicate-google-tag')).toBe(true);
		const call = async (key: string, args: object) => {
			const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fix_duplicate_google_tag', arguments: { site: String(id), ...args } } }) }));
			const out = (await res.json()).result;
			return { isError: !!out.isError, text: out.content[0].text as string };
		};
		const reader = createApiKey('r', null).key;
		expect((await call(reader, { mode: 'publish' })).isError).toBe(true);
		const writer = createApiKey('w', null, null, 'submit').key;
		const preview = JSON.parse((await call(writer, {})).text);
		expect(preview).toMatchObject({ ok: true, canPublish: true });
		expect(preview.groups[0].pause.map((t: { name: string }) => t.name)).toEqual(['GA4 Configuration (old)']);
		expect(demoGtmLive(container)!.tags.find((x) => x.name === 'GA4 Configuration (old)')!.paused).toBe(false);
		const out = await call(writer, { mode: 'publish' });
		expect(out.isError, out.text).toBe(false);
		const res = JSON.parse(out.text);
		expect(res).toMatchObject({ ok: true, published: true, paused: ['GA4 Configuration (old)'] });
		expect(demoGtmLive(container)!.tags.find((x) => x.name === 'GA4 Configuration (old)')!.paused).toBe(true);
		await syncGtm(id);
		expect(trackingHealth(getSite(id)!, 28).findings.some((f) => f.id === 'gtm-duplicate-google-tag')).toBe(false);
		expect((await planDuplicateFix(id)).error).toMatch(/No measurement ID has more than one/);
	});
});
