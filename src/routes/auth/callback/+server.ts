import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { exchangeCode } from '$lib/server/google';
import { upsertGoogleAccount } from '$lib/server/accounts';
import { resumeAccount } from '$lib/server/jobs';
import { safeEqual } from '$lib/server/crypto';
import { safeReturn } from '$lib/server/guard';

export const GET: RequestHandler = async ({ url, cookies }) => {
	// Google's Terms of Service page sends someone here when they have just accepted it (to create a Google Analytics account),
	// with no sign-in in progress: there is nothing to finish, so take them back to the Connect page.
	if (!url.searchParams.has('code') && !url.searchParams.has('error') && !url.searchParams.has('state')) redirect(303, '/connect?flash=' + encodeURIComponent('Back from Google. Press Continue on the setup panel to carry on.'));
	const expected = cookies.get('osc_oauth_state');
	cookies.delete('osc_oauth_state', { path: '/' });
	const state = url.searchParams.get('state') ?? '';
	if (!expected || !safeEqual(state, expected)) error(400, 'OAuth state mismatch. Start the connection again.');
	const err = url.searchParams.get('error');
	if (err) redirect(303, `/accounts?error=${encodeURIComponent(err)}`);
	const code = url.searchParams.get('code');
	if (!code) error(400, 'Missing authorization code');

	const { tokens, sub, email } = await exchangeCode(code);
	const id = upsertGoogleAccount({ sub, email, refreshToken: tokens.refresh_token, accessToken: tokens.access_token, expiresIn: tokens.expires_in, scope: tokens.scope });
	// Its sites, and the GA4 properties and Tag Manager containers read through it, sync again straight away.
	await resumeAccount(id);
	const back = safeReturn(cookies.get('osc_oauth_back') ?? null);
	cookies.delete('osc_oauth_back', { path: '/' });
	redirect(303, back ? `${back}${back.includes('?') ? '&' : '?'}granted=1` : '/accounts?connected=' + encodeURIComponent(email));
};
