import { audit, db } from './db';
import { integrationSecret, listIntegrations, removeIntegration, saveIntegration } from './links';
import { getSite } from './clients';
import { config, env } from './config';
import { demoAhrefsFetch } from './demo-channels';

/**
 * Ahrefs Domain Rating (DR) for each site, shown next to its name. It uses Ahrefs' FREE public endpoint (POST /v3/public/domain-rating-free):
 * no API units and no paid plan, only a free API key from a free Ahrefs account. One request carries every site (up to 1,000 domains), and
 * only the domain names are sent. The data comes with Ahrefs' Domain Rating License, which requires "Domain Rating by Ahrefs" (Ahrefs linked
 * to https://ahrefs.com/) next to every place it is shown: DrChip does that. Written from Ahrefs' reference and checked once against the live
 * service (it answers each target with a trailing slash, e.g. "example.com/"), so answers are matched by a normalised target.
 */
const ENDPOINT = 'https://api.ahrefs.com/v3/public/domain-rating-free';
/** Used to prove a key works. */
const PROBE_TARGET = 'ahrefs.com';
const MAX_TARGETS = 1000;
export const DR_EVERY_DAYS = 7;
const RETRY_AFTER_ERROR_MS = 24 * 3600_000;
const DAY = 86_400_000;

export class AhrefsError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

export interface DrBadge { dr: number; date: string | null }

/** Ahrefs offers two versions of the score; the default (dr3) unless AHREFS_DR_VERSION=dr4. */
export const drVersion = () => (env('AHREFS_DR_VERSION').trim().toLowerCase() === 'dr4' ? 'dr4' : 'dr3');

/** The domain Ahrefs is asked about: a Domain property's domain, or a URL-prefix property's host without a leading www. */
export function domainTarget(siteUrl: string): string | null {
	try {
		const host = siteUrl.startsWith('sc-domain:') ? siteUrl.slice('sc-domain:'.length) : new URL(siteUrl).hostname;
		const t = host.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
		return /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(t) ? t : null;
	} catch {
		return null;
	}
}

/** Targets are compared without scheme, case or trailing slash: Ahrefs answers "example.com" with "example.com/". */
export const normaliseTarget = (t: string) => t.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The DR Ahrefs gave for each target it answered, keyed by normalised target. */
export function parseDomainRatings(json: unknown): Map<string, number> {
	const list = (json as { domain_rating?: { targets?: unknown } } | null)?.domain_rating?.targets;
	if (!Array.isArray(list)) throw new AhrefsError('Ahrefs answered in a shape this app does not recognise (no list of targets).', 502);
	const out = new Map<string, number>();
	for (const t of list as { target?: unknown; domain_rating?: unknown }[]) {
		const dr = Number(t?.domain_rating);
		if (typeof t?.target === 'string' && t.domain_rating != null && Number.isFinite(dr) && dr >= 0 && dr <= 100) out.set(normaliseTarget(t.target), dr);
	}
	return out;
}

/** One batch (at most 1,000 targets). Free: it costs no API units. */
async function queryBatch(apiKey: string, targets: string[], fetchImpl: typeof fetch): Promise<Map<string, number>> {
	let res: Response;
	try {
		res = await fetchImpl(ENDPOINT, {
			method: 'POST',
			headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'content-type': 'application/json' },
			body: JSON.stringify({ targets, version: drVersion() }),
			signal: AbortSignal.timeout(20_000)
		});
	} catch (e) {
		throw new AhrefsError(e instanceof Error && e.name === 'TimeoutError' ? 'Ahrefs did not answer within 20 seconds.' : 'Could not reach Ahrefs.', 0);
	}
	const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
	if (res.status === 401 || res.status === 403) throw new AhrefsError('Ahrefs rejected the API key. Create one under Account settings, API keys, in your (free) Ahrefs account.', res.status);
	if (res.status === 429) throw new AhrefsError('Ahrefs is rate limiting this key. It will be tried again tomorrow.', 429);
	if (!res.ok) throw new AhrefsError(typeof body?.error === 'string' && body.error ? `Ahrefs: ${body.error.slice(0, 200)}` : `Ahrefs answered HTTP ${res.status}.`, res.status);
	return parseDomainRatings(body);
}

export async function queryDomainRatings(apiKey: string, targets: string[], fetchImpl: typeof fetch = fetch): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	for (let i = 0; i < targets.length; i += MAX_TARGETS) for (const [k, v] of await queryBatch(apiKey, targets.slice(i, i + MAX_TARGETS), fetchImpl)) out.set(k, v);
	return out;
}

export const ahrefsRow = () => listIntegrations('ahrefs')[0];
/** Connected and the key has not been rejected. */
export const ahrefsIntegration = () => listIntegrations('ahrefs').find((i) => i.status === 'active');

/** Check the key (it asks about ahrefs.com), store it encrypted. Costs nothing. */
export async function connectAhrefs(apiKey: string, o: { fetchImpl?: typeof fetch } = {}) {
	const key = apiKey.trim();
	if (!key) throw new AhrefsError('Paste your Ahrefs API key', 400);
	const demo = config.demo && key === 'demo';
	if (!demo) {
		const r = await queryDomainRatings(key, [PROBE_TARGET], o.fetchImpl ?? fetch);
		if (!r.has(PROBE_TARGET)) throw new AhrefsError('Ahrefs accepted the key but did not answer the check. Try again in a moment.', 502);
	}
	for (const i of listIntegrations('ahrefs')) removeIntegration(i.id);
	const id = saveIntegration('ahrefs', 'Ahrefs', { apiKey: key }, {}, demo);
	audit('ahrefs.connected');
	return { id };
}

