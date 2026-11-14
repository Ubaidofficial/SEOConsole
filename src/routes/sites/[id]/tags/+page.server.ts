import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { config } from '$lib/server/config';
import { getSite } from '$lib/server/clients';
import { linksFor } from '$lib/server/links';
import { gtmSnapshot, trackingHealth } from '$lib/server/tracking';
import { tagTypeLabel } from '$lib/server/gtm';
import { hasGtmWrite, planTagIdRepair, repairTagIdViaGtm } from '$lib/server/gtmwrite';
import { enqueueLinkSync } from '$lib/server/jobs';

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
		snapshot: snap && {
			publicId: snap.publicId,
			published: snap.published,
			versionName: snap.versionName,
			versionId: snap.versionId,
			counts: { tags: snap.tags.length, triggers: snap.triggers.length, variables: snap.variables.length },
			tags: snap.tags.map((t) => ({ ...t, typeLabel: tagTypeLabel(t.type) }))
		}
	};
};

export const actions: Actions = {
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
