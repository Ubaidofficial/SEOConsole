import { GoogleApiError, googleJson, accessToken, type HttpOptions } from './google';
import { db, audit } from './db';
import { config } from './config';
import { linksFor } from './links';
import { gtmSourceFor } from './channels';
import { claritySnippet, parseClarityId } from '../clarityinstall';
import { DEMO_PASTED_TAG, demoInstalled, demoRepaired } from './demo-channels';
import { GA_ID_KEYS, isBadTagIdValue, type GtmSource } from './gtm';

/**
 * Writing to Tag Manager: adding Microsoft Clarity (this file's plan/install pair), and, for "Set up GA4 & Tag Manager" (setup.ts), creating
 * a container and adding a Google tag. Both go through installTagViaWorkspace.
 *
 * The permission is separate and opt-in: the normal Google sign-in asks for read-only Tag Manager access, and these three
 * scopes are requested only when the owner clicks "Allow SEOConsole to edit Tag Manager" or the setup grant (never with READ_ONLY=1).
 *
 * Safety: the tag goes into a NEW workspace, so nobody's unfinished work is touched, and SEOConsole publishes only when the
 * container's newest version is the live one (otherwise publishing would also push someone else's unpublished version).
 * Every change is shown first and needs a confirming click.
 *
 * A third write, "Fix the Tag ID" (planTagIdRepair / repairTagIdViaGtm), edits ONE parameter of an existing Google tag whose Tag ID field holds
 * something that is not an ID (a whole pasted gtag.js snippet is the usual case): same new workspace, same publish rule, same preview and confirmation.
 * It changes nothing else in the tag, and refuses if the tag no longer has a malformed ID when it is read inside the new workspace.
 *
 * The Tag Manager API v2 calls below (workspaces.create, tags.create, tags.get, tags.update, workspaces.create_version, versions.publish,
 * version_headers.latest) and the built-in All Pages trigger ID are from my knowledge of the API and were NOT checked against a
 * live account here; check the first real use in Tag Manager.
 */
const BASE = 'https://tagmanager.googleapis.com/tagmanager/v2';
export const SCOPE_GTM_EDIT = 'https://www.googleapis.com/auth/tagmanager.edit.containers';
export const SCOPE_GTM_VERSIONS = 'https://www.googleapis.com/auth/tagmanager.edit.containerversions';
export const SCOPE_GTM_PUBLISH = 'https://www.googleapis.com/auth/tagmanager.publish';
export const GTM_WRITE_SCOPES = [SCOPE_GTM_EDIT, SCOPE_GTM_VERSIONS, SCOPE_GTM_PUBLISH];
/** Tag Manager's built-in "All Pages" trigger. */
export const ALL_PAGES_TRIGGER = '2147479553';
export const TAG_NAME = 'Microsoft Clarity (added by SEOConsole)';

export const hasGtmWrite = (a: { scopes: string; is_demo: number }) => !!a.is_demo || GTM_WRITE_SCOPES.every((s) => a.scopes.split(/\s+/).includes(s));

export interface GtmWriter {
	/** The newest container version's ID, live or not; null if there is none. */
	latestVersionId(container: string): Promise<string | null>;
	createWorkspace(container: string, name: string, description: string): Promise<{ path: string; workspaceId: string }>;
	createTag(workspace: string, tag: object): Promise<{ tagId: string }>;
	createVersion(workspace: string, name: string, notes: string): Promise<{ path: string; versionId: string; compilerError: boolean }>;
	publish(version: string): Promise<{ versionId: string; compilerError: boolean }>;
}

/** A tag as the Tag Manager API returns it. Only `parameter` is read here; everything else is sent back untouched. */
export interface RawTag { tagId?: string; name?: string; type?: string; fingerprint?: string; parameter?: { type?: string; key?: string; value?: string }[]; [k: string]: unknown }

