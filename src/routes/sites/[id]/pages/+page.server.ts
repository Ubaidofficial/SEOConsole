import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { pageInsights } from '$lib/server/pageinsights';
import { PERIODS } from '$lib/periods';
import { deleteView, listGroups, listViews, matcherFor, saveView } from '$lib/server/groups';

export const load: PageServerLoad = async ({ params, parent, url }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const r = pageInsights(site, days);
	const groupId = Number(url.searchParams.get('group')) || null;
	const inGroup = groupId ? matcherFor(site.id, 'pages', groupId) : null;
	return {
		sources: { google: r.google, bing: r.bing, ga4: r.ga4, ai: r.ai, clarity: r.clarity, all: r.all, views: r.views },
		period: r.period,
		periods: [...PERIODS],
		allPeriod: (PERIODS as readonly number[]).includes(days),
		rows: r.rows.filter((x) => (groupId ? !!inGroup && inGroup(x.url) : true)).map((x) => ({ ...x, gCtr: x.gClicks != null && x.gImpr ? x.gClicks / x.gImpr : null })),
		group: groupId,
		groupMissing: !!groupId && !inGroup,
		pageGroups: listGroups(site.id, 'pages').map((g) => ({ id: g.id, name: g.name })),
		views: listViews(site.id, '/pages')
	};
};

export const actions: Actions = {
	saveView: async ({ params, request, locals }) => {
		const f = await request.formData();
		const r = saveView(Number(params.id), '/pages', String(f.get('name') ?? ''), String(f.get('params') ?? ''), locals.user?.email ?? locals.user?.name ?? null);
		return 'error' in r ? fail(400, { error: r.error }) : { ok: 'View saved.' };
	},
	deleteView: async ({ params, request }) => {
		const ok = deleteView(Number(params.id), Number((await request.formData()).get('id')));
		return ok ? { ok: 'View removed.' } : fail(404, { error: 'That view no longer exists.' });
	}
};
