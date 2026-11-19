import { GoogleApiError, googleJson, accessToken, type HttpOptions } from './google';
import { db, audit } from './db';
import { config } from './config';
import { linksFor } from './links';
import { ga4SourceFor, gtmSourceFor } from './channels';
import { demoGtmWriter, hasGtmWrite, installTagViaWorkspace, realGtmWriter, type GtmTagEditor, type InstallResult, type RawTag } from './gtmwrite';
import { hasGa4Write } from './ga4write';

/**
 * "Track as a key event": a site already pushes an event to the dataLayer (window.dataLayer.push({event: 'job_alert_signup', …})), and
 * GA4 should count it as a key event (a conversion). Four steps, done for the owner:
 *  1. Tag Manager: one Data Layer Variable per event parameter ("DLV - alert_form"), reused when one with that name exists;
 *  2. a Custom Event trigger for the event ("Event - job_alert_signup"), reused when one with that name exists;
 *  3. a GA4 Event tag sending the event and its parameters to the site's measurement ID, fired by that trigger;
 *     all three in a NEW workspace, then a version and publish only when the newest version is the live one (same rule and helper
 *     as the Clarity install and the Tag ID repair);
 *  4. Google Analytics: mark the event as a key event (Admin API keyEvents.create), skipped when it already is one.
 * Every change is shown first (planKeyEvent) and needs a confirming call (applyKeyEvent).
 *
 * Tag Manager API v2 bodies (variables.create type "v" with dataLayerVersion/name; triggers.create type "customEvent" with a
 * customEventFilter on {{_event}}; tags.create type "gaawe" with eventName, measurementIdOverride and an eventSettingsTable of
 * parameter/parameterValue maps) and Admin API v1beta keyEvents (GET/POST properties/{id}/keyEvents, body {eventName, countingMethod})
 * are from my knowledge of the APIs and were NOT run against a live account here: check the first real use in Tag Manager and GA4.
 */
const GTM = 'https://tagmanager.googleapis.com/tagmanager/v2';
const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';

/** GA4 event and parameter names: a letter first, then letters, digits and underscores, at most 40 characters (GA4's collection limits). */
export const GA4_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
/** GA4 reserves these prefixes for its own events and parameters. */
const RESERVED = /^(ga_|google_|firebase_)/i;
export const MAX_PARAMS = 10;

export const variableName = (param: string) => `DLV - ${param}`;
export const triggerName = (event: string) => `Event - ${event}`;
export const tagName = (event: string) => `GA4 event - ${event} (added by SEOConsole)`;

export function variableBody(param: string) {
	return {
		name: variableName(param),
		type: 'v',
		parameter: [
			{ type: 'integer', key: 'dataLayerVersion', value: '2' },
			{ type: 'boolean', key: 'setDefaultValue', value: 'false' },
			{ type: 'template', key: 'name', value: param }
		],
		notes: 'Added from SEOConsole to send this dataLayer value to GA4. Safe to edit or delete here.'
	};
}

export function triggerBody(event: string) {
	return {
		name: triggerName(event),
		type: 'customEvent',
		customEventFilter: [{ type: 'equals', parameter: [{ type: 'template', key: 'arg0', value: '{{_event}}' }, { type: 'template', key: 'arg1', value: event }] }],
		notes: 'Added from SEOConsole: fires when the site pushes this event to the dataLayer.'
	};
}

/**
 * The GA4 Event tag. Besides the event, measurement ID and parameters it carries the flags every current GA4 Event tag has in published
 * containers (read from the live gtm.js of several public sites): sendEcommerceData, enableUserProperties, enableEuid, migratedToV2 and
 * demoV2. Without migratedToV2 Tag Manager refused to build a version on a real container, reporting a "Conflicting Google tag": the
 * container's Google tag and this tag "route to the same destination". Tag Manager's API reference does not document these keys.
 */