/** What the Tag ID repair needs on top of a writer: read one tag from a workspace and write it back. (Separate so the install flows' writers stay as they were.) */
export interface GtmTagEditor extends GtmWriter {
	getTag(workspace: string, tagId: string): Promise<RawTag>;
	updateTag(workspace: string, tagId: string, tag: RawTag): Promise<void>;
}

export function realGtmWriter(accountId: number, http: HttpOptions = {}): GtmTagEditor {
	const call = <T>(url: string, init?: RequestInit) => googleJson<T>(() => accessToken(accountId), url, init, http);
	const post = <T>(url: string, body: object) => call<T>(url, { method: 'POST', body: JSON.stringify(body) });
	return {
		async latestVersionId(container) {
			try {
				return (await call<{ containerVersionId?: string }>(`${BASE}/${container}/version_headers:latest`)).containerVersionId ?? null;
			} catch (e) {
				if (e instanceof GoogleApiError && e.status === 404) return null;
				throw e;
			}
		},
		async createWorkspace(container, name, description) {
			const w = await post<{ path?: string; workspaceId?: string }>(`${BASE}/${container}/workspaces`, { name, description });
			if (!w.path) throw new Error('Tag Manager did not return the new workspace.');
			return { path: w.path, workspaceId: w.workspaceId ?? w.path.split('/').pop()! };
		},
		async createTag(workspace, tag) {
			const t = await post<{ tagId?: string }>(`${BASE}/${workspace}/tags`, tag);
			return { tagId: t.tagId ?? '' };
		},
		async createVersion(workspace, name, notes) {
			const r = await post<{ compilerError?: boolean; containerVersion?: { path?: string; containerVersionId?: string } }>(`${BASE}/${workspace}:create_version`, { name, notes });
			return { path: r.containerVersion?.path ?? '', versionId: r.containerVersion?.containerVersionId ?? '', compilerError: !!r.compilerError };
		},
		async publish(version) {
			const r = await post<{ compilerError?: boolean; containerVersion?: { containerVersionId?: string } }>(`${BASE}/${version}:publish`, {});
			return { versionId: r.containerVersion?.containerVersionId ?? '', compilerError: !!r.compilerError };
		},
		async getTag(workspace, tagId) {
			return call<RawTag>(`${BASE}/${workspace}/tags/${encodeURIComponent(tagId)}`);
		},
		async updateTag(workspace, tagId, tag) {
			// tags.update is a PUT of the whole tag; the fingerprint query parameter makes Tag Manager refuse the write if the tag changed since it was read.
			const q = tag.fingerprint ? `?fingerprint=${encodeURIComponent(tag.fingerprint)}` : '';
			await call<RawTag>(`${BASE}/${workspace}/tags/${encodeURIComponent(tagId)}${q}`, { method: 'PUT', body: JSON.stringify(tag) });
		}
	};
}

/** Demo: pretends to succeed; demoInstalled remembers the tag, so the demo container shows it afterwards. */
export function demoGtmWriter(): GtmTagEditor {
	let n = 0;
	return {
		latestVersionId: async () => '12',
		createWorkspace: async (c) => ({ path: `${c}/workspaces/${90 + ++n}`, workspaceId: String(90 + n) }),
		createTag: async () => ({ tagId: '99' }),
		createVersion: async (w) => ({ path: w.replace(/workspaces\/\d+$/, 'versions/13'), versionId: '13', compilerError: false }),
		publish: async () => ({ versionId: '13', compilerError: false }),
		// the demo's malformed tag: a Google tag with a whole pasted snippet where the ID belongs
		getTag: async (_w, tagId) => ({ tagId, name: 'Google tag', type: 'googtag', fingerprint: 'demo', parameter: [{ type: 'template', key: 'tagId', value: DEMO_PASTED_TAG }] }),
		updateTag: async (w, _id, tag) => void demoRepaired.set(w.replace(/\/workspaces\/\d+$/, ''), tag.parameter?.find((p) => p.key === 'tagId')?.value ?? '')
	};
}

