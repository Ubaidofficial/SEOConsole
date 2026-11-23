import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { fetchVolumes, openSeoFor, volumeCandidates, volumeOf, volumesFetchedAt, volumesFor, VOLUME_BATCH } from '$lib/server/openseolink';
import { getSite } from '$lib/server/clients';
import { breakdown, brandTerms, periodFor, topQueries } from '$lib/server/queries';
import { ctrOf, isBranded, pctChange } from '$lib/analytics';
import { POSITION_BUCKETS } from '$lib/plan';
import { QUICK_FILTERS, quickFilter } from '$lib/rules';
import { deleteView, listGroups, listViews, matcherFor, saveView } from '$lib/server/groups';
import { listTracked, trackQueries } from '$lib/server/ranktrack';

/**
 * A search filter written as a regular expression, like Search Console's own "custom (regex)" filter. Case-insensitive. Patterns are
 * capped at 200 characters; an invalid one is reported back instead of failing the page.
 */
function regexOf(src: string | null): { re: RegExp | null; error: string | null } {
	const s = (src ?? '').trim();
	if (!s) return { re: null, error: null };
	if (s.length > 200) return { re: null, error: 'That pattern is longer than 200 characters.' };
	try {
		return { re: new RegExp(s, 'i'), error: null };
	} catch (e) {
		return { re: null, error: `Not a valid pattern: ${e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : 'unknown error'}` };
	}
}

export const load: PageServerLoad = async ({ params, parent, url }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const p = periodFor(site, days);
	const f = { country: url.searchParams.get('country') || undefined, device: url.searchParams.get('device') || undefined };
	const b = url.searchParams.get('b') ?? 'all';
	// `q=questions` is the older address of the Questions quick filter: links to it keep working
	const qf = quickFilter(url.searchParams.get('qf') ?? (url.searchParams.get('q') === 'questions' ? 'questions' : null));
	const bucketId = Number(url.searchParams.get('bucket')) || null;
	const inBucket = bucketId ? matcherFor(site.id, 'bucket', bucketId) : null;
	const pos = POSITION_BUCKETS.find((x) => x.key === url.searchParams.get('pos')) ?? null;
	const posMin = pos ? (POSITION_BUCKETS[POSITION_BUCKETS.indexOf(pos) - 1]?.max ?? 0) : 0;
	const inc = regexOf(url.searchParams.get('re'));
	const exc = regexOf(url.searchParams.get('nre'));
	const terms = brandTerms(site);
	const vol = volumesFor(site.id);
	const prev = new Map(topQueries(site.id, p.prevStart, p.prevEnd, f, 20_000).map((r) => [r.query, r]));
	const rows = topQueries(site.id, p.start, p.end, f, 5000)
		.map((r) => ({
			query: r.query,
			clicks: r.clicks,
			impressions: r.impressions,
			ctr: ctrOf(r),
			position: r.position,
			clicksDelta: pctChange(r.clicks, prev.get(r.query)?.clicks ?? 0),
			posChange: prev.has(r.query) ? r.position - prev.get(r.query)!.position : null,
			branded: isBranded(r.query, terms),
			volume: volumeOf(vol, r.query)?.volume ?? null,
			kd: volumeOf(vol, r.query)?.kd ?? null
		}))
		.filter((r) => (b === 'brand' ? r.branded : b === 'nonbrand' ? !r.branded : true))
		.filter((r) => (!qf ? true : qf.test ? qf.test(r.query) : !prev.has(r.query)))
		.filter((r) => (bucketId ? !!inBucket && inBucket(r.query) : true))
		.filter((r) => (pos ? r.position > posMin && r.position <= pos.max : true))
		.filter((r) => (inc.re ? inc.re.test(r.query) : true) && (exc.re ? !exc.re.test(r.query) : true));
	return {
		rows,
		b,
		qf: qf?.key ?? '',
		quickFilters: QUICK_FILTERS.map((f) => ({ key: f.key, label: f.label, hint: f.hint })),
		bucket: bucketId,
		bucketMissing: !!bucketId && !inBucket,
		buckets: listGroups(site.id, 'bucket').map((g) => ({ id: g.id, name: g.name })),
		views: listViews(site.id, '/queries'),
		tracked: listTracked(site.id).map((t) => t.query),
		pos: pos?.key ?? '',
		re: url.searchParams.get('re') ?? '',
		nre: url.searchParams.get('nre') ?? '',
		regexError: inc.error ?? exc.error,
		filters: f,
		countries: breakdown(site.id, p.start, p.end, 'country').map((c) => c.key),
		devices: breakdown(site.id, p.start, p.end, 'device').map((c) => c.key),
		brandTerms: terms,
		openseo: openSeoFor(site.id) ? { fetchedAt: volumesFetchedAt(site.id), known: vol.size, pending: Math.min(VOLUME_BATCH, volumeCandidates(site).length), batch: VOLUME_BATCH } : null
	};
};

export const actions: Actions = {
	/** Save the current filters under a name, for everyone on the team. */
	saveView: async ({ params, request, locals }) => {
		const f = await request.formData();
		const r = saveView(Number(params.id), '/queries', String(f.get('name') ?? ''), String(f.get('params') ?? ''), locals.user?.email ?? locals.user?.name ?? null);
		return 'error' in r ? fail(400, { error: r.error }) : { ok: 'View saved.' };
	},
	deleteView: async ({ params, request }) => {
		const ok = deleteView(Number(params.id), Number((await request.formData()).get('id')));
		return ok ? { ok: 'View removed.' } : fail(404, { error: 'That view no longer exists.' });
	},
	/** Add one search to rank tracking from its history panel. */
	track: async ({ params, request }) => {
		const r = trackQueries(Number(params.id), [String((await request.formData()).get('query') ?? '')]);
		return r.error ? fail(400, { error: r.error }) : { ok: r.added ? 'Tracked: see the Rank tracking tab.' : 'Already tracked.' };
	},
	/** Ask OpenSEO for the search volume of up to 700 queries not asked in the last 30 days. Spends OpenSEO credits. */
	oseoVolumes: async ({ params }) => {
		if (config.readOnly) return fail(403, { error: 'READ_ONLY=1: fetching search volume is disabled (it spends OpenSEO credits).' });
		try {
			const r = await fetchVolumes(Number(params.id));
			return { ok: r.asked ? `OpenSEO returned a search volume for ${r.withVolume} of ${r.asked} searches (the rest are too small to measure).` : 'Every search already has a volume from the last 30 days.' };
		} catch (e) {
			return fail(502, { error: e instanceof Error ? e.message : 'OpenSEO failed.' });
		}
	}
};
