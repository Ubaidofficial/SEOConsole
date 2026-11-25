import { db } from './db';
import { config } from './config';
import { allSites } from './queries';
import { bestMatch, hostKey, hostsMatch } from './hosts';
import { BingApiError, RealBingClient } from './bing';
import { bingClientFor, ga4SourceFor, gtmSourceFor, type Ga4Source } from './channels';
import { containerHosts, isWebContainer, type GtmContainer } from './gtm';
import { fetchInsights, ClarityApiError, utcDay } from './clarity';
import { demoClarityFetch, demoOpenSeoProjects } from './demo-channels';
import { listOpenSeoProjects, mcpSession } from './openseo';
import { openSeoCredential, type OseoAuth, type OseoOAuth } from './openseoauth';
import { autoLinkable, getIntegration, integrationMeta, integrationSecret, linksFor, listIntegrations, removeIntegration, saveCandidates, saveIntegration, setLink } from './links';
import { enqueueCruxSync, enqueueLinkSync } from './jobs';
import { CruxError, queryOrigin } from './crux';
import { audit } from './db';
import { SCOPE_GA4 } from './ga4';
import { SCOPE_GTM_READ } from './google';

const visibleSites = () => allSites().filter((s) => !['siteUnverifiedUser', 'none'].includes(s.permission));

export const hasGa4Scope = (a: { scopes: string; is_demo: number }) => !!a.is_demo || a.scopes.includes(SCOPE_GA4);
export const hasGtmScope = (a: { scopes: string; is_demo: number }) => !!a.is_demo || a.scopes.includes(SCOPE_GTM_READ);

// ── Bing ─────────────────────────────────────────────────────────────────────
export function autoMatchBing(integrationId: number) {
	return bingClientFor(integrationId).listSites().then((bingSites) => {
		const verified = bingSites.filter((s) => s.isVerified);
		let matched = 0;
		const linked = new Set<string>();
		for (const site of visibleSites()) {
			if (!autoLinkable(site.id, 'bing')) continue;
			const m = bestMatch(site.site_url, verified, (b) => b.url);
			if (!m) continue;
			setLink(site.id, 'bing', { integrationId, externalId: m.url, label: m.url });
			enqueueLinkSync(site.id, 'bing');
			linked.add(m.url);
			matched++;
		}
		return { matched, bingSites: bingSites.length, unmatchedBing: verified.filter((b) => !linked.has(b.url) && !allSites().some((s) => linksFor(s.id).bing?.external_id === b.url)).map((b) => b.url), unverified: bingSites.filter((s) => !s.isVerified).map((s) => s.url) };
	});
}

export async function connectBingKey(apiKey: string, label: string) {
	const key = apiKey.trim();
	if (!key) throw new BingApiError('Paste your Bing Webmaster API key', 400);
	const demo = config.demo && key === 'demo';
	const id = saveIntegration('bing', label.trim() || 'Bing Webmaster', { apiKey: key }, { auth: 'apikey' }, demo);
	try {
		const result = await autoMatchBing(id); // also validates the key: GetUserSites fails on a bad one
		audit('bing.connected', { detail: label });
		return { id, ...result };
	} catch (e) {
		removeIntegration(id);
		throw e;
	}
}

export function saveBingOAuth(tokens: { access_token: string; refresh_token?: string; expires_in?: number }, label: string) {
	return saveIntegration('bing', label, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 }, { auth: 'oauth' });
}

// ── GA4 ──────────────────────────────────────────────────────────────────────
export interface Ga4PropertyWithUrls { property: string; displayName: string; urls: string[] }

/**
 * An account's GA4 properties with the website address of each one's web streams. One Admin API call per property, so it stops
 * at `max` (500 by default); an account with more properties than that needs its extra sites linked by hand.
 */