export const GA4_TAG_NAME = 'Google tag (added by SEOConsole)';

/** Tag Manager accounts, and creating a web container in one. Tag Manager API v2 has no accounts.create, so an account cannot be made here. */
export interface GtmAdmin {
	listAccounts(): Promise<{ path: string; name: string }[]>;
	createContainer(account: string, c: { name: string; domainName: string[] }): Promise<{ path: string; publicId: string; name: string }>;
}

export function realGtmAdmin(accountId: number, http: HttpOptions = {}): GtmAdmin {
	const call = <T>(url: string, init?: RequestInit) => googleJson<T>(() => accessToken(accountId), url, init, http);
	return {
		async listAccounts() {
			const r = await call<{ account?: { path?: string; accountId?: string; name?: string }[] }>(`${BASE}/accounts`);
			return (r.account ?? []).slice(0, 50).map((a) => ({ path: a.path ?? `accounts/${a.accountId}`, name: a.name ?? a.accountId ?? '' }));
		},
		async createContainer(account, c) {
			// containers.create: POST /accounts/{id}/containers with a Container {name, usageContext, domainName}; scope tagmanager.edit.containers
			const r = await call<{ path?: string; containerId?: string; publicId?: string; name?: string }>(`${BASE}/${account}/containers`, { method: 'POST', body: JSON.stringify({ name: c.name, usageContext: ['web'], domainName: c.domainName }) });
			const path = r.path ?? (r.containerId ? `${account}/containers/${r.containerId}` : '');
			if (!path || !r.publicId) throw new Error('Tag Manager did not return the new container.');
			return { path, publicId: r.publicId, name: r.name ?? c.name };
		}
	};
}

/**
 * A Google tag (type googtag) for a GA4 measurement ID, firing on All Pages. The `tagId` parameter key matches what the
 * container reader in gtm.ts already looks for, but Google's API reference does not document tag-type parameters, so this
 * is NOT confirmed against a live container: check the first one in Tag Manager.
 */
export function ga4TagBody(measurementId: string) {
	return {
		name: GA4_TAG_NAME,
		type: 'googtag',
		parameter: [{ type: 'template', key: 'tagId', value: measurementId }],
		firingTriggerId: [ALL_PAGES_TRIGGER],
		tagFiringOption: 'oncePerEvent',
		notes: 'Added from SEOConsole so Google Analytics 4 collects visits. Safe to edit or delete here.'
	};
}

/** The Custom HTML tag Tag Manager stores: Clarity's own snippet, firing on All Pages. */
export function clarityTagBody(projectId: string) {
	return {
		name: TAG_NAME,
		type: 'html',
		parameter: [
			{ type: 'template', key: 'html', value: claritySnippet(projectId) },
			{ type: 'boolean', key: 'supportDocumentWrite', value: 'false' }
		],
		firingTriggerId: [ALL_PAGES_TRIGGER],
		tagFiringOption: 'oncePerEvent',
		notes: 'Added from SEOConsole so Microsoft Clarity records visits. Safe to edit or delete here.'
	};
}

export interface InstallPlan {
	ok: boolean;
	/** Why it cannot go ahead (no container, no permission, read-only server, bad ID). */
	error?: string;
	/** The owner must first allow SEOConsole to edit Tag Manager. */
	needsGrant?: boolean;
	projectId?: string;
	container?: { path: string; publicId: string; name: string };
	/** Clarity tags already in the live version. */
	existing?: { name: string; clarityId: string | null; firing: string[]; paused: boolean }[];
	/** Publishing is safe only when the newest version is the live one. */
	canPublish?: boolean;
	publishBlocked?: string;
	tagName?: string;
	snippet?: string;
}

function context(siteId: number) {
	const link = linksFor(siteId).gtm;
	if (!link?.account_id) return { error: 'Link a Tag Manager container to this site first (Connect page).' } as const;
	const acc = db().prepare('SELECT id, scopes, is_demo FROM accounts WHERE id = ?').get(link.account_id) as { id: number; scopes: string; is_demo: number } | undefined;
	if (!acc) return { error: 'The Google account that owns the container is no longer connected.' } as const;
	return { link, acc } as const;
}