export function tagBody(event: string, measurementId: string, params: string[], triggerId: string) {
	return {
		name: tagName(event),
		type: 'gaawe',
		parameter: [
			{ type: 'template', key: 'eventName', value: event },
			{ type: 'template', key: 'measurementIdOverride', value: measurementId },
			...(params.length ? [{ type: 'list', key: 'eventSettingsTable', list: params.map((p) => ({ type: 'map', map: [{ type: 'template', key: 'parameter', value: p }, { type: 'template', key: 'parameterValue', value: `{{${variableName(p)}}}` }] })) }] : []),
			{ type: 'boolean', key: 'sendEcommerceData', value: 'false' },
			{ type: 'boolean', key: 'enableUserProperties', value: 'true' },
			{ type: 'boolean', key: 'enableEuid', value: 'true' },
			{ type: 'boolean', key: 'migratedToV2', value: 'true' },
			{ type: 'boolean', key: 'demoV2', value: 'false' }
		],
		firingTriggerId: [triggerId],
		tagFiringOption: 'oncePerEvent',
		notes: 'Added from SEOConsole so GA4 receives this dataLayer event (and counts it as a key event). Safe to edit or delete here.'
	};
}

// ── Google clients ───────────────────────────────────────────────────────────
type Named = { id: string; name: string };
/**
 * What this flow needs from Tag Manager on top of the shared writer (which can already read and rewrite a tag): the items already in a
 * workspace, creating variables and triggers, and the container's workspaces. No delete: deleting a workspace needs Google's
 * tagmanager.delete.containers permission, which also allows deleting whole containers, so SEOConsole reuses its own leftover workspace instead.
 */
export interface GtmEventWriter extends GtmTagEditor {
	list(workspace: string): Promise<{ variables: Named[]; triggers: Named[]; tags: (Named & { type: string; eventName: string | null })[] }>;
	createVariable(workspace: string, body: object): Promise<{ variableId: string }>;
	createTrigger(workspace: string, body: object): Promise<{ triggerId: string }>;
	/** The container's workspaces (path, name). */
	listWorkspaces(container: string): Promise<{ path: string; name: string }[]>;
}

/** The name prefix of the workspaces this flow creates for one event; a leftover one is an earlier attempt that never became a version. */
export const workspacePrefix = (event: string) => `SEOConsole key event ${event} `;

export interface KeyEventAdmin {
	/** Event names already marked as key events on the property. */
	listKeyEvents(property: string): Promise<string[]>;
	createKeyEvent(property: string, eventName: string): Promise<void>;
}

export function realEventWriter(accountId: number, http: HttpOptions = {}): GtmEventWriter {
	const base = realGtmWriter(accountId, http);
	const call = <T>(url: string, init?: RequestInit) => googleJson<T>(() => accessToken(accountId), url, init, http);
	const post = <T>(url: string, body: object) => call<T>(url, { method: 'POST', body: JSON.stringify(body) });
	return {
		...base,
		async list(ws) {
			const [v, t, g] = await Promise.all([
				call<{ variable?: { variableId?: string; name?: string }[] }>(`${GTM}/${ws}/variables`),
				call<{ trigger?: { triggerId?: string; name?: string }[] }>(`${GTM}/${ws}/triggers`),
				call<{ tag?: { tagId?: string; name?: string; type?: string; parameter?: { key?: string; value?: string }[] }[] }>(`${GTM}/${ws}/tags`)
			]);
			return {
				variables: (v.variable ?? []).map((x) => ({ id: x.variableId ?? '', name: x.name ?? '' })),
				triggers: (t.trigger ?? []).map((x) => ({ id: x.triggerId ?? '', name: x.name ?? '' })),
				tags: (g.tag ?? []).map((x) => ({ id: x.tagId ?? '', name: x.name ?? '', type: x.type ?? '', eventName: x.parameter?.find((p) => p.key === 'eventName')?.value ?? null }))
			};
		},
		async createVariable(ws, body) {
			return { variableId: (await post<{ variableId?: string }>(`${GTM}/${ws}/variables`, body)).variableId ?? '' };
		},
		async createTrigger(ws, body) {
			const r = await post<{ triggerId?: string }>(`${GTM}/${ws}/triggers`, body);
			if (!r.triggerId) throw new Error('Tag Manager did not return the new trigger.');
			return { triggerId: r.triggerId };
		},
		async listWorkspaces(container) {
			const r = await call<{ workspace?: { path?: string; name?: string }[] }>(`${GTM}/${container}/workspaces`);
			return (r.workspace ?? []).filter((w) => w.path).map((w) => ({ path: w.path!, name: w.name ?? '' }));
		}
	};
}