export async function ga4PropertiesWithUrls(src: Pick<Ga4Source, 'listProperties' | 'streamUrls'>, max = 500): Promise<Ga4PropertyWithUrls[]> {
	const props = (await src.listProperties()).slice(0, max);
	const out: Ga4PropertyWithUrls[] = [];
	let i = 0;
	await Promise.all(Array.from({ length: 4 }, async () => {
		while (i < props.length) {
			const p = props[i++];
			out.push({ ...p, urls: await src.streamUrls(p.property).catch(() => []) });
		}
	}));
	return out;
}

/** The properties with a web stream on this site's host (or a parent / sub-domain of it). One means a match; several are ambiguous. */
export const ga4Candidates = (props: Ga4PropertyWithUrls[], siteUrl: string) => props.filter((p) => p.urls.some((u) => hostsMatch(u, siteUrl)));

/**
 * Link each site that may be linked automatically to the one GA4 property with a web stream on its host. The site's own Google
 * account is searched first, then every other connected account with GA4 access (an agency often reads GA4 through a different
 * login than Search Console). Several equally good properties are saved as choices for Connect instead of being guessed.
 */
export async function autoMatchGa4() {
	const accounts = db().prepare("SELECT id, scopes, is_demo, email FROM accounts WHERE status = 'active' ORDER BY id").all() as { id: number; scopes: string; is_demo: number; email: string }[];
	let matched = 0;
	const ambiguous: string[] = [];
	const unmatchedSites: string[] = [];
	const errors: string[] = [];
	const noScope = accounts.filter((a) => !hasGa4Scope(a)).map((a) => a.email);
	const readable = accounts.filter(hasGa4Scope);
	const sites = visibleSites().filter((s) => autoLinkable(s.id, 'ga4'));
	// Each account's properties are read at most once per run, and only when a site needs them.
	const cache = new Map<number, Promise<Ga4PropertyWithUrls[]>>();
	const propsOf = (acc: (typeof readable)[number]) => {
		if (!cache.has(acc.id))
			cache.set(acc.id, ga4PropertiesWithUrls(ga4SourceFor(acc.id)).catch((e) => (errors.push(`${acc.email}: ${e instanceof Error ? e.message : String(e)}`), [])));
		return cache.get(acc.id)!;
	};
	for (const site of sites) {
		const order = [...readable.filter((a) => a.id === site.account_id), ...readable.filter((a) => a.id !== site.account_id)];
		let found: { acc: (typeof readable)[number]; props: Ga4PropertyWithUrls[] } | null = null;
		for (const acc of order) {
			const cands = ga4Candidates(await propsOf(acc), site.site_url);
			if (cands.length) {
				found = { acc, props: cands };
				break;
			}
		}
		if (!found) {
			if (readable.length) unmatchedSites.push(site.site_url);
			continue;
		}
		if (found.props.length === 1) {
			setLink(site.id, 'ga4', { accountId: found.acc.id, externalId: found.props[0].property, label: found.props[0].displayName });
			enqueueLinkSync(site.id, 'ga4');
			matched++;
		} else {
			saveCandidates(site.id, 'ga4', found.props.map((p) => ({ externalId: p.property, label: `${p.displayName} (${p.property})`, accountId: found.acc.id })));
			ambiguous.push(site.site_url);
		}
	}
	return { matched, ambiguous, unmatchedSites, noScope, errors };
}

export async function listGa4Candidates(accountId: number) {
	return ga4SourceFor(accountId).listProperties();
}

// ── Tag Manager ──────────────────────────────────────────────────────────────
/**
 * The container for a site among one account's web containers: the exact host beats a sub-domain match, and two equally good
 * ones are ambiguous (pick undefined, candidates lists them).
 */
export function pickGtm(containers: GtmContainer[], siteUrl: string): { pick?: GtmContainer; candidates: GtmContainer[] } {
	const cands = containers.filter((c) => containerHosts(c).some((h) => hostsMatch(h, siteUrl)));
	const exact = cands.filter((c) => containerHosts(c).some((h) => hostKey(h) === hostKey(siteUrl)));
	const pick = exact.length === 1 ? exact[0] : exact.length === 0 && cands.length === 1 ? cands[0] : undefined;
	return { pick, candidates: cands };
}