/** What would change, without changing anything. */
export async function planClarityInstall(siteId: number, input: string, o: { writer?: GtmWriter } = {}): Promise<InstallPlan> {
	if (config.readOnly) return { ok: false, error: 'This server runs with READ_ONLY=1, so it never changes Tag Manager.' };
	const projectId = parseClarityId(input);
	if (!projectId) return { ok: false, error: 'Paste your Clarity project ID (like abc123xyz9) or the whole tracking code from Clarity.' };
	const ctx = context(siteId);
	if ('error' in ctx) return { ok: false, error: ctx.error, projectId };
	if (!hasGtmWrite(ctx.acc)) return { ok: false, needsGrant: true, projectId, error: 'SEOConsole can read this container but not edit it yet.' };
	const src = gtmSourceFor(ctx.acc.id);
	const [containers, live] = await Promise.all([src.listContainers(), src.liveVersion(ctx.link.external_id)]);
	const c = containers.find((x) => x.path === ctx.link.external_id);
	const writer = o.writer ?? (ctx.acc.is_demo ? demoGtmWriter() : realGtmWriter(ctx.acc.id));
	const latest = await writer.latestVersionId(ctx.link.external_id);
	const liveId = live?.versionId ?? null;
	const canPublish = !!liveId && latest === liveId;
	const existing = (live?.tags ?? []).filter((t) => t.clarity).map((t) => ({ name: t.name, clarityId: t.clarityId ?? null, firing: t.firing, paused: t.paused }));
	return {
		ok: true,
		projectId,
		container: { path: ctx.link.external_id, publicId: c?.publicId ?? ctx.link.label ?? ctx.link.external_id, name: c?.name ?? '' },
		existing,
		canPublish,
		publishBlocked: canPublish ? undefined : !liveId ? 'The container has never been published, so publishing now would put everything in it live for the first time.' : `The container has a newer version (${latest}) than the live one (${liveId}). Publishing would put that version live too, so SEOConsole only prepares the tag for you to publish.`,
		tagName: TAG_NAME,
		snippet: claritySnippet(projectId)
	};
}

export interface InstallResult {
	ok: boolean;
	error?: string;
	published: boolean;
	/** Where to review the change in Tag Manager. */
	reviewUrl?: string;
	versionId?: string;
}

export interface WorkspaceInstall {
	siteId: number;
	accountId: number;
	isDemo: boolean;
	container: string;
	publicId: string;
	/** The tag to add. Not used when `apply` is given. */
	tag?: object;
	/** Instead of adding a tag: change what is in the new workspace (the Tag ID repair edits an existing tag here). */
	apply?: (ws: { path: string; workspaceId: string }) => Promise<void>;
	/** Names the audit entries: `${audit}_prepared`, `${audit}_published`, `${audit}_failed`. */
	audit: string;
	workspaceName: string;
	workspaceDescription: string;
	versionName: string;
	versionNotes: string;
	/** What was added, for the audit entry ("Clarity abc123"). */
	what: string;
	/** Called once the tag exists (demo bookkeeping). */
	onTag?: () => void;
}