export function disconnectAhrefs() {
	for (const i of listIntegrations('ahrefs')) removeIntegration(i.id);
	audit('ahrefs.disconnected');
}

export interface DrRow { site_id: number; dr: number | null; fetched_on: string | null; error: string | null; error_at: number | null }
export const drRows = () => db().prepare('SELECT * FROM site_dr').all() as DrRow[];
export const drFor = (siteId: number) => db().prepare('SELECT * FROM site_dr WHERE site_id = ?').get(siteId) as DrRow | undefined;

/** What the dashboard shows: the last good value (with its day), or null. Never an error. */
export const drBadge = (row: DrRow | undefined): DrBadge | null => (row && row.dr != null ? { dr: Math.round(row.dr * 10) / 10, date: row.fetched_on } : null);

/** Sites Domain Rating is looked up for: shown on the dashboard, readable, and with a domain Ahrefs can be asked about. */
export function drSiteIds(): number[] {
	const rows = db().prepare("SELECT id, site_url FROM sites WHERE hidden = 0 AND permission NOT IN ('siteUnverifiedUser','none')").all() as { id: number; site_url: string }[];
	return rows.filter((r) => domainTarget(r.site_url)).map((r) => r.id);
}

/** Due when connected and the last good value is older than DR_EVERY_DAYS, or the last attempt failed more than a day ago. */
export function drDue(siteId: number, now = Date.now()): boolean {
	if (!ahrefsIntegration() || !drSiteIds().includes(siteId)) return false;
	const row = drFor(siteId);
	if (!row) return true;
	if (row.error_at && now - row.error_at < RETRY_AFTER_ERROR_MS) return false;
	if (!row.fetched_on) return true;
	return now - Date.parse(row.fetched_on + 'T00:00:00Z') >= DR_EVERY_DAYS * DAY;
}

/** Any site due: the scheduler then runs one batch for all of them. */
export const drAnyDue = (now = Date.now()) => !!ahrefsIntegration() && drSiteIds().some((id) => drDue(id, now));

/** Look every site up in one request and store what came back. A site Ahrefs did not answer keeps its last value and records why. */
export async function syncDrAll(o: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<{ stored: number; missing: number }> {
	const integ = ahrefsIntegration();
	if (!integ) throw new Error('Ahrefs is not connected');
	const now = o.now ?? Date.now();
	const bySite = new Map<number, string>();
	for (const id of drSiteIds()) {
		const site = getSite(id);
		const t = site ? domainTarget(site.site_url) : null;
		if (t) bySite.set(id, t);
	}
	if (!bySite.size) return { stored: 0, missing: 0 };
	const key = integrationSecret<{ apiKey: string }>(integ).apiKey;
	const fetchImpl = o.fetchImpl ?? (integ.is_demo ? demoAhrefsFetch() : fetch);
	const d = db();
	const fail = d.prepare('INSERT INTO site_dr (site_id, error, error_at) VALUES (?,?,?) ON CONFLICT(site_id) DO UPDATE SET error = excluded.error, error_at = excluded.error_at');
	let answers: Map<string, number>;
	try {
		answers = await queryDomainRatings(key, [...new Set(bySite.values())], fetchImpl);
	} catch (e) {
		const err = e instanceof AhrefsError ? e : new AhrefsError(e instanceof Error ? e.message : String(e), 0);
		d.transaction(() => { for (const id of bySite.keys()) fail.run(id, err.message, now); })();
		// A rejected key will be rejected for every site: stop asking until someone replaces it.
		if (err.status === 401 || err.status === 403) d.prepare("UPDATE integrations SET status = 'rejected' WHERE id = ?").run(integ.id);
		throw err;
	}
	const ok = d.prepare('INSERT INTO site_dr (site_id, dr, fetched_on, error, error_at) VALUES (?,?,?,NULL,NULL) ON CONFLICT(site_id) DO UPDATE SET dr = excluded.dr, fetched_on = excluded.fetched_on, error = NULL, error_at = NULL');
	let stored = 0, missing = 0;
	d.transaction(() => {
		for (const [id, target] of bySite) {
			const dr = answers.get(normaliseTarget(target));
			if (dr == null) {
				missing++;
				fail.run(id, `Ahrefs gave no Domain Rating for ${target}.`, now);
			} else {
				stored++;
				ok.run(id, dr, utcDay(now));
			}
		}
	})();
	return { stored, missing };
}

/** What the Connect page shows. */
export function ahrefsStatus() {
	const row = ahrefsRow();
	if (!row) return null;
	const ids = drSiteIds();
	const rows = new Map(drRows().map((r) => [r.site_id, r]));
	const errors = ids.map((i) => rows.get(i)).filter((r) => r?.error && r.error_at).sort((a, b) => b!.error_at! - a!.error_at!);
	return {
		demo: !!row.is_demo,
		rejected: row.status === 'rejected',
		total: ids.length,
		withDr: ids.filter((i) => rows.get(i)?.dr != null).length,
		lastError: (errors[0]?.error as string | undefined) ?? null
	};
}