/**
 * Link each unlinked site to the web container whose domain (or, failing that, name) matches it. Unlike GA4 this looks across
 * every account that has Tag Manager access, because the person who manages tags is often not the Search Console owner.
 */
export async function autoMatchGtm() {
	const accounts = (db().prepare("SELECT id, scopes, is_demo, email FROM accounts WHERE status = 'active' ORDER BY id").all() as { id: number; scopes: string; is_demo: number; email: string }[]);
	const noScope = accounts.filter((a) => !hasGtmScope(a)).map((a) => a.email);
	let matched = 0;
	const ambiguous: string[] = [];
	const used = new Set<string>();
	for (const acc of accounts.filter(hasGtmScope)) {
		const sites = visibleSites().filter((s) => autoLinkable(s.id, 'gtm'));
		if (!sites.length) break;
		const containers = (await gtmSourceFor(acc.id).listContainers()).filter(isWebContainer);
		for (const site of sites) {
			const { pick, candidates: cands } = pickGtm(containers, site.site_url);
			if (!pick) {
				if (cands.length > 1) {
					// Offered as a choice on Connect; a unique match in a later account still links it (and clears the choice).
					saveCandidates(site.id, 'gtm', cands.map((c) => ({ externalId: c.path, label: `${c.publicId} · ${c.name}`, accountId: acc.id })));
					if (!ambiguous.includes(site.site_url)) ambiguous.push(site.site_url);
				}
				continue;
			}
			setLink(site.id, 'gtm', { accountId: acc.id, externalId: pick.path, label: `${pick.publicId} · ${pick.name}` });
			enqueueLinkSync(site.id, 'gtm');
			used.add(pick.path);
			matched++;
		}
	}
	// A site ambiguous in one account but matched uniquely in a later one is linked, not ambiguous.
	const open = visibleSites().filter((s) => autoLinkable(s.id, 'gtm'));
	const still = ambiguous.filter((u) => open.some((s) => s.site_url === u));
	const unmatchedSites = open.filter((s) => !still.includes(s.site_url)).map((s) => s.site_url);
	return { matched, ambiguous: still, unmatchedSites, noScope };
}

/** Link a site by hand to a container given as GTM-XXXXXXX or accounts/123/containers/456, looked up in the connected accounts. */
export async function linkGtmManually(siteId: number, ref: string) {
	const want = ref.trim();
	if (!/^(GTM-[A-Z0-9]+|accounts\/\d+\/containers\/\d+)$/i.test(want)) throw new Error('Enter a container ID like GTM-ABC1234, or a path like accounts/123/containers/456.');
	for (const acc of db().prepare("SELECT id, scopes, is_demo FROM accounts WHERE status = 'active' ORDER BY id").all() as { id: number; scopes: string; is_demo: number }[]) {
		if (!hasGtmScope(acc)) continue;
		const hit = (await gtmSourceFor(acc.id).listContainers()).find((c) => c.publicId.toLowerCase() === want.toLowerCase() || c.path === want);
		if (!hit) continue;
		setLink(siteId, 'gtm', { accountId: acc.id, externalId: hit.path, label: `${hit.publicId} · ${hit.name}` });
		enqueueLinkSync(siteId, 'gtm');
		return hit;
	}
	throw new Error(`No container ${want} is visible to your connected Google accounts (they need Tag Manager access; reconnect them if it was never granted).`);
}