export function realKeyEventAdmin(accountId: number, http: HttpOptions = {}): KeyEventAdmin {
	const call = <T>(url: string, init?: RequestInit) => googleJson<T>(() => accessToken(accountId), url, init, http);
	return {
		async listKeyEvents(property) {
			const out: string[] = [];
			let pageToken = '';
			do {
				const q = new URLSearchParams({ pageSize: '200', ...(pageToken ? { pageToken } : {}) });
				const r = await call<{ keyEvents?: { eventName?: string }[]; nextPageToken?: string }>(`${ADMIN}/${property}/keyEvents?${q}`);
				for (const k of r.keyEvents ?? []) if (k.eventName) out.push(k.eventName);
				pageToken = r.nextPageToken ?? '';
			} while (pageToken);
			return out;
		},
		async createKeyEvent(property, eventName) {
			try {
				await call(`${ADMIN}/${property}/keyEvents`, { method: 'POST', body: JSON.stringify({ eventName, countingMethod: 'ONCE_PER_EVENT' }) });
			} catch (e) {
				// Marked in the meantime (another tab, or GA4 itself): that is the outcome wanted.
				if (e instanceof GoogleApiError && e.status === 409) return;
				throw e;
			}
		}
	};
}

// ── demo ─────────────────────────────────────────────────────────────────────
/** What the demo "created", so a second run reuses it like a real container would. Keyed by container path / property. */
export const demoKeyEvents = { items: new Map<string, { variables: Named[]; triggers: Named[]; tags: (Named & { type: string; eventName: string | null })[] }>(), keyEvents: new Map<string, string[]>(), workspaces: new Map<string, { path: string; name: string }[]>(), rewritten: [] as string[] };

function demoEventWriter(container: string): GtmEventWriter {
	const base = demoGtmWriter();
	const items = () => {
		if (!demoKeyEvents.items.has(container)) demoKeyEvents.items.set(container, { variables: [], triggers: [{ id: '2147479553', name: 'All Pages' }], tags: [] });
		return demoKeyEvents.items.get(container)!;
	};
	let n = 100;
	return {
		...base,
		list: async () => structuredClone(items()),
		createVariable: async (_w, body) => {
			const id = String(++n);
			items().variables.push({ id, name: (body as { name: string }).name });
			return { variableId: id };
		},
		createTrigger: async (_w, body) => {
			const id = String(++n);
			items().triggers.push({ id, name: (body as { name: string }).name });
			return { triggerId: id };
		},
		listWorkspaces: async (c) => [...(demoKeyEvents.workspaces.get(c) ?? [])],
		getTag: async (_w, tagId) => {
			const t = items().tags.find((x) => x.id === tagId);
			return { tagId, name: t?.name, type: t?.type, fingerprint: 'demo', parameter: [{ type: 'template', key: 'eventName', value: t?.eventName ?? '' }] };
		},
		updateTag: async (_w, tagId, tag) => {
			const t = items().tags.find((x) => x.id === tagId);
			if (t) t.name = tag.name ?? t.name;
			demoKeyEvents.rewritten.push(tagId);
		},
		createTag: async (_w, body) => {
			const b = body as { name: string; type: string; parameter: { key: string; value?: string }[] };
			const id = String(++n);
			items().tags.push({ id, name: b.name, type: b.type, eventName: b.parameter.find((p) => p.key === 'eventName')?.value ?? null });
			return { tagId: id };
		}
	};
}

function demoAdmin(): KeyEventAdmin {
	return {
		listKeyEvents: async (p) => [...(demoKeyEvents.keyEvents.get(p) ?? [])],
		createKeyEvent: async (p, e) => void demoKeyEvents.keyEvents.set(p, [...(demoKeyEvents.keyEvents.get(p) ?? []), e])
	};
}

