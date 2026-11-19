import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { dashboardFor } from '$lib/server/dashboard';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	return { dash: dashboardFor(site, days) };
};
