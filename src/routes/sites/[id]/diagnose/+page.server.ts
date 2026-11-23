import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { diagnoseSite } from '$lib/server/diagnose';
import { updateImpacts, VERDICT_TEXT } from '$lib/server/updateimpact';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	return { d: diagnoseSite(site, days), updates: updateImpacts(site).slice(0, 12), verdictText: VERDICT_TEXT };
};
