import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { db, openDb } from '../src/lib/server/db';
import { discover, finishOpenSeoSignIn, oauthAuth, resourceMetadataUrl, startOpenSeoSignIn } from '../src/lib/server/openseoauth';
import { connectOpenSeoSignedIn } from '../src/lib/server/connect';
import { listIntegrations, integrationSecret, integrationMeta } from '../src/lib/server/links';
import { listOpenSeoProjects } from '../src/lib/server/openseo';

const BASE = 'https://openseo.example.com';
const TEAM = 'https://team-x.cloudflareaccess.com';
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fake OpenSEO behind Cloudflare Access: 401 with resource_metadata, Access's metadata, registration, token, and an MCP that wants a Bearer token. */
function fakeAccess() {
	const seen: { url: string; body?: string; headers: Record<string, string> }[] = [];
	let valid = new Set(['at-1']);
	let issued = 1;
	let lastChallenge = '';
	const f: typeof fetch = async (input, init) => {
		const url = String(input);
		const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
		const body = init?.body == null ? undefined : String(init.body);
		seen.push({ url, body, headers });
		if (url === `${BASE}/mcp`) {
			const tok = headers.authorization?.replace(/^Bearer /, '');
			if (!tok || !valid.has(tok)) return json({ error: 'invalid_token' }, 401, { 'www-authenticate': `Bearer realm="OAuth", resource_metadata="${BASE}/.well-known/cloudflare-access-protected-resource/mcp"` });
			const msg = JSON.parse(body!);
			if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: {} }, 200, { 'mcp-session-id': 's1' });
			if (!msg.id) return new Response('', { status: 202 });
			return json({ jsonrpc: '2.0', id: msg.id, result: { structuredContent: { projects: [{ id: 'p1', name: 'Example', domain: 'example.com' }] } } });
		}
		if (url === `${BASE}/.well-known/cloudflare-access-protected-resource/mcp`) return json({ resource: `${BASE}/mcp`, authorization_servers: [TEAM] });
		if (url === `${TEAM}/.well-known/oauth-authorization-server`)
			return json({ authorization_endpoint: `${TEAM}/cdn-cgi/access/oauth/authorization`, token_endpoint: `${TEAM}/cdn-cgi/access/oauth/token`, registration_endpoint: `${TEAM}/cdn-cgi/access/oauth/registration` });
		if (url === `${TEAM}/cdn-cgi/access/oauth/registration`) return json({ client_id: 'client-1' }, 201);
		if (url === `${TEAM}/cdn-cgi/access/oauth/token`) {
			const p = new URLSearchParams(body);
			if (p.get('grant_type') === 'authorization_code') {
				// PKCE: the verifier must hash to the challenge sent at the start.
				if (createHash('sha256').update(p.get('code_verifier')!).digest('base64url') !== lastChallenge || p.get('code') !== 'code-1') return json({ error: 'invalid_grant' }, 400);
				return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
			}
			if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === `rt-${issued}`) {
				issued++;
				valid.add(`at-${issued}`);
				return json({ access_token: `at-${issued}`, refresh_token: `rt-${issued}`, expires_in: 3600 });
			}
			return json({ error: 'invalid_grant' }, 400);
		}
		return new Response('not found', { status: 404 });
	};
	return { f, seen, revoke: (t: string) => valid.delete(t), setChallenge: (c: string) => (lastChallenge = c) };
}

beforeAll(() => {
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
});

describe('finding the sign-in', () => {
	it('reads resource_metadata from the 401', () => {
		expect(resourceMetadataUrl('Bearer realm="OAuth", error="invalid_token", resource_metadata="https://x/.well-known/a"')).toBe('https://x/.well-known/a');
		expect(resourceMetadataUrl(null)).toBeNull();
	});
	it('follows only same-site metadata and a Cloudflare Access team', async () => {
		const { f } = fakeAccess();
		const d = await discover(BASE, f);
		expect(d.token).toBe(`${TEAM}/cdn-cgi/access/oauth/token`);
		expect(d.resource).toBe(`${BASE}/mcp`);
		const evil: typeof fetch = async (input, init) => (String(input).includes('protected-resource') ? json({ authorization_servers: ['https://evil.example.com'] }) : f(input, init));
		await expect(discover(BASE, evil)).rejects.toThrow(/not a Cloudflare Access team/);
		const open: typeof fetch = async () => json({ jsonrpc: '2.0' }, 200);
		await expect(discover(BASE, open)).rejects.toThrow(/not behind Cloudflare Access/);
	});
});

describe('the round trip', () => {
	it('registers, sends the admin to Access with PKCE, swaps the code, reads projects and saves the tokens', async () => {
		const a = fakeAccess();
		const to = new URL(await startOpenSeoSignIn(BASE, a.f));
		expect(to.origin + to.pathname).toBe(`${TEAM}/cdn-cgi/access/oauth/authorization`);
		expect(to.searchParams.get('code_challenge_method')).toBe('S256');
		expect(to.searchParams.get('client_id')).toBe('client-1');
		expect(to.searchParams.get('redirect_uri')).toMatch(/\/auth\/openseo\/callback$/);
		a.setChallenge(to.searchParams.get('code_challenge')!);
		const state = to.searchParams.get('state')!;
		const s = await finishOpenSeoSignIn(state, 'code-1', a.f);
		expect(s.oauth.accessToken).toBe('at-1');
		await expect(finishOpenSeoSignIn(state, 'code-1', a.f)).rejects.toThrow(/already used/); // single use
		const r = await connectOpenSeoSignedIn(s.baseUrl, s.oauth, a.f);
		expect(r.projects).toBe(1);
		const i = listIntegrations('openseo')[0];
		expect(integrationMeta(i).auth).toBe('oauth');
		expect(integrationSecret<{ oauth: { refreshToken: string } }>(i).oauth.refreshToken).toBe('rt-1');
		// The secret is stored encrypted, never as plain JSON.
		expect((db().prepare('SELECT secret_enc FROM integrations WHERE id = ?').get(i.id) as { secret_enc: string }).secret_enc).not.toContain('rt-1');
	});

	it('refreshes after a refusal and stores the rotated tokens; a dead refresh token says to sign in again', async () => {
		const a = fakeAccess();
		const i = listIntegrations('openseo')[0];
		a.revoke('at-1');
		const projects = await listOpenSeoProjects(BASE, oauthAuth(i.id, a.f), a.f);
		expect(projects[0].id).toBe('p1');
		expect(integrationSecret<{ oauth: { accessToken: string; refreshToken: string } }>(listIntegrations('openseo')[0]).oauth).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
		const b = fakeAccess(); // knows none of the rotated tokens
		b.revoke('at-1');
		await expect(listOpenSeoProjects(BASE, oauthAuth(i.id, b.f), b.f)).rejects.toThrow(/Sign in again/);
	});

	it('an API key is still sent as x-api-key', async () => {
		const seen: Record<string, string>[] = [];
		const f: typeof fetch = async (_u, init) => {
			seen.push(init?.headers as Record<string, string>);
			const msg = JSON.parse(String(init?.body));
			return msg.id ? json({ jsonrpc: '2.0', id: msg.id, result: { structuredContent: { projects: [] } } }) : new Response('', { status: 202 });
		};
		await listOpenSeoProjects(BASE, 'oseo_abc', f);
		expect(seen[0]['x-api-key']).toBe('oseo_abc');
		expect(seen[0].authorization).toBeUndefined();
	});
});
