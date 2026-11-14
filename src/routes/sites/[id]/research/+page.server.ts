import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { backlinkPlan, gapPlan, researchFor, runBacklinks, runGap, runSerp, serpCandidates, serpPlan, serpPlanFrom, SERP_MAX } from '$lib/server/openseoresearch';
import { openSeoFor } from '$lib/server/openseolink';
import { SERP_VERDICT_LABEL, FORMAT_LABEL } from '$lib/serpformat';

export const load: PageServerLoad = async ({ params }) => {
	const site = getSite(Number(params.id))!;
	const os = openSeoFor(site.id);
	const r = researchFor(site.id);
	// The plans are worked out here from stored Search Console data: nothing is sent to OpenSEO until a button is pressed.
	return {
		linked: !!os,
		project: os?.projectName ?? null,
		serp: os ? serpPlanFrom(serpCandidates(site, SERP_MAX), 10) : null,
		gap: os ? gapPlan(site.id, 30) : null,
		backlinks: os ? backlinkPlan(site.id) : null,
		stored: {
			serp: r.serp && { fetchedAt: r.serp.fetchedAt, credits: r.serp.credits, ...r.serp.data },
			gap: r.gap && { fetchedAt: r.gap.fetchedAt, ...r.gap.data },
			backlinks: r.backlinks && { fetchedAt: r.backlinks.fetchedAt, ...r.backlinks.data }
		},
		serpMax: SERP_MAX,
		labels: { verdict: SERP_VERDICT_LABEL, format: FORMAT_LABEL }
	};
};

const wrap = async (f: () => Promise<string>) => {
	try {
		return { ok: await f() };
	} catch (e) {
		return fail(502, { error: e instanceof Error ? e.message : 'OpenSEO failed.' });
	}
};

export const actions: Actions = {
	serp: ({ params, request }) => wrap(async () => {
		const n = Math.min(SERP_MAX, Math.max(1, Number((await request.formData()).get('n')) || 10));
		const plan = serpPlan(Number(params.id), n);
		const r = await runSerp(Number(params.id), plan.keywords);
		return `Looked up ${r.asked} results pages${r.failed ? ` (${r.failed} could not be read)` : ''}.`;
	}),
	gap: ({ params }) => wrap(async () => {
		const plan = gapPlan(Number(params.id), 30);
		const r = await runGap(Number(params.id), plan.keywords);
		return `Compared on ${r.keywordsUsed} searches, studied ${r.studied.length} ${r.studied.length === 1 ? 'competitor' : 'competitors'}, found ${r.rows.length} keyword ${r.rows.length === 1 ? 'gap' : 'gaps'}.`;
	}),
	backlinks: ({ params }) => wrap(async () => {
		const r = await runBacklinks(Number(params.id));
		return `Read ${r.profile.backlinks} backlink${r.profile.backlinks === 1 ? '' : 's'}; ${r.reclaim.length} ${r.reclaim.length === 1 ? 'page' : 'pages'} of yours that no longer work still ${r.reclaim.length === 1 ? 'has' : 'have'} links.`;
	})
};
