import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { countryCannibalReport, groupsReport, heatmapReport, localesReport } from '$lib/server/insights';
import { brandTerms } from '$lib/server/queries';
import { deleteGroup, groupsReportFor, saveGroup, setBucketTracking, type GroupKind } from '$lib/server/groups';
import { aiSuggestions } from '$lib/server/suggest';
import { config } from '$lib/server/config';
import { requireRole } from '$lib/server/roles';
import { audit, db } from '$lib/server/db';
import { chatReady } from '$lib/server/chatconfig';

const VIEWS = ['buckets', 'pagegroups', 'folders', 'topics', 'heatmap', 'locales'] as const;

export const load: PageServerLoad = async ({ params, parent, url }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const v = url.searchParams.get('view') as (typeof VIEWS)[number];
	const view = VIEWS.includes(v) ? v : 'buckets';
	const depth = Math.min(4, Math.max(1, Number(url.searchParams.get('depth')) || 1));
	const by = url.searchParams.get('by') === 'page' ? ('page' as const) : ('group' as const);
	const base = { view, days, depth, by, brandTerms: brandTerms(site), aiReady: chatReady(), brandSet: !!site.brand_terms.trim() };
	if (view === 'buckets' || view === 'pagegroups') {
		const kind: GroupKind = view === 'buckets' ? 'bucket' : 'pages';
		const r = groupsReportFor(site, kind, days);
		return { ...base, mine: { kind, rows: r.rows, comparable: r.comparable, groups: r.groups.map((g) => ({ id: g.id, name: g.name, set: g.set, track: g.track })) } };
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
	/** Suggestions for buckets, page groups and brand terms (AI when Ask is set up, else the app's own clusters). Nothing is saved. */
	suggest: async ({ params }) => {
		if (config.readOnly) return fail(403, { error: 'READ_ONLY=1: suggestions are off (they can call your AI provider).' });
		const s = await aiSuggestions(getSite(Number(params.id))!);
		return { suggestions: s };
	},
	/** Create the ticked suggestions. Each one arrives as kind + name + its rules (JSON), checked again like any bucket. */
	acceptSuggestions: async ({ params, request }) => {
		const f = await request.formData();
		let made = 0;
		const errors: string[] = [];
		for (const raw of f.getAll('pick').map(String).slice(0, 40)) {
			let o: { kind?: string; name?: string; set?: unknown };
			try {
				o = JSON.parse(raw);
			} catch {
				continue;
			}
			const r = saveGroup(Number(params.id), o.kind === 'pages' ? 'pages' : 'bucket', String(o.name ?? ''), o.set);
			'error' in r ? errors.push(`${o.name}: ${r.error}`) : made++;
		}
		return errors.length ? fail(400, { error: `Created ${made}. ${errors.slice(0, 3).join(' ')}` }) : { ok: made ? `Created ${made}. They fill with data straight away.` : 'Nothing was ticked.' };
	},
	/** Use suggested brand terms (admin, like the Settings tab). */
	useBrand: async ({ params, request, locals }) => {
		requireRole(locals, 'admin');
		const terms = (await request.formData()).getAll('term').map((t) => String(t).trim().toLowerCase()).filter((t) => t.length >= 3).slice(0, 10);
		if (!terms.length) return fail(400, { error: 'No brand terms ticked.' });
		db().prepare('UPDATE sites SET brand_terms = ? WHERE id = ?').run(terms.join(', '), Number(params.id));
		audit('brand terms set from suggestions', { siteId: Number(params.id), detail: terms.join(', ') });
		return { ok: `Brand terms set: ${terms.join(', ')}.` };
	},
	/** Follow (or stop following) a bucket's 8 biggest searches on the Rank tracking tab. */
	toggleTrack: async ({ params, request }) => {
		const f = await request.formData();
		const on = f.get('on') === '1';
		return setBucketTracking(Number(params.id), Number(f.get('id')), on) ? { ok: on ? 'Its 8 biggest searches are followed on Rank tracking.' : 'No longer followed on Rank tracking.' } : fail(404, { error: 'That bucket no longer exists.' });
	},
	deleteGroup: async ({ params, request }) => {
		return deleteGroup(Number(params.id), Number((await request.formData()).get('id'))) ? { ok: 'Removed. Alerts that watched it are switched off.' } : fail(404, { error: 'It no longer exists.' });
	}
};