/** A new workspace with one tag in it, then (when asked and the caller has checked it is safe) a version and publish. Shared by the Clarity and GA4 installs. */
export async function installTagViaWorkspace(writer: GtmWriter, w: WorkspaceInstall, mode: 'publish' | 'workspace'): Promise<InstallResult> {
	const [, accountNum, , containerNum] = w.container.split('/');
	const ui = (ws: string) => `https://tagmanager.google.com/#/container/accounts/${accountNum}/containers/${containerNum}/workspaces/${ws}`;
	try {
		const ws = await writer.createWorkspace(w.container, w.workspaceName, w.workspaceDescription);
		if (w.apply) await w.apply(ws);
		else await writer.createTag(ws.path, w.tag!);
		w.onTag?.();
		if (mode === 'workspace') {
			audit(`${w.audit}_prepared`, { siteId: w.siteId, accountId: w.accountId, detail: `${w.publicId}: tag in workspace ${ws.workspaceId}, not published` });
			return { ok: true, published: false, reviewUrl: ui(ws.workspaceId) };
		}
		const v = await writer.createVersion(ws.path, w.versionName, w.versionNotes);
		if (v.compilerError || !v.path) return { ok: false, error: 'Tag Manager could not build a version from the workspace, and its API does not say why. Open the workspace in Tag Manager and click Submit: it lists the errors. Delete that workspace before trying again (a standard container allows three).', published: false, reviewUrl: ui(ws.workspaceId) };
		const p = await writer.publish(v.path);
		if (p.compilerError) return { ok: false, error: 'Tag Manager refused to publish the version. Open it in Tag Manager to see why.', published: false };
		audit(`${w.audit}_published`, { siteId: w.siteId, accountId: w.accountId, detail: `${w.publicId}: version ${p.versionId || v.versionId} published with ${w.what}` });
		return { ok: true, published: true, versionId: p.versionId || v.versionId, reviewUrl: `https://tagmanager.google.com/#/versions/accounts/${accountNum}/containers/${containerNum}` };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		audit(`${w.audit}_failed`, { siteId: w.siteId, accountId: w.accountId, detail: msg });
		// Standard containers allow three workspaces; this is the most likely refusal.
		const hint = /workspace/i.test(msg) && /limit|maximum|exceed/i.test(msg) ? ' Tag Manager allows three workspaces on a standard container; delete an old one and try again.' : '';
		return { ok: false, error: `Tag Manager said: ${msg}.${hint}`, published: false };
	}
}

/** Make the change shown by planClarityInstall: a new workspace with the Clarity tag, then (if safe and asked) a version and publish. */
export async function installClarityViaGtm(siteId: number, input: string, mode: 'publish' | 'workspace', o: { writer?: GtmWriter } = {}): Promise<InstallResult> {
	const plan = await planClarityInstall(siteId, input, o);
	if (!plan.ok) return { ok: false, error: plan.error, published: false };
	if (mode === 'publish' && !plan.canPublish) return { ok: false, error: plan.publishBlocked, published: false };
	const ctx = context(siteId);
	if ('error' in ctx) return { ok: false, error: ctx.error, published: false };
	const writer = o.writer ?? (ctx.acc.is_demo ? demoGtmWriter() : realGtmWriter(ctx.acc.id));
	return installTagViaWorkspace(
		writer,
		{
			siteId,
			accountId: ctx.acc.id,
			isDemo: !!ctx.acc.is_demo,
			container: plan.container!.path,
			publicId: plan.container!.publicId,
			tag: clarityTagBody(plan.projectId!),
			audit: 'gtm.clarity',
			// no colon: Tag Manager rejects ":" in a name
			workspaceName: `SEOConsole Microsoft Clarity ${new Date().toISOString().slice(0, 10)}`,
			workspaceDescription: `Adds Microsoft Clarity (project ${plan.projectId}) on all pages. Created from SEOConsole.`,
			versionName: 'Add Microsoft Clarity (SEOConsole)',
			versionNotes: `Microsoft Clarity project ${plan.projectId} on all pages.`,
			what: `Clarity ${plan.projectId}`,
			onTag: () => {
				if (ctx.acc.is_demo) demoInstalled.set(plan.container!.path, plan.projectId!);
			}
		},
		mode
	);
}


// ── Fix a Google tag's Tag ID ────────────────────────────────────────────────
const MEASUREMENT_ID = /^G-[A-Z0-9]{4,}$/;