// ── Clarity ──────────────────────────────────────────────────────────────────
export async function connectClarity(siteId: number, token: string) {
	const t = token.trim();
	if (!t) throw new ClarityApiError('Paste the Clarity API token', 400);
	const site = allSites({ includeHidden: true }).find((s) => s.id === siteId);
	if (!site) throw new Error('Unknown site');
	const demo = config.demo && t === 'demo';
	const id = saveIntegration('clarity', site.label || site.site_url, { token: t }, {}, demo);
	try {
		// The test call is not wasted: it becomes today's first snapshot.
		const payload = await fetchInsights(id, t, { numOfDays: 1 }, demo ? demoClarityFetch(site.site_url) : fetch);
		db().prepare('INSERT OR REPLACE INTO clarity_snapshots VALUES (?,?,?,?,?)').run(siteId, utcDay(), '', JSON.stringify(payload), Date.now());
	} catch (e) {
		removeIntegration(id);
		throw e;
	}
	const old = linksFor(siteId).clarity?.integration_id;
	setLink(siteId, 'clarity', { integrationId: id, externalId: site.site_url, label: 'Clarity project' });
	if (old) removeIntegration(old);
	audit('clarity.connected', { siteId });
	return { id };
}

/**
 * A URL the server will call with a stored key. A self-hosted OpenSEO can legitimately sit on a private network, so private
 * addresses are allowed; what is refused is anything that could carry credentials in the address, and the link-local range and
 * names that cloud providers use for instance metadata (the usual target of this kind of request).
 */
export function integrationUrlProblem(raw: string): string | null {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return 'That is not a valid URL.';
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Only http and https addresses are allowed.';
	if (u.username || u.password) return 'Do not put a user name or password in the address; the API key is sent separately.';
	const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
	if (h === 'metadata' || h === 'metadata.google.internal' || h.endsWith('.internal') && h.startsWith('metadata')) return 'That address is a cloud metadata service, not an OpenSEO server.';
	if (/^169\.254\./.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || h === 'fd00:ec2::254') return 'Link-local addresses (including cloud metadata) are not allowed.';
	return null;
}

// ── OpenSEO ──────────────────────────────────────────────────────────────────
export async function connectOpenSeo(baseUrl: string, apiKey: string) {
	const base = baseUrl.trim().replace(/\/+$/, '');
	if (!/^https?:\/\/\S+$/.test(base)) throw new Error('Enter your OpenSEO URL, e.g. https://openseo.example.com');
	const bad = integrationUrlProblem(base);
	if (bad) throw new Error(bad);
	const demo = config.demo && apiKey.trim() === 'demo';
	const projects = demo ? demoOpenSeoProjects() : await listOpenSeoProjects(base, apiKey.trim());
	return saveOpenSeo(base, { apiKey: apiKey.trim() }, projects, demo, 'api key');
}

/**
 * Connect through a Cloudflare Access sign-in (src/lib/server/openseoauth.ts): the callback has the tokens; the project list is read
 * with them before anything is saved, so a sign-in that cannot reach OpenSEO changes nothing.
 */
export async function connectOpenSeoSignedIn(baseUrl: string, oauth: OseoOAuth, fetchImpl: typeof fetch = fetch) {
	const base = baseUrl.trim().replace(/\/+$/, '');
	const bad = integrationUrlProblem(base);
	if (bad) throw new Error(bad);
	const once: OseoAuth = { headers: async () => ({ authorization: `Bearer ${oauth.accessToken}` }), refresh: async () => false };
	const projects = await listOpenSeoProjects(base, once, fetchImpl);
	return saveOpenSeo(base, { oauth }, projects, false, 'sign-in');
}

function saveOpenSeo(base: string, secret: object, projects: { id: string; name: string; domain?: string | null }[], demo: boolean, how: string) {
	const id = saveIntegration('openseo', new URL(base).host, secret, { baseUrl: base, auth: how === 'sign-in' ? 'oauth' : 'apikey' }, demo);
	const { matched, linkedProjects } = matchOpenSeo(id, projects, false);
	const unmatchedProjects = projects.filter((p) => !linkedProjects.has(p.id)).map((p) => `${p.name}${p.domain ? ` (${p.domain})` : ''}`);
	// Links made by hand (a site whose domain differs from its project's) move to the new connection when the project still
	// exists there; removing the old connection would otherwise delete them with it.
	const ids = new Set(projects.map((p) => p.id));
	const move = db().prepare("UPDATE site_links SET integration_id = ? WHERE kind = 'openseo' AND integration_id = ? AND external_id = ?");
	for (const old of listIntegrations('openseo'))
		if (old.id !== id)
			for (const l of db().prepare("SELECT external_id FROM site_links WHERE kind = 'openseo' AND integration_id = ?").all(old.id) as { external_id: string }[])
				if (ids.has(l.external_id)) move.run(id, old.id, l.external_id);
	// Replace any older OpenSEO connection that no longer has links.
	for (const old of listIntegrations('openseo')) if (old.id !== id) removeIntegration(old.id);
	cacheOpenSeoProjects(projects);
	audit('openseo.connected', { detail: `${base} (${how})` });
	return { id, matched, projects: projects.length, unmatchedProjects };
}

