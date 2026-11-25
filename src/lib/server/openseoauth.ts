/**
 * Signing in to an OpenSEO that sits behind Cloudflare Access (OpenSEO's self-hosted default, AUTH_MODE=cloudflare_access).
 *
 * In that mode OpenSEO trusts only Cloudflare Access: an `oseo_` API key is not looked at, and a service token is refused because
 * it carries no email. The way in is the one MCP clients use, Access's "Managed OAuth": the server answers 401 with
 * `resource_metadata`, which names the Access team's authorization server; SEOConsole registers itself there (dynamic client
 * registration), sends the admin through the Access sign-in once (authorization code + PKCE S256), and keeps the access and
 * refresh tokens, encrypted like every other credential. Each request then carries the access token as a Bearer token; it is
 * refreshed before it expires, and once more after a 401.
 *
 * Written from Cloudflare's published metadata of the live instance (2026-11-25: authorization, token, registration and revocation
 * endpoints; PKCE S256; grants authorization_code and refresh_token; client auth none / basic / post). The full round trip had not
 * been run when this was written. The callback address must be allowed in the Access application's dynamic client registration.
 */
import { createHash, randomBytes } from 'node:crypto';
import { db } from './db';
import { config } from './config';
import { getIntegration, integrationSecret, type IntegrationRow } from './links';
import { decrypt, encrypt } from './crypto';
import { OpenSeoError } from './openseo';

export interface OseoOAuth {
	clientId: string;
	clientSecret?: string;
	tokenEndpoint: string;
	resource: string;
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
}

/** What a request needs: headers to send, and a way to get a fresh token after a 401 (false when there is none). */
export interface OseoAuth {
	headers(): Promise<Record<string, string>>;
	refresh(): Promise<boolean>;
}

export const openSeoCallbackUrl = () => `${config.origin}/auth/openseo/callback`;

const b64url = (b: Buffer) => b.toString('base64url');
const PENDING = 'openseo_oauth_pending:';
const PENDING_MS = 10 * 60_000;

/** The value of `resource_metadata` in a WWW-Authenticate header, if any. */
export function resourceMetadataUrl(header: string | null): string | null {
	const m = header ? /resource_metadata="([^"]+)"/i.exec(header) : null;
	return m ? m[1] : null;
}

interface Discovery { resource: string; authorization: string; token: string; registration: string }

/** Ask the OpenSEO address how to sign in: an unauthenticated request to /mcp, then the two metadata documents it points to. */
export async function discover(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
	const base = baseUrl.replace(/\/+$/, '');
	const probe = await fetchImpl(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}', redirect: 'manual', signal: AbortSignal.timeout(15_000) });
	const metaUrl = resourceMetadataUrl(probe.headers.get('www-authenticate'));
	if (!metaUrl) throw new OpenSeoError(probe.status === 401 ? 'OpenSEO asked for a sign-in but did not say where. Use an API key instead.' : 'This OpenSEO does not use a sign-in (it is not behind Cloudflare Access). Use an API key instead.', probe.status);
	const sameSite = (u: string) => new URL(u).host === new URL(base).host;
	if (!sameSite(metaUrl)) throw new OpenSeoError('OpenSEO pointed its sign-in at another site; not following it.');
	const meta = (await (await fetchImpl(metaUrl, { signal: AbortSignal.timeout(15_000) })).json()) as { resource?: string; authorization_servers?: string[] };
	const as = meta.authorization_servers?.[0];
	if (!as || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/i.test(as.replace(/\/+$/, ''))) throw new OpenSeoError('OpenSEO\'s sign-in server is not a Cloudflare Access team address; not following it.');
	const asMeta = (await (await fetchImpl(`${as.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(15_000) })).json()) as { authorization_endpoint?: string; token_endpoint?: string; registration_endpoint?: string };
	const ok = (u?: string) => !!u && new URL(u).host === new URL(as).host;
	if (!ok(asMeta.authorization_endpoint) || !ok(asMeta.token_endpoint) || !ok(asMeta.registration_endpoint)) throw new OpenSeoError('Cloudflare Access did not describe its sign-in endpoints.');
	return { resource: meta.resource ?? `${base}/mcp`, authorization: asMeta.authorization_endpoint!, token: asMeta.token_endpoint!, registration: asMeta.registration_endpoint! };
}

/**
 * Start the sign-in: register SEOConsole with the Access team (each time, so a changed address or a revoked client starts clean),
 * remember the PKCE verifier under a random state for ten minutes, and return the address to send the admin to.
 */
export async function startOpenSeoSignIn(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
	const d = await discover(baseUrl, fetchImpl);
	const redirectUri = openSeoCallbackUrl();
	const reg = await fetchImpl(d.registration, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ client_name: 'SEOConsole', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
		signal: AbortSignal.timeout(15_000)
	});
	const client = (await reg.json().catch(() => ({}))) as { client_id?: string; client_secret?: string; error_description?: string; error?: string };
	if (!reg.ok || !client.client_id)
		throw new OpenSeoError(
			`Cloudflare Access refused to register SEOConsole (${client.error_description ?? client.error ?? reg.status}). Allow ${redirectUri} under the Access application's Managed OAuth, dynamic client registration.`,
			reg.status
		);
	const verifier = b64url(randomBytes(32));
	const state = b64url(randomBytes(24));
	db().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
		PENDING + state,
		encrypt(JSON.stringify({ baseUrl: baseUrl.replace(/\/+$/, ''), clientId: client.client_id, clientSecret: client.client_secret, token: d.token, resource: d.resource, verifier, at: Date.now() }))
	);
	const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, state, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: d.resource });
	return `${d.authorization}?${q}`;
}

