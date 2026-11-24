import { db } from './db';
import { forgetSite } from './apikeys';
import { allSites } from './queries';
import { coverageMap, isRootPrefix } from '../property';

/** Root-path URL-prefix properties that a visible Domain property already covers. */
export function hideableDuplicates() {
	const sites = allSites();
	const cover = coverageMap(sites);
	return sites.filter((s) => cover.has(s.id) && isRootPrefix(s.site_url)).map((s) => ({ id: s.id, url: s.site_url, coveredBy: cover.get(s.id)! }));
}

/** Hide them: hidden properties are excluded from totals and stop syncing, which also saves API calls. */
export function hideCoveredDuplicates(): number {
	const ids = hideableDuplicates().map((d) => d.id);
	const hide = db().prepare('UPDATE sites SET hidden = 1 WHERE id = ?');
	db().transaction(() => ids.forEach((id) => hide.run(id)))();
	return ids.length;
}

/**
 * Delete the stored data of a property Search Console no longer lists (permission 'none'). Refuses anything else, so a
 * live property can never be deleted from here. Returns whether a property was deleted.
 */
export function purgeRemovedSite(id: number): boolean {
	const row = db().prepare('SELECT permission FROM sites WHERE id = ?').get(id) as { permission: string } | undefined;
	if (!row || row.permission !== 'none') return false;
	// Kept for RESTORE_DAYS (restorable from "Recently removed" on the dashboard), then deleted by deleteExpiredSites().
	db().prepare('UPDATE sites SET deleted_at = ? WHERE id = ?').run(Date.now(), id);
	return true;
}

/** How long a removed site and its history can still be brought back. */
export const RESTORE_DAYS = 14;

/** Sites removed in the last RESTORE_DAYS days, newest first. */
export function recentlyRemoved(scope: number[] | null): { id: number; siteUrl: string; label: string | null; deletedAt: number; until: number }[] {
	const rows = db().prepare('SELECT id, site_url, label, deleted_at FROM sites WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all() as { id: number; site_url: string; label: string | null; deleted_at: number }[];
	return rows.filter((r) => scope === null || scope.includes(r.id)).map((r) => ({ id: r.id, siteUrl: r.site_url, label: r.label, deletedAt: r.deleted_at, until: r.deleted_at + RESTORE_DAYS * 86_400_000 }));
}

/** Bring a removed site back with its history. It shows as "removed in Search Console" until Google lists the property again. */
export function restoreSite(id: number): boolean {
	return db().prepare('UPDATE sites SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(id).changes > 0;
}

/** Delete a removed site and its stored history for good (now, or once its RESTORE_DAYS have passed). */
export function deleteRemovedNow(id: number): boolean {
	const row = db().prepare('SELECT 1 FROM sites WHERE id = ? AND deleted_at IS NOT NULL').get(id);
	if (!row) return false;
	forgetSite(id);
	db().prepare('DELETE FROM sites WHERE id = ?').run(id); // child tables cascade
	return true;
}

export function deleteExpiredSites(now = Date.now()): number {
	const ids = db().prepare('SELECT id FROM sites WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(now - RESTORE_DAYS * 86_400_000) as { id: number }[];
	for (const r of ids) deleteRemovedNow(r.id);
	return ids.length;
}