/**
 * Link sites to the OpenSEO project on their domain. On a fresh connection every site is (re)linked to the new connection;
 * `onlyNew` (the nightly run) touches only sites with no OpenSEO link. Sites unlinked on purpose are left alone either way.
 */
function matchOpenSeo(integrationId: number, projects: { id: string; name: string; domain?: string | null }[], onlyNew: boolean) {
	let matched = 0;
	const linkedProjects = new Set<string>();
	const withDomain = projects.filter((p) => p.domain);
	for (const site of visibleSites()) {
		if (onlyNew ? !autoLinkable(site.id, 'openseo') : db().prepare("SELECT 1 FROM link_skips WHERE site_id = ? AND kind = 'openseo'").get(site.id)) continue;
		let m: { id: string; name: string } | null = bestMatch(site.site_url, withDomain, (p) => p.domain!);
		// No project on the site's domain: link one only on strong evidence, its domain being a host another of the site's sources
		// uses (a moved or renamed site's Tag Manager container) and its name or domain naming the site. Weaker guesses wait for a click.
		if (!m) {
			const taken = new Set(db().prepare("SELECT external_id FROM site_links WHERE kind = 'openseo' AND site_id != ?").all(site.id).map((r) => (r as { external_id: string }).external_id));
			const best = rankOpenSeoProjects(site.site_url, linkedHosts(site.id), projects.map((p) => ({ id: p.id, name: p.name, domain: p.domain ?? null })), new Set([...taken, ...linkedProjects]))[0];
			if (best?.suggested && best.score >= AUTO_LINK_SCORE) m = best;
		}
		if (!m) continue;
		setLink(site.id, 'openseo', { integrationId, externalId: m.id, label: m.name });
		linkedProjects.add(m.id);
		matched++;
	}
	return { matched, linkedProjects };
}

// ── All sources, for sites found later ───────────────────────────────────────
/**
 * Link every site that has no link yet to its GA4 property, Tag Manager container, Bing site and OpenSEO project, using the
 * same matching as Connect's buttons. Runs after each nightly property refresh and after "Sync all", so a property added to
 * Search Console later is joined up without anyone pressing anything. Each source fails on its own; nothing here unlinks.
 */
export async function autoLinkNewSites() {
	const out: { ga4: number; gtm: number; bing: number; openseo: number; ambiguous: string[]; errors: string[] } = { ga4: 0, gtm: 0, bing: 0, openseo: 0, ambiguous: [], errors: [] };
	const pending = (k: 'ga4' | 'gtm' | 'bing' | 'openseo') => visibleSites().some((s) => autoLinkable(s.id, k));
	const note = (src: string, e: unknown) => out.errors.push(`${src}: ${e instanceof Error ? e.message : String(e)}`);
	if (pending('ga4'))
		await autoMatchGa4().then((r) => ((out.ga4 = r.matched), out.ambiguous.push(...r.ambiguous), out.errors.push(...r.errors.map((e) => `GA4 ${e}`))), (e) => note('GA4', e));
	if (pending('gtm')) await autoMatchGtm().then((r) => ((out.gtm = r.matched), out.ambiguous.push(...r.ambiguous)), (e) => note('Tag Manager', e));
	for (const b of listIntegrations('bing')) if (pending('bing')) await autoMatchBing(b.id).then((r) => (out.bing += r.matched), (e) => note('Bing', e));
	const o = listIntegrations('openseo')[0];
	if (o && pending('openseo')) {
		try {
			const projects = o.is_demo ? demoOpenSeoProjects() : await listOpenSeoProjects(integrationMeta(o).baseUrl, openSeoCredential(o));
			cacheOpenSeoProjects(projects);
			out.openseo = matchOpenSeo(o.id, projects, true).matched;
		} catch (e) {
			note('OpenSEO', e);
		}
	}
	const total = out.ga4 + out.gtm + out.bing + out.openseo;
	if (total) audit('links.auto', { detail: `linked automatically: GA4 ${out.ga4}, Tag Manager ${out.gtm}, Bing ${out.bing}, OpenSEO ${out.openseo}` });
	return out;
}