// ── plan and apply ───────────────────────────────────────────────────────────
export interface KeyEventInput { event: string; params?: string[]; measurementId?: string }
export interface KeyEventPlan {
	ok: boolean;
	error?: string;
	/** Which permission is missing: Tag Manager editing ("gtm-write") or Google Analytics editing ("setup", which also covers Tag Manager). */
	needsGrant?: 'gtm-write' | 'setup';
	event?: string;
	params?: string[];
	measurementId?: string;
	container?: { path: string; publicId: string };
	property?: string | null;
	/** Human-readable list of what will be created or reused. */
	changes?: string[];
	/** The live container already has a GA4 event tag for this event: nothing to add in Tag Manager. */
	alreadyTagged?: boolean;
	/** Already a key event in GA4 (null: not known, no GA4 edit permission or no linked property). */
	alreadyKeyEvent?: boolean | null;
	/** SEOConsole may mark the key event (GA4 linked and editable). */
	canMarkKeyEvent?: boolean;
	/** A workspace an earlier run for this event left behind (never turned into a version): the change is made in it instead of a new one. */
	reuseWorkspace?: { path: string; name: string } | null;
	canPublish?: boolean;
	publishBlocked?: string;
}
export interface KeyEventResult extends InstallResult {
	/** marked: done now; already: it was one; skipped: no GA4 edit permission or no linked property; failed: see keyEventError. */
	keyEvent?: 'marked' | 'already' | 'skipped' | 'failed';
	keyEventError?: string;
	/** Tag Manager already sent this event to GA4, so no workspace was made. */
	tagAlready?: boolean;
}
export interface KeyEventDeps { writer?: GtmEventWriter; admin?: KeyEventAdmin; measurementIds?: string[] }

/** Event name, parameters and measurement ID, checked; or why not. */
export function checkInput(i: KeyEventInput): { event: string; params: string[]; measurementId: string | null } | { error: string } {
	const event = String(i.event ?? '').trim();
	if (!GA4_NAME.test(event) || RESERVED.test(event)) return { error: 'The event name must start with a letter and use only letters, digits and underscores (at most 40), and not start with ga_, google_ or firebase_. Use the exact name the site pushes to the dataLayer, e.g. job_alert_signup.' };
	const params = [...new Set((i.params ?? []).map((p) => String(p).trim()).filter(Boolean))];
	if (params.length > MAX_PARAMS) return { error: `At most ${MAX_PARAMS} parameters.` };
	const bad = params.find((p) => !GA4_NAME.test(p) || RESERVED.test(p));
	if (bad) return { error: `"${bad}" is not a usable parameter name: a letter first, then letters, digits and underscores, at most 40.` };
	const measurementId = i.measurementId ? String(i.measurementId).trim().toUpperCase() : null;
	if (measurementId && !/^G-[A-Z0-9]{4,}$/.test(measurementId)) return { error: 'The measurement ID looks like G-XXXXXXXXXX.' };
	return { event, params, measurementId };
}

function accounts(siteId: number) {
	const links = linksFor(siteId);
	const row = (id: number | null | undefined) => (id ? (db().prepare('SELECT id, email, scopes, is_demo FROM accounts WHERE id = ?').get(id) as { id: number; email: string; scopes: string; is_demo: number } | undefined) : undefined);
	return { gtm: links.gtm, gtmAcc: row(links.gtm?.account_id), ga4: links.ga4, ga4Acc: row(links.ga4?.account_id) };
}