/**
 * The tag with its one malformed ID parameter replaced by `newId`; every other parameter, and everything else on the tag, is left exactly as
 * it was. The parameter changed is the one the container reader sees (the first of tagId, measurementId, measurementIdOverride that has a
 * value). Throws, without changing anything, when that value is a real ID or a variable after all: the tag was edited since it was checked.
 */
export function repairedTag(tag: RawTag, newId: string): { tag: RawTag; key: string; was: string } {
	const params = tag.parameter ?? [];
	let i = -1;
	for (const key of GA_ID_KEYS) {
		i = params.findIndex((p) => p.key === key && !!p.value);
		if (i >= 0) break;
	}
	if (i < 0 || !isBadTagIdValue(params[i].value!)) throw new Error('This tag no longer has a malformed ID, so it was changed after it was checked. Nothing was edited.');
	return { tag: { ...tag, parameter: params.map((p, j) => (j === i ? { ...p, value: newId } : p)) }, key: params[i].key!, was: params[i].value! };
}

export interface RepairTag {
	/** Tag Manager's own ID for the tag (not the measurement ID) */
	tagId: string;
	name: string;
	type: string;
	/** what is in the ID field now, whitespace squashed and cut to 120 characters */
	current: string;
	paused: boolean;
	firing: string[];
	/** IDs the tag could be given: the one found inside the pasted text, and the linked GA4 property's */
	candidates: { id: string; from: 'inside' | 'property' }[];
	/** The one to preselect, or null when the choice is not obvious (the ID inside differs from the linked property's). */
	recommended: string | null;
}
export interface RepairPlan {
	ok: boolean;
	error?: string;
	needsGrant?: boolean;
	container?: { path: string; publicId: string; name: string };
	tags?: RepairTag[];
	canPublish?: boolean;
	publishBlocked?: string;
}

/** Why publishing is or is not safe: only when the newest version is the live one, otherwise it would put someone else's unpublished version live too. */
const publishGuard = (liveId: string | null, latest: string | null) => {
	const canPublish = !!liveId && latest === liveId;
	return { canPublish, publishBlocked: canPublish ? undefined : !liveId ? 'The container has never been published, so publishing now would put everything in it live for the first time.' : `The container has a newer version (${latest}) than the live one (${liveId}). Publishing would put that version live too, so SEOConsole only prepares the fix for you to publish.` };
};

/** What the repair would change and which IDs it could use, read live from Tag Manager, without changing anything. */
export async function planTagIdRepair(siteId: number, o: { writer?: GtmWriter; source?: GtmSource; ga4Ids?: string[] } = {}): Promise<RepairPlan> {
	if (config.readOnly) return { ok: false, error: 'This server runs with READ_ONLY=1, so it never changes Tag Manager.' };
	const ctx = context(siteId);
	if ('error' in ctx) return { ok: false, error: ctx.error };
	if (!hasGtmWrite(ctx.acc)) return { ok: false, needsGrant: true, error: 'SEOConsole can read this container but not edit it yet.' };
	const src = o.source ?? gtmSourceFor(ctx.acc.id);
	const [containers, live] = await Promise.all([src.listContainers(), src.liveVersion(ctx.link.external_id)]);
	const c = containers.find((x) => x.path === ctx.link.external_id);
	const container = { path: ctx.link.external_id, publicId: c?.publicId ?? ctx.link.label ?? ctx.link.external_id, name: c?.name ?? '' };
	if (!live) return { ok: false, error: 'The container has never been published, so there is no live tag to fix.', container };
	const bad = live.tags.filter((t) => ['googtag', 'gaawc', 'gaawe'].includes(t.type) && t.badTagId);
	if (!bad.length) return { ok: false, error: 'No Google tag in the live container has a malformed Tag ID (it may already be fixed).', container };
	const snap = db().prepare('SELECT ga4_measurement_ids g FROM gtm_snapshots WHERE site_id = ?').get(siteId) as { g: string } | undefined;
	const propIds = (o.ga4Ids ?? (snap ? (JSON.parse(snap.g) as string[]) : [])).map((x) => x.toUpperCase()).filter((x) => MEASUREMENT_ID.test(x));
	const tags: RepairTag[] = bad.map((t) => {
		const candidates: RepairTag['candidates'] = [];
		if (t.suggestedId) candidates.push({ id: t.suggestedId, from: 'inside' });
		for (const id of propIds) if (!candidates.some((x) => x.id === id)) candidates.push({ id, from: 'property' });
		// Preselect only when it is clear: the ID inside the text is the linked property's (or there is no property to compare with), or there is no ID inside and one property.
		const recommended = t.suggestedId ? (!propIds.length || propIds.includes(t.suggestedId) ? t.suggestedId : null) : propIds.length === 1 ? propIds[0] : null;
		return { tagId: t.id, name: t.name, type: t.type, current: t.badTagId ?? '', paused: t.paused, firing: t.firing, candidates, recommended };
	});
	const writer = o.writer ?? (ctx.acc.is_demo ? demoGtmWriter() : realGtmWriter(ctx.acc.id));
	const latest = await writer.latestVersionId(ctx.link.external_id);
	return { ok: true, container, tags, ...publishGuard(live.versionId ?? null, latest) };
}

