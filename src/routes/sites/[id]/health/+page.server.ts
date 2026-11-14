import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { getSite } from '$lib/server/clients';
import { publishingFor } from '$lib/server/publishing';
import { nicheFor } from '$lib/server/nichefit';
import { linkHealthFor, verifyLinkTargets, VERIFY_MAX } from '$lib/server/linkhealth';
import { STATUS_ADVICE, STATUS_LABEL, FIT_LABEL } from '$lib/nichefit';
import { VERDICT_LABEL } from '$lib/publishing';

export const load: PageServerLoad = async ({ params, url }) => {
	const site = getSite(Number(params.id))!;
	// Candidate keywords to score come from the address (?kw=one per line), so the result can be shared and reloaded.
	const kw = (url.searchParams.get('kw') ?? '').split(/[\n,]/).map((k) => k.trim()).filter(Boolean).slice(0, 200);
	const niche = nicheFor(site, 90, kw);
	const links = linkHealthFor(site);
	return {
		publishing: publishingFor(site, 90),
		niche: { period: niche.period, queriesUsed: niche.profile.queriesUsed, headline: niche.profile.headline, reachOnlyShare: niche.profile.reachOnlyShare, noClicksShare: niche.profile.noClicksShare, topics: niche.profile.topics.slice(0, 25), candidates: niche.candidates, kw: kw.join('\n') },
		links: { ...links, unchecked: links.unchecked.slice(0, 20), uncheckedTotal: links.unchecked.length, broken: links.broken.slice(0, 25), redirected: links.redirected.slice(0, 25) },
		verifyMax: VERIFY_MAX,
		labels: { status: STATUS_LABEL, advice: STATUS_ADVICE, fit: FIT_LABEL, verdict: VERDICT_LABEL }
	};
};

export const actions: Actions = {
	/** Fetch link targets the crawl did not cover (this site's own pages only), so a clean result is not just an unchecked one. */
	verifyLinks: async ({ params }) => {
		if (config.readOnly) return fail(403, { error: 'READ_ONLY=1: checking link targets is disabled.' });
		try {
			const r = await verifyLinkTargets(Number(params.id));
			return { ok: `Checked ${r.checked} link targets${r.skipped ? ` (${r.skipped} are on other hosts and were left alone)` : ''}: ${r.broken} broken and ${r.redirected} through a redirect in all.` };
		} catch (e) {
			return fail(500, { error: e instanceof Error ? e.message : 'The check failed.' });
		}
	}
};
