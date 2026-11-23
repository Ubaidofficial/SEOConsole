import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { config } from '$lib/server/config';
import { getSite } from '$lib/server/clients';
import { linksFor } from '$lib/server/links';
import { gtmSnapshot, trackingHealth } from '$lib/server/tracking';
import { tagTypeLabel } from '$lib/server/gtm';
import { hasGtmWrite, pauseDuplicateTagsViaGtm, planDuplicateFix, planTagIdRepair, repairTagIdViaGtm } from '$lib/server/gtmwrite';
import { duplicateGoogleTags } from '$lib/tracking';
import { enqueueLinkSync } from '$lib/server/jobs';
import { applyKeyEvent, discoverSiteEvents, planKeyEvent } from '$lib/server/keyevents';

/** Can SEOConsole edit this site's container? Only asked about once a Google tag has a malformed ID (the repair button). */
function repairState(siteId: number, hasBadTag: boolean) {
	const gtm = linksFor(siteId).gtm;
	const acc = gtm?.account_id ? (db().prepare('SELECT email, scopes, is_demo FROM accounts WHERE id = ?').get(gtm.account_id) as { email: string; scopes: string; is_demo: number } | undefined) : undefined;
	return { show: hasBadTag && !!gtm, canWrite: !!acc && hasGtmWrite(acc), account: acc?.email ?? null, readOnly: config.readOnly };
}

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const link = linksFor(site.id).gtm;
	const health = trackingHealth(site, days);
	const snap = link ? gtmSnapshot(site.id) : null;
	return {
		linked: !!link,
		container: link ? link.label ?? link.external_id : null,
		status: link ? { state: link.sync_status, message: link.sync_message, lastSync: link.last_sync_at } : null,
		findings: health.findings,
		window: { days, clicks: health.input.traffic.gscClicks, ga4: health.input.traffic.ga4OrganicSessions },
		sources: health.sources,
		repair: repairState(site.id, !!snap?.tags.some((t) => t.badTagId)),
		duplicate: repairState(site.id, !!snap?.published && duplicateGoogleTags(snap.tags).length > 0),
		keyEvent: (({ canWrite, account }) => ({ canWrite, account, readOnly: config.readOnly, ga4Linked: !!linksFor(site.id).ga4 }))(repairState(site.id, true)),
		snapshot: snap && {
			publicId: snap.publicId,
			published: snap.published,
			versionName: snap.versionName,
			versionId: snap.versionId,
			counts: { tags: snap.tags.length, triggers: snap.triggers.length, variables: snap.variables.length },
			tags: (() => {
				// Tags the duplicate check would pause, so the table can point at them.
				const extra = new Set(duplicateGoogleTags(snap.tags).flatMap((g) => g.pause.map((t) => t.id ?? t.name)));
				return snap.tags.map((t) => ({ ...t, typeLabel: tagTypeLabel(t.type), duplicate: extra.has(t.id ?? t.name) }));
			})()
		}
	};
};

/** The form's event name and parameters ("alert_form, alert_frequency" or one per line). */
const keyEventInput = (f: FormData) => ({
	event: String(f.get('event') ?? ''),
	params: String(f.get('params') ?? '').split(/[\s,]+/).filter(Boolean),
	measurementId: String(f.get('measurementId') ?? '').trim() || undefined
});

export const actions: Actions = {
	/** The dataLayer events the site's own scripts push, to pick one to track. Reads the site, changes nothing. */
	keyEventDiscover: async ({ params }) => {
		const keFound = await discoverSiteEvents(Number(params.id)).catch((e) => ({ events: [], read: { pages: 0, scripts: 0 }, note: e instanceof Error ? e.message : String(e) }));
		return { keFound };
	},
	/** "Track as a key event": what would be created in Tag Manager and GA4, read live. Changes nothing. */
	keyEventPlan: async ({ params, request }) => {
		const input = keyEventInput(await request.formData());
		const kePlan = await planKeyEvent(Number(params.id), input).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
		if (!kePlan.ok) return fail(400, { kePlan, keInput: input });
		return { kePlan, keInput: input };
	},
	/** The confirmed change: variables, trigger and GA4 event tag in a new workspace (published if asked and safe), then the key event in GA4. */
	keyEventApply: async ({ params, request }) => {
		const f = await request.formData();
		const input = keyEventInput(f);
		const mode = f.get('mode') === 'publish' ? 'publish' : 'workspace';
		const keResult = await applyKeyEvent(Number(params.id), input, mode).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e), published: false }));
		if (!keResult.ok) return fail(400, { keResult, keInput: input });
		enqueueLinkSync(Number(params.id), 'gtm');
		return { keResult, keInput: input };
	},
	/** Which duplicate Google tags would be paused, read live from Tag Manager. Changes nothing. */
	duplicatePlan: async ({ params }) => {
		const dupPlan = await planDuplicateFix(Number(params.id)).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
		if (!dupPlan.ok) return fail(400, { dupPlan });
		return { dupPlan };
	},
	/** The confirmed change: the duplicates paused in a new workspace, published only if asked and safe. */
	duplicateApply: async ({ params, request }) => {
		const siteId = Number(params.id);
		const mode = (await request.formData()).get('mode') === 'publish' ? 'publish' : 'workspace';
		const dupResult = await pauseDuplicateTagsViaGtm(siteId, mode).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e), published: false }));
		if (!dupResult.ok) return fail(400, { dupResult });
		// Re-read the container so the finding above catches up.
		enqueueLinkSync(siteId, 'gtm');
		return { dupResult };
	},
	/** What the fix would change and which IDs it could use, read live from Tag Manager. Changes nothing. */
	repairPlan: async ({ params }) => {
		const plan = await planTagIdRepair(Number(params.id)).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
		if (!plan.ok) return fail(400, { plan });
		return { plan };
	},
	/** The confirmed change: a new workspace with the corrected Tag ID, published only if asked and safe. */
	repairApply: async ({ params, request }) => {
		const f = await request.formData();
		const siteId = Number(params.id);
		const tagId = String(f.get('tagId') ?? '');
		// A typed ID wins over the chosen one; both are checked against the measurement-ID pattern on the server.
		const newId = String(f.get('otherId') ?? '').trim() || String(f.get('newId') ?? '');
		const mode = f.get('mode') === 'publish' ? 'publish' : 'workspace';
		const result = await repairTagIdViaGtm(siteId, { tagId, newId }, mode).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e), published: false }));
		if (!result.ok) return fail(400, { result });
		// Re-read the container so the finding above catches up.
		enqueueLinkSync(siteId, 'gtm');
		return { result, fixedId: newId.trim().toUpperCase() };
	}
};