/**
 * The confirmed change: a new workspace, the one malformed ID parameter replaced, then (if asked, and only when the newest version is the live one)
 * a version and publish. Re-plans first, so what is changed is what is live now, and refuses an ID that is not a measurement ID.
 */
export async function repairTagIdViaGtm(siteId: number, choice: { tagId: string; newId: string }, mode: 'publish' | 'workspace', o: { writer?: GtmTagEditor; source?: GtmSource; ga4Ids?: string[] } = {}): Promise<InstallResult> {
	const newId = choice.newId.trim().toUpperCase();
	if (!MEASUREMENT_ID.test(newId)) return { ok: false, error: 'The new Tag ID must be a measurement ID such as G-ABC123XYZ.', published: false };
	const plan = await planTagIdRepair(siteId, o);
	if (!plan.ok) return { ok: false, error: plan.error, published: false };
	const tag = plan.tags!.find((t) => t.tagId === choice.tagId);
	if (!tag) return { ok: false, error: 'That tag no longer has a malformed ID in the live container, so nothing was changed.', published: false };
	if (mode === 'publish' && !plan.canPublish) return { ok: false, error: plan.publishBlocked, published: false };
	const ctx = context(siteId);
	if ('error' in ctx) return { ok: false, error: ctx.error, published: false };
	const editor = o.writer ?? (ctx.acc.is_demo ? demoGtmWriter() : realGtmWriter(ctx.acc.id));
	const workspaceName = `SEOConsole fix Tag ID ${new Date().toISOString().slice(0, 10)}`;
	return installTagViaWorkspace(
		editor,
		{
			siteId,
			accountId: ctx.acc.id,
			isDemo: !!ctx.acc.is_demo,
			container: plan.container!.path,
			publicId: plan.container!.publicId,
			apply: async (ws) => {
				try {
					const t = await editor.getTag(ws.path, tag.tagId);
					const r = repairedTag(t, newId);
					await editor.updateTag(ws.path, tag.tagId, r.tag);
				} catch (e) {
					// The workspace was already created: say so, because standard containers allow only three.
					throw new Error(`${e instanceof Error ? e.message : String(e)} (SEOConsole had already created the empty workspace "${workspaceName}"; delete it in Tag Manager if you do not need it)`);
				}
			},
			audit: 'gtm.tagid',
			// no colon: Tag Manager rejects ":" in a name
			workspaceName,
			workspaceDescription: `Sets the Tag ID of "${tag.name}" to ${newId}. Created from SEOConsole.`,
			versionName: 'Fix Google tag ID (SEOConsole)',
			versionNotes: `The Tag ID of "${tag.name}" held text that is not an ID; it is now ${newId}.`,
			what: `Tag ID of "${tag.name}" set to ${newId}`
		},
		mode
	);
}
