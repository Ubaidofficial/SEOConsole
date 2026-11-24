import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { queueFor } from '$lib/server/actions';
import { listGroups, listViews } from '$lib/server/groups';
import { listTests } from '$lib/server/seotests';
import { insightCounts } from '$lib/insights-hub';

/**
 * The Insights page: every report of the site as a card with its headline number. The numbers come from the site's to-do list
 * (each finding already points at the tab where it is fixed), so the page costs one cached lookup, not a run of every report.
 */
export const load: PageServerLoad = ({ params }) => {
	const site = getSite(Number(params.id))!;
	let open: { type: string; href: string; impact: number | null; blocking: boolean; effort: string }[] = [];
	try {
		open = queueFor(site).open;
	} catch {
		/* the cards still show, without numbers */
	}
	const views = [...listViews(site.id, '/queries'), ...listViews(site.id, '/pages')].map((v) => ({ id: v.id, name: v.name, tab: v.tab, params: v.params, createdAt: v.createdAt }));
	return {
		byTab: insightCounts(open, site.id),
		extra: {
			tests: listTests(site.id).length,
			buckets: listGroups(site.id, 'bucket').length,
			pageGroups: listGroups(site.id, 'pages').length
		},
		views
	};
};
