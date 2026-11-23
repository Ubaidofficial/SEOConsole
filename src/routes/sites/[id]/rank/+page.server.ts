import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { MAX_ADD_AT_ONCE, MAX_TRACKED, rankReport, trackQueries, trackSuggestions, untrackQueries } from '$lib/server/ranktrack';
import { brandTerms } from '$lib/server/queries';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const r = rankReport(site, days);
	return { ...r, suggestions: trackSuggestions(site, 15), brandTerms: brandTerms(site), max: { atOnce: MAX_ADD_AT_ONCE, total: MAX_TRACKED } };
};

export const actions: Actions = {
	add: async ({ params, request }) => {
		const f = await request.formData();
		const list = [...f.getAll('query').map(String), ...String(f.get('queries') ?? '').split('\n')];
		const r = trackQueries(Number(params.id), list);
		if (r.error) return fail(400, { error: r.error });
		return { ok: `Tracking ${r.added} more search${r.added === 1 ? '' : 'es'}${r.already ? ` (${r.already} already tracked)` : ''}.` };
	},
	remove: async ({ params, request }) => {
		const n = untrackQueries(Number(params.id), (await request.formData()).getAll('query').map(String));
		return { ok: `Stopped tracking ${n} search${n === 1 ? '' : 'es'}.` };
	}
};