async function tokenRequest(endpoint: string, body: Record<string, string>, fetchImpl: typeof fetch): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
	const res = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(15_000) });
	const j = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
	if (!res.ok || !j.access_token) throw new OpenSeoError(`Cloudflare Access refused the sign-in (${j.error_description ?? j.error ?? res.status}).`, res.status);
	return { access_token: j.access_token, refresh_token: j.refresh_token, expires_in: j.expires_in };
}

/** The callback: check the state (single use, ten minutes), swap the code for tokens. Returns the address and the credential. */
export async function finishOpenSeoSignIn(state: string, code: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<{ baseUrl: string; oauth: OseoOAuth }> {
	const d = db();
	const row = d.prepare('SELECT value FROM kv WHERE key = ?').get(PENDING + state) as { value: string } | undefined;
	d.prepare('DELETE FROM kv WHERE key = ?').run(PENDING + state);
	if (!row) throw new OpenSeoError('That sign-in is unknown or was already used. Start again from the Connect page.');
	const p = JSON.parse(decrypt(row.value)) as { baseUrl: string; clientId: string; clientSecret?: string; token: string; resource: string; verifier: string; at: number };
	if (now - p.at > PENDING_MS) throw new OpenSeoError('That sign-in took more than ten minutes. Start again from the Connect page.');
	const t = await tokenRequest(p.token, { grant_type: 'authorization_code', code, redirect_uri: openSeoCallbackUrl(), client_id: p.clientId, code_verifier: p.verifier, resource: p.resource, ...(p.clientSecret ? { client_secret: p.clientSecret } : {}) }, fetchImpl);
	return { baseUrl: p.baseUrl, oauth: { clientId: p.clientId, clientSecret: p.clientSecret, tokenEndpoint: p.token, resource: p.resource, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: now + (t.expires_in ?? 3600) * 1000 } };
}

/** Sign-ins started and never finished are dropped after ten minutes. */
export const prunePending = (now = Date.now()) => {
	for (const r of db().prepare("SELECT key, value FROM kv WHERE key LIKE 'openseo_oauth_pending:%'").all() as { key: string; value: string }[]) {
		try {
			if (now - (JSON.parse(decrypt(r.value)) as { at: number }).at > PENDING_MS) db().prepare('DELETE FROM kv WHERE key = ?').run(r.key);
		} catch {
			db().prepare('DELETE FROM kv WHERE key = ?').run(r.key);
		}
	}
};

/** Auth for an integration whose secret holds OAuth tokens: refreshes ahead of expiry and stores the rotated tokens. */
export function oauthAuth(integrationId: number, fetchImpl: typeof fetch = fetch): OseoAuth {
	const load = () => {
		const i = getIntegration(integrationId);
		const o = i ? integrationSecret<{ oauth?: OseoOAuth }>(i).oauth : undefined;
		if (!o) throw new OpenSeoError('OpenSEO is not signed in. Sign in again on the Connect page.');
		return o;
	};
	const doRefresh = async (o: OseoOAuth): Promise<OseoOAuth> => {
		if (!o.refreshToken) throw new OpenSeoError('The OpenSEO sign-in has expired. Sign in again on the Connect page.', 401);
		let t;
		try {
			t = await tokenRequest(o.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: o.clientId, resource: o.resource, ...(o.clientSecret ? { client_secret: o.clientSecret } : {}) }, fetchImpl);
		} catch (e) {
			db().prepare("UPDATE integrations SET status = 'error' WHERE id = ?").run(integrationId);
			throw new OpenSeoError(`The OpenSEO sign-in has expired (${e instanceof Error ? e.message : 'refresh failed'}). Sign in again on the Connect page.`, 401);
		}
		const next: OseoOAuth = { ...o, accessToken: t.access_token, refreshToken: t.refresh_token ?? o.refreshToken, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
		db().prepare("UPDATE integrations SET secret_enc = ?, status = 'active' WHERE id = ?").run(encrypt(JSON.stringify({ oauth: next })), integrationId);
		return next;
	};
	return {
		async headers() {
			let o = load();
			if (o.expiresAt - 60_000 < Date.now()) o = await doRefresh(o);
			return { authorization: `Bearer ${o.accessToken}` };
		},
		async refresh() {
			try {
				await doRefresh(load());
				return true;
			} catch {
				return false;
			}
		}
	};
}

/** The credential to reach an OpenSEO integration with: its API key, or its signed-in tokens. */
export function openSeoCredential(i: IntegrationRow, fetchImpl: typeof fetch = fetch): string | OseoAuth {
	const s = integrationSecret<{ apiKey?: string; oauth?: OseoOAuth }>(i);
	return s.oauth ? oauthAuth(i.id, fetchImpl) : (s.apiKey ?? '');
}