/** What would change, read live from Tag Manager and GA4. Changes nothing. */
export async function planKeyEvent(siteId: number, input: KeyEventInput, o: KeyEventDeps = {}): Promise<KeyEventPlan> {
	if (config.readOnly) return { ok: false, error: 'This server runs with READ_ONLY=1, so it never changes Tag Manager or Google Analytics.' };
	const c = checkInput(input);
	if ('error' in c) return { ok: false, error: c.error };
	const a = accounts(siteId);
	if (!a.gtm?.account_id || !a.gtmAcc) return { ok: false, error: 'Link a Tag Manager container to this site first (Connect page): the event reaches GA4 through a tag in it.' };
	if (!hasGtmWrite(a.gtmAcc)) return { ok: false, needsGrant: 'gtm-write', error: 'SEOConsole can read this container but not edit it yet.' };
	const container = a.gtm.external_id;
	const src = gtmSourceFor(a.gtmAcc.id);
	const [containers, live] = await Promise.all([src.listContainers(), src.liveVersion(container)]);
	const publicId = containers.find((x) => x.path === container)?.publicId ?? a.gtm.label ?? container;
	// The measurement ID: the one asked for, else the linked GA4 property's web stream, else the Google tag already in the container.
	let measurementId = c.measurementId;
	if (!measurementId && a.ga4?.account_id) measurementId = (o.measurementIds ?? (await ga4SourceFor(a.ga4.account_id).measurementIds(a.ga4.external_id).catch(() => [])))[0] ?? null;
	if (!measurementId) measurementId = live?.tags.find((t) => t.type === 'googtag' && t.measurementId)?.measurementId ?? null;
	if (!measurementId) return { ok: false, error: 'No GA4 measurement ID found: link a GA4 property to this site, or give the measurement ID (G-…).' };
	const writer = o.writer ?? (a.gtmAcc.is_demo ? demoEventWriter(container) : realEventWriter(a.gtmAcc.id));
	const latest = await writer.latestVersionId(container);
	const liveId = live?.versionId ?? null;
	const canPublish = !!liveId && latest === liveId;
	const alreadyTagged = !!live?.tags.some((t) => t.type === 'gaawe' && t.eventName === c.event && !t.paused);
	// Only workspaces this flow named for this very event: someone else's work is never touched.
	const reuseWorkspace = alreadyTagged ? null : ((await writer.listWorkspaces(container)).find((w) => w.name.startsWith(workspacePrefix(c.event))) ?? null);
	const haveVar = new Set(live?.variables.map((v) => v.name));
	const haveTrigger = !!live?.triggers.some((t) => t.name === triggerName(c.event));
	const canMarkKeyEvent = !!a.ga4?.account_id && !!a.ga4Acc && hasGa4Write(a.ga4Acc);
	let alreadyKeyEvent: boolean | null = null;
	if (canMarkKeyEvent) alreadyKeyEvent = (await (o.admin ?? (a.ga4Acc!.is_demo ? demoAdmin() : realKeyEventAdmin(a.ga4Acc!.id))).listKeyEvents(a.ga4!.external_id)).includes(c.event);
	const changes = alreadyTagged
		? [`Tag Manager already has a GA4 event tag for "${c.event}" in the live version: nothing to add there.`]
		: [
				...(reuseWorkspace ? [`Work in the workspace "${reuseWorkspace.name}" from an earlier SEOConsole run for this event that was never published, instead of making a new one; its GA4 event tag is rewritten`] : []),
				...c.params.map((p) => (haveVar.has(variableName(p)) ? `Reuse the variable "${variableName(p)}"` : `Add a Data Layer Variable "${variableName(p)}" reading ${p}`)),
				haveTrigger ? `Reuse the trigger "${triggerName(c.event)}"` : `Add a Custom Event trigger "${triggerName(c.event)}" for the dataLayer event ${c.event}`,
				`Add a GA4 Event tag "${tagName(c.event)}" sending ${c.event}${c.params.length ? ` with ${c.params.join(', ')}` : ''} to ${measurementId}`
			];
	if (canMarkKeyEvent) changes.push(alreadyKeyEvent ? `GA4 already counts ${c.event} as a key event.` : `In GA4 (${a.ga4!.label ?? a.ga4!.external_id}): mark ${c.event} as a key event.`);
	else changes.push(a.ga4 ? `GA4: marking ${c.event} as a key event needs Google Analytics edit permission (Allow below), or mark it by hand in GA4 Admin → Key events.` : `GA4: no property linked to this site, so ${c.event} is not marked as a key event; mark it in GA4 Admin → Key events.`);
	return {
		ok: true,
		event: c.event,
		params: c.params,
		measurementId,
		container: { path: container, publicId },
		property: a.ga4?.external_id ?? null,
		changes,
		alreadyTagged,
		alreadyKeyEvent,
		canMarkKeyEvent,
		reuseWorkspace,
		...(canMarkKeyEvent || !a.ga4 ? {} : { needsGrant: 'setup' as const }),
		canPublish,
		publishBlocked: canPublish ? undefined : !liveId ? 'The container has never been published, so publishing now would put everything in it live for the first time.' : `The container has a newer version (${latest}) than the live one (${liveId}). Publishing would put that version live too, so SEOConsole only prepares the change for you to publish.`
	};
}

/**
 * Make the change shown by planKeyEvent: the variables, trigger and tag in a new workspace (reusing any with the same names in it), a
 * version and publish when asked and safe, then the key event in GA4. A failed Tag Manager step stops before GA4 is touched.
 */
