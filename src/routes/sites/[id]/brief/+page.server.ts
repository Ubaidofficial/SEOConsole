import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { contentBrief } from '$lib/server/brief';
import { hostsMatch } from '$lib/server/hosts';

export const load: PageServerLoad = ({ params, url }) => {
	const site = getSite(Number(params.id))!;
	const q = (url.searchParams.get('q') ?? '').trim();
	const page = (url.searchParams.get('page') ?? '').trim();
	const validPage = page && /^https?:\/\//.test(page) && hostsMatch(page, site.site_url) ? page : undefined;
	return { q, brief: q ? contentBrief(site, q, { page: validPage }) : null };
};
