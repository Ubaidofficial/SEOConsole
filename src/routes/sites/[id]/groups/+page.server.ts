import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { countryCannibalReport, groupsReport, heatmapReport, localesReport } from '$lib/server/insights';
import { brandTerms } from '$lib/server/queries';
import { deleteGroup, groupsReportFor, saveGroup, type GroupKind } from '$lib/server/groups';

const VIEWS = ['buckets', 'pagegroups', 'folders', 'topics', 'heatmap', 'locales'] as const;

export const load: PageServerLoad = async ({ params, parent, url }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const v = url.searchParams.get('view') as (typeof VIEWS)[number];
	const view = VIEWS.includes(v) ? v : 'buckets';
	const depth = Math.min(4, Math.max(1, Number(url.searchParams.get('depth')) || 1));
	const by = url.searchParams.get('by') === 'page' ? ('page' as const) : ('group' as const);
	const base = { view, days, depth, by, brandTerms: brandTerms(site) };
	if (view === 'buckets' || view === 'pagegroups') {
		const kind: GroupKind = view === 'buckets' ? 'bucket' : 'pages';
		const r = groupsReportFor(site, kind, days);
		return { ...base, mine: { kind, rows: r.rows, comparable: r.comparable, groups: r.groups.map((g) => ({ id: g.id, name: g.name, set: g.set })) } };
	}
	if (view === 'heatmap') return { ...base, heatmap: heatmapReport(site, by, depth) };
	if (view === 'locales') return { ...base, locales: localesReport(site, days), cannibal: countryCannibalReport(site, days, 100) };
	const g = groupsReport(site, days, depth);
	return { ...base, comparable: g.comparable, reason: g.reason, groups: g.groups, topics: g.topics };
};

export const actions: Actions = {
	saveGroup: async ({ params, request }) => {
		const f = await request.formData();
		const kind: GroupKind = f.get('kind') === 'pages' ? 'pages' : 'bucket';
		const kinds = f.getAll('ruleKind').map(String);
		const values = f.getAll('ruleValue').map(String);
		const rules = { match: f.get('match') === 'all' ? 'all' : 'any', rules: kinds.map((k, i) => ({ kind: k, value: values[i] ?? '' })) };
		const r = saveGroup(Number(params.id), kind, String(f.get('name') ?? ''), rules, Number(f.get('id')) || null);
		return 'error' in r ? fail(400, { error: r.error }) : { ok: kind === 'bucket' ? 'Bucket saved.' : 'Page group saved.' };
	},
	deleteGroup: async ({ params, request }) => {
		return deleteGroup(Number(params.id), Number((await request.formData()).get('id'))) ? { ok: 'Removed. Alerts that watched it are switched off.' } : fail(404, { error: 'It no longer exists.' });
	}
};
