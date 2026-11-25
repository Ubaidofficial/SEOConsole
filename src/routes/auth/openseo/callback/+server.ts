import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectOpenSeoSignedIn } from '$lib/server/connect';
import { finishOpenSeoSignIn } from '$lib/server/openseoauth';
import { safeEqual } from '$lib/server/crypto';

const back = (msg: string): never => redirect(303, `/connect?flash=${encodeURIComponent(msg)}#openseo-source`);

/** Back from Cloudflare Access: swap the code for tokens, read the projects with them, then save and link (admins). */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const expected = cookies.get('osc_oseo_state');
	cookies.delete('osc_oseo_state', { path: '/' });
	const state = url.searchParams.get('state') ?? '';
	if (!expected || !safeEqual(state, expected)) back('OpenSEO: the sign-in did not match this browser. Start again.');
	if (url.searchParams.get('error')) back(`OpenSEO: Cloudflare Access said ${url.searchParams.get('error_description') ?? url.searchParams.get('error')}.`);
	const code = url.searchParams.get('code');
	if (!code) back('OpenSEO: Cloudflare Access sent no code back. Start again.');
	let msg: string;
	try {
		const s = await finishOpenSeoSignIn(state, code!);
		const r = await connectOpenSeoSignedIn(s.baseUrl, s.oauth);
		msg = `OpenSEO signed in. Linked ${r.matched} site(s) to projects (${r.projects} project(s) found).${r.unmatchedProjects.length ? ` No matching site for: ${r.unmatchedProjects.join(', ')}.` : ''}`;
	} catch (e) {
		msg = `OpenSEO: ${e instanceof Error ? e.message : 'the sign-in failed.'}`;
	}
	return back(msg);
};
