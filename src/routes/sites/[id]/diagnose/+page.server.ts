import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { diagnoseSite } from '$lib/server/diagnose';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	return { d: diagnoseSite(getSite(Number(params.id))!, days) };
};
