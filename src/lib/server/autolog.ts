import { audit, db } from './db';
import { pacificToday } from './dates';

/**
 * Change-log entries the app writes itself, from changes it already detects: a robots.txt change, a new Tag Manager version
 * going live, and pages appearing in or leaving the sitemaps. They are ordinary entries (kind "detected"), so they show on the
 * chart and can be turned into a test or deleted. Each detected event has a key that is remembered even after its entry is
 * deleted, so a deleted entry never comes back. A site can switch this off (sites.changelog_auto).
 */

export interface Detected {
	/** identifies the event, e.g. robots:12 or gtm:accounts/1/containers/2:7; written once per site */
	key: string;
	title: string;
	note?: string | null;
	/** a full URL prefix the before/after comparison is limited to, e.g. https://example.com/blog/ */
	pagePrefix?: string | null;
	date?: string;
}

export const autoLogOn = (siteId: number) => !!(db().prepare('SELECT changelog_auto a FROM sites WHERE id = ?').get(siteId) as { a: number } | undefined)?.a;

/** Write one detected entry, unless the site switched this off or the same event was logged (or logged and deleted) before. */
export function logDetected(siteId: number, e: Detected): number | null {
	const d = db();
	if (!autoLogOn(siteId)) return null;
	if (d.prepare('SELECT 1 FROM annotation_auto WHERE site_id = ? AND key = ?').get(siteId, e.key)) return null;
	const now = Date.now();
	return d.transaction(() => {
		const id = Number(
			d.prepare('INSERT INTO annotations (site_id, date, title, note, kind, page_prefix, created_at) VALUES (?,?,?,?,?,?,?)').run(siteId, e.date ?? pacificToday(), e.title.slice(0, 200), e.note?.slice(0, 2000) ?? null, 'detected', e.pagePrefix ?? null, now).lastInsertRowid
		);
		d.prepare('INSERT INTO annotation_auto (site_id, key, annotation_id, created_at) VALUES (?,?,?,?)').run(siteId, e.key, id, now);
		audit('annotation.detected', { siteId, detail: e.title.slice(0, 200) });
		return id;
	})();
}

const list = (a: string[], n = 5) => a.slice(0, n).join('; ') + (a.length > n ? `; and ${a.length - n} more` : '');

/** robots.txt: one entry per recorded change. */
export function logRobotsChange(siteId: number, c: { id: number; origin: string; at: number; afterState: string; added: string[]; removed: string[] }) {
	const host = c.origin.replace(/^https?:\/\//, '');
	const title = c.afterState === 'ok' ? `robots.txt rules changed on ${host}` : c.afterState === 'error' ? `robots.txt on ${host} started answering with errors` : `robots.txt on ${host} is now ${c.afterState}`;
	const note = [c.added.length ? `Added: ${list(c.added)}` : '', c.removed.length ? `Removed: ${list(c.removed)}` : ''].filter(Boolean).join('\n') || null;
	return logDetected(siteId, { key: `robots:${c.id}`, title, note, date: pacificToday(new Date(c.at)) });
}

/** Tag Manager: a new live version, compared with the version stored at the previous sync of the same container. */
export function logGtmVersion(siteId: number, c: { path: string; publicId: string | null; before: string | null | undefined; versionId: string | null; versionName: string | null }) {
	if (!c.before || !c.versionId || c.before === c.versionId) return null;
	return logDetected(siteId, {
		key: `gtm:${c.path}:${c.versionId}`,
		title: `Tag Manager: version ${c.versionId}${c.versionName ? ` "${c.versionName}"` : ''} went live${c.publicId ? ` in ${c.publicId}` : ''}`,
		note: `Seen at the Tag Manager sync; the previous live version was ${c.before}. Tags firing differently can move GA4 and conversion figures.`
	});
}

/** The longest folder all URLs share (origin + path ending in "/"), or null when they span hosts or share only the root. */
export function commonFolder(urls: string[]): string | null {
	let origin: string | null = null;
	let segs: string[] | null = null;
	for (const raw of urls) {
		let u: URL;
		try {
			u = new URL(raw);
		} catch {
			return null;
		}
		if (origin && u.origin !== origin) return null;
		origin = u.origin;
		const folders = u.pathname.split('/').filter(Boolean).slice(0, -1);
		segs = segs === null ? folders : segs.slice(0, [...segs, ''].findIndex((s, i) => s !== folders[i]));
	}
	return origin && segs?.length ? `${origin}/${segs.join('/')}/` : null;
}

export const SITEMAP_ADDED_MIN = 3;
export const SITEMAP_REMOVED_MIN = 10;
/** Sitemaps: a read that adds at least 3 pages, or drops at least 10, is a change worth a note (one of each a day). */
export function logSitemapChanges(siteId: number, c: { added: string[]; removed: string[] } | null, today = pacificToday()) {
	if (!c) return [];
	const out: (number | null)[] = [];
	if (c.added.length >= SITEMAP_ADDED_MIN) {
		const folder = commonFolder(c.added);
		out.push(logDetected(siteId, { key: `sitemap-added:${today}`, date: today, title: `${c.added.length} new pages in the sitemaps${folder ? ` under ${new URL(folder).pathname}` : ''}`, note: `For example: ${list(c.added, 3)}`, pagePrefix: folder }));
	}
	if (c.removed.length >= SITEMAP_REMOVED_MIN) {
		const folder = commonFolder(c.removed);
		out.push(logDetected(siteId, { key: `sitemap-removed:${today}`, date: today, title: `${c.removed.length} pages left the sitemaps${folder ? ` under ${new URL(folder).pathname}` : ''}`, note: `For example: ${list(c.removed, 3)}`, pagePrefix: folder }));
	}
	return out;
}