export async function applyKeyEvent(siteId: number, input: KeyEventInput, mode: 'publish' | 'workspace', o: KeyEventDeps = {}): Promise<KeyEventResult> {
	const plan = await planKeyEvent(siteId, input, o);
	if (!plan.ok) return { ok: false, error: plan.error, published: false };
	if (mode === 'publish' && !plan.alreadyTagged && !plan.canPublish) return { ok: false, error: plan.publishBlocked, published: false };
	const a = accounts(siteId);
	const event = plan.event!, params = plan.params!, measurementId = plan.measurementId!;
	let gtm: InstallResult = { ok: true, published: false };
	if (!plan.alreadyTagged) {
		const writer = o.writer ?? (a.gtmAcc!.is_demo ? demoEventWriter(plan.container!.path) : realEventWriter(a.gtmAcc!.id));
		const reuse = plan.reuseWorkspace ? { path: plan.reuseWorkspace.path, workspaceId: plan.reuseWorkspace.path.split('/').pop()! } : undefined;
		gtm = await installTagViaWorkspace(
			writer,
			{
				siteId,
				accountId: a.gtmAcc!.id,
				isDemo: !!a.gtmAcc!.is_demo,
				container: plan.container!.path,
				publicId: plan.container!.publicId,
				audit: 'gtm.key_event',
				existing: reuse,
				// no colon (Tag Manager rejects ":" in a name); the time keeps two runs on one day from clashing ("Found entity with duplicate name")
				workspaceName: `${workspacePrefix(event)}${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')}`.slice(0, 100),
				workspaceDescription: `Sends the dataLayer event ${event} to GA4 (${measurementId}). Created from SEOConsole.`,
				versionName: `Track ${event} in GA4 (SEOConsole)`.slice(0, 100),
				versionNotes: `GA4 event tag for the dataLayer event ${event}${params.length ? `, with ${params.join(', ')}` : ''}, sent to ${measurementId}.`,
				what: `GA4 event ${event}`,
				apply: async (ws) => {
					// The workspace starts from the newest version (or is our earlier one): reuse what is already there under the same names.
					const have = await writer.list(ws.path);
					const vars = new Set(have.variables.map((v) => v.name));
					for (const p of params) if (!vars.has(variableName(p))) await writer.createVariable(ws.path, variableBody(p));
					const trig = have.triggers.find((t) => t.name === triggerName(event))?.id ?? (await writer.createTrigger(ws.path, triggerBody(event))).triggerId;
					const body = tagBody(event, measurementId, params, trig);
					const ours = have.tags.find((t) => t.type === 'gaawe' && (t.eventName === event || t.name === tagName(event)));
					if (!ours) await writer.createTag(ws.path, body);
					// A tag an earlier run wrote (perhaps the way Tag Manager refused): rewrite it whole, keeping its ID; the fingerprint makes
					// Tag Manager refuse the write if the tag changed since it was read.
					else if (ours.name === tagName(event)) {
						const current: RawTag = await writer.getTag(ws.path, ours.id);
						await writer.updateTag(ws.path, ours.id, { ...body, tagId: ours.id, ...(current.fingerprint ? { fingerprint: current.fingerprint } : {}) });
					}
					// a GA4 event tag for this event that someone else made is left as it is
				}
			},
			mode
		);
		if (!gtm.ok) return gtm;
	}
	if (!plan.canMarkKeyEvent) return { ...gtm, tagAlready: plan.alreadyTagged, keyEvent: 'skipped' };
	if (plan.alreadyKeyEvent) return { ...gtm, tagAlready: plan.alreadyTagged, keyEvent: 'already' };
	try {
		await (o.admin ?? (a.ga4Acc!.is_demo ? demoAdmin() : realKeyEventAdmin(a.ga4Acc!.id))).createKeyEvent(a.ga4!.external_id, event);
		audit('ga4.key_event_created', { siteId, accountId: a.ga4Acc!.id, detail: `${a.ga4!.external_id}: ${event}` });
		return { ...gtm, tagAlready: plan.alreadyTagged, keyEvent: 'marked' };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		audit('ga4.key_event_failed', { siteId, accountId: a.ga4Acc!.id, detail: msg });
		return { ...gtm, tagAlready: plan.alreadyTagged, keyEvent: 'failed', keyEventError: `Google Analytics said: ${msg}` };
	}
}
