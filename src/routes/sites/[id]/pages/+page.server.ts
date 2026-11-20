import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { pageInsights } from '$lib/server/pageinsights';
import { PERIODS } from '$lib/periods';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const r = pageInsights(site, days);
	return {
		sources: { google: r.google, bing: r.bing, ga4: r.ga4, ai: r.ai, clarity: r.clarity, all: r.all },
		period: r.period,
		periods: [...PERIODS],
		allPeriod: (PERIODS as readonly number[]).includes(days),
		rows: r.rows.map((x) => ({ ...x, gCtr: x.gClicks != null && x.gImpr ? x.gClicks / x.gImpr : null }))
	};
};
