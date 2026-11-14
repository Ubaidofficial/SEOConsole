import { db } from './db';

/**
 * Authority scores shown next to a site's name: Ahrefs Domain Rating ('dr') and Moz Domain Authority ('da'), both 0 to 100. They are
 * stored one row per site and kind. A failed lookup records its error beside the last good value and never replaces it.
 */
export type AuthKind = 'dr' | 'da';
export interface AuthRow { site_id: number; kind: AuthKind; value: number | null; fetched_on: string | null; error: string | null; error_at: number | null }
export interface AuthBadge { value: number; date: string | null }
export interface SiteAuthority { dr: AuthBadge | null; da: AuthBadge | null }

export const DAY = 86_400_000;
export const RETRY_AFTER_ERROR_MS = DAY;
export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The domain a score is looked up for: a Domain property's domain, or a URL-prefix property's host without a leading www. */
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

/** Sites a score is looked up for: shown on the dashboard, readable, and with a domain the providers can be asked about. */
export function authoritySiteIds(): number[] {
	const rows = db().prepare("SELECT id, site_url FROM sites WHERE hidden = 0 AND permission NOT IN ('siteUnverifiedUser','none')").all() as { id: number; site_url: string }[];
	return rows.filter((r) => domainTarget(r.site_url)).map((r) => r.id);
}

export const authRows = (kind: AuthKind) => db().prepare('SELECT * FROM site_authority WHERE kind = ?').all(kind) as AuthRow[];
export const authFor = (siteId: number, kind: AuthKind) => db().prepare('SELECT * FROM site_authority WHERE site_id = ? AND kind = ?').get(siteId, kind) as AuthRow | undefined;

/** What the pages show: the last good value (with its day), or null. Never an error. */
export const badgeOf = (row: AuthRow | undefined): AuthBadge | null => (row && row.value != null ? { value: Math.round(row.value * 10) / 10, date: row.fetched_on } : null);

export function authorityOf(siteId: number): SiteAuthority {
	return { dr: badgeOf(authFor(siteId, 'dr')), da: badgeOf(authFor(siteId, 'da')) };
}

/** Every site's scores in two queries, for the dashboard. */
export function authorityMap(): Map<number, SiteAuthority> {
	const m = new Map<number, SiteAuthority>();
	for (const kind of ['dr', 'da'] as const) {
		for (const r of authRows(kind)) {
			const cur = m.get(r.site_id) ?? { dr: null, da: null };
			cur[kind] = badgeOf(r);
			m.set(r.site_id, cur);
		}
	}
	return m;
}

export const saveValue = (siteId: number, kind: AuthKind, value: number, now: number) =>
	void db().prepare('INSERT INTO site_authority (site_id, kind, value, fetched_on, error, error_at) VALUES (?,?,?,?,NULL,NULL) ON CONFLICT(site_id, kind) DO UPDATE SET value = excluded.value, fetched_on = excluded.fetched_on, error = NULL, error_at = NULL').run(siteId, kind, value, utcDay(now));

export const saveError = (siteId: number, kind: AuthKind, message: string, now: number) =>
	void db().prepare('INSERT INTO site_authority (site_id, kind, error, error_at) VALUES (?,?,?,?) ON CONFLICT(site_id, kind) DO UPDATE SET error = excluded.error, error_at = excluded.error_at').run(siteId, kind, message, now);

/** Due when never fetched, or the last good value is older than `everyDays`; and not within a day of a failed attempt. */
export function authDue(siteId: number, kind: AuthKind, everyDays: number, now = Date.now()): boolean {
	const row = authFor(siteId, kind);
	if (!row) return true;
	if (row.error_at && now - row.error_at < RETRY_AFTER_ERROR_MS) return false;
	if (!row.fetched_on) return true;
	return now - Date.parse(row.fetched_on + 'T00:00:00Z') >= everyDays * DAY;
}

/** What a Connect panel shows for one provider. */
export function authSummary(kind: AuthKind) {
	const ids = authoritySiteIds();
	const rows = new Map(authRows(kind).map((r) => [r.site_id, r]));
	const errors = ids.map((i) => rows.get(i)).filter((r) => r?.error && r.error_at).sort((a, b) => b!.error_at! - a!.error_at!);
	return { total: ids.length, withValue: ids.filter((i) => rows.get(i)?.value != null).length, lastError: (errors[0]?.error as string | undefined) ?? null };
}