// ── OpenSEO by hand ──────────────────────────────────────────────────────────
type ProjectBrief = { id: string; name: string; domain: string | null };
const PROJECTS_KEY = 'openseo_projects';

function cacheOpenSeoProjects(projects: { id: string; name: string; domain?: string | null }[]) {
	const brief: ProjectBrief[] = projects.map((p) => ({ id: p.id, name: p.name, domain: p.domain ?? null }));
	db().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(PROJECTS_KEY, JSON.stringify(brief));
}

/** The OpenSEO projects as last read (on connecting, nightly, or when a site is linked by hand), for the Connect page's picker. */
export function cachedOpenSeoProjects(): ProjectBrief[] {
	const row = db().prepare('SELECT value FROM kv WHERE key = ?').get(PROJECTS_KEY) as { value: string } | undefined;
	try {
		const v = row ? (JSON.parse(row.value) as unknown) : [];
		return Array.isArray(v) ? (v as ProjectBrief[]).filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string') : [];
	} catch {
		return [];
	}
}

/**
 * Link a site to an OpenSEO project chosen by hand, for a site whose domain is not the project's (a renamed or redirected site,
 * for example). The project list is read again from OpenSEO, so only a project that exists there can be linked.
 */
export async function linkOpenSeoManually(siteId: number, projectId: string, o: { list?: typeof listOpenSeoProjects } = {}) {
	const integ = listIntegrations('openseo')[0];
	if (!integ) throw new Error('Connect OpenSEO first.');
	if (!allSites().some((s) => s.id === siteId)) throw new Error('Unknown site.');
	const projects = integ.is_demo ? demoOpenSeoProjects() : await (o.list ?? listOpenSeoProjects)(integrationMeta(integ).baseUrl, openSeoCredential(integ));
	cacheOpenSeoProjects(projects);
	const p = projects.find((x) => x.id === projectId);
	if (!p) throw new Error('That OpenSEO project no longer exists. Reload the page and choose again.');
	setLink(siteId, 'openseo', { integrationId: integ.id, externalId: p.id, label: p.name });
	audit('openseo.linked', { siteId, detail: `${p.name}${p.domain ? ` (${p.domain})` : ''}, by hand` });
	return p;
}

/**
 * The order to offer OpenSEO projects in for a site that matched none by domain, best guess first and marked `suggested` when it
 * clearly beats the rest. Signals: the project's domain is a host one of the site's other sources uses (a Tag Manager container's
 * domain, the Bing site), the project's name is the site's name ("Six Figure Jobs" for sixfigurejobs.net), or the domains' first
 * labels agree. Projects another site already uses go last. A guess is only preselected; linking stays a click.
 */
/** A project linked without a click needs another source's host on its domain (80) plus its name or domain naming the site (50+). */
export const AUTO_LINK_SCORE = 120;

