import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { integrationUrlProblem } from '$lib/server/connect';
import { prunePending, startOpenSeoSignIn } from '$lib/server/openseoauth';

const back = (msg: string): never => redirect(303, `/connect?flash=${encodeURIComponent(msg)}#openseo-source`);

/** Start the Cloudflare Access sign-in for an OpenSEO behind Access (admins; the role is checked in hooks via ENDPOINTS). */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const base = (url.searchParams.get('base') ?? '').trim().replace(/\/+$/, '');
	if (!/^https:\/\/\S+$/.test(base)) back('OpenSEO: enter its https address first.');
	const bad = integrationUrlProblem(base);
	if (bad) back(`OpenSEO: ${bad}`);
	prunePending();
	let to: string;
	try {
		to = await startOpenSeoSignIn(base);
	} catch (e) {
		return back(`OpenSEO: ${e instanceof Error ? e.message : 'could not start the sign-in.'}`);
	}
	// The state also goes in a cookie, so the callback only completes in the browser that started it.
	const state = new URL(to).searchParams.get('state') ?? '';
	cookies.set('osc_oseo_state', state, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: 600 });
	redirect(303, to);
};