export function rankOpenSeoProjects(siteUrl: string, otherHosts: string[], projects: { id: string; name: string; domain: string | null }[], taken: Set<string>) {
	const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
	const label = (h: string) => norm(hostKey(h).split('.')[0] ?? '');
	const site = label(siteUrl);
	const hosts = otherHosts.map((h) => hostKey(h)).filter(Boolean);
	const scored = projects.map((p) => {
		let score = 0;
		if (p.domain && hostsMatch(p.domain, siteUrl)) score += 100;
		if (p.domain && hosts.some((h) => hostsMatch(h, p.domain!))) score += 80;
		const name = norm(p.name);
		if (site && name === site) score += 60;
		else if (site.length >= 5 && name.length >= 5 && (name.includes(site) || site.includes(name))) score += 40;
		if (p.domain && site && label(p.domain) === site) score += 50;
		if (taken.has(p.id)) score -= 200;
		return { ...p, score };
	});
	scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
	const clear = scored.length > 0 && scored[0].score >= 40 && (scored.length === 1 || scored[0].score > scored[1].score);
	return scored.map((p, i) => ({ id: p.id, name: p.name, domain: p.domain, suggested: clear && i === 0, score: p.score }));
}

/** Hosts a site's other linked sources point at: the Tag Manager container's domains (from its label) and the Bing site address. */
export function linkedHosts(siteId: number): string[] {
	const l = linksFor(siteId);
	const out: string[] = [];
	const gtmDomains = l.gtm?.label?.split(' · ')[1];
	if (gtmDomains) out.push(...gtmDomains.split(/[,\s]+/).filter(Boolean));
	if (l.bing?.external_id) out.push(l.bing.external_id);
	return out;
}

/**
 * Create an OpenSEO project for a site that has none (OpenSEO's create_project spends no credits) and link the site to it.
 * Named after the site's host, with the host as its domain, so automatic matching would find it too.
 */
export async function createOpenSeoProjectFor(siteId: number, o: { api?: { callTool(name: string, args?: Record<string, unknown>): Promise<unknown> } } = {}) {
	const integ = listIntegrations('openseo')[0];
	if (!integ) throw new Error('Connect OpenSEO first.');
	const site = allSites().find((s) => s.id === siteId);
	if (!site) throw new Error('Unknown site.');
	const domain = hostKey(site.site_url);
	const api = o.api ?? (integ.is_demo ? null : await mcpSession(integrationMeta(integ).baseUrl, openSeoCredential(integ)));
	if (!api) throw new Error('Demo mode cannot create OpenSEO projects.');
	const r = (await api.callTool('create_project', { name: domain.slice(0, 120), domain })) as { project?: { id?: string; name?: string } } | null;
	const p = r?.project;
	if (!p?.id) throw new Error('OpenSEO did not return the new project.');
	setLink(siteId, 'openseo', { integrationId: integ.id, externalId: p.id, label: p.name ?? domain });
	cacheOpenSeoProjects([...cachedOpenSeoProjects(), { id: p.id, name: p.name ?? domain, domain }]);
	audit('openseo.project_created', { siteId, detail: domain });
	return { id: p.id, name: p.name ?? domain };
}

export const openSeoProjectUrl = (integrationId: number | null, projectId: string) => {
	if (!integrationId) return null;
	const i = getIntegration(integrationId);
	return i ? `${integrationMeta(i).baseUrl ?? ''}/p/${projectId}` : null;
};

// ── Core Web Vitals (Chrome UX Report) ───────────────────────────────────────
export async function connectCrux(apiKey: string) {
	const key = apiKey.trim();
	if (!key) throw new CruxError('Paste your Google API key', 400);
	const demo = config.demo && key === 'demo';
	// Validate the key against an origin with lots of traffic: 200 or "no data" both prove the key and API are fine.
	if (!demo) await queryOrigin(key, 'https://web.dev', 'PHONE');
	for (const i of listIntegrations('crux')) removeIntegration(i.id);
	const id = saveIntegration('crux', 'Chrome UX Report', { apiKey: key }, {}, demo);
	audit('crux.connected');
	const sites = visibleSites().filter((s) => !s.hidden);
	for (const s of sites) enqueueCruxSync(s.id);
	return { id, sites: sites.length };
}
