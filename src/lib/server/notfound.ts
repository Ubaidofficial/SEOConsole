import { db } from './db';
import type { SiteRow } from './clients';
import { periodFor } from './queries';
import { pagePath } from '../rules';

/**
 * Pages visitors reach that answer "not found", found through GA4: a page whose title (as GA4 recorded it over the last 28 days) reads
 * like a 404 in English, Spanish, French, German, Italian, Portuguese or Dutch. For each: its views, the AI assistants that sent visits
 * to it, and whether Google ever showed it in search or it is in a sitemap. A not-found address that an AI assistant sends people to,
 * and that neither Google nor a sitemap knows, is most likely an address the assistant made up: redirect it to the page it meant.
 *
 * Needs GA4 linked. Sites whose 404 page has an ordinary title (or no GA4 tag on it) cannot be found this way.
 */
export const NOT_FOUND_TITLE = /(^|\W)404(\W|$)|not found|page (?:does ?n[o']t|doesn't) exist|no encontrad|no existe|introuvable|non trouv|n'existe pas|nicht gefunden|existiert nicht|non trovat|não encontrad|nao encontrad|niet gevonden|bestaat niet/i;

export interface NotFoundRow { path: string; title: string; views: number; ai: number; assistants: string[]; inSearch: boolean; inSitemap: boolean; likelyInvented: boolean }

export function notFoundPages(site: Pick<SiteRow, 'id' | 'synced_through'>, days = 28): { rows: NotFoundRow[]; ga4: boolean; titles: number } {
	const d = db();
	const titles = d.prepare('SELECT page, title FROM ga4_page_titles WHERE site_id = ?').all(site.id) as { page: string; title: string }[];
	if (!titles.length) return { rows: [], ga4: false, titles: 0 };
	const bad = titles.filter((t) => NOT_FOUND_TITLE.test(t.title));
	if (!bad.length) return { rows: [], ga4: true, titles: titles.length };
	const p = periodFor(site, days);
	const views = new Map((d.prepare('SELECT page, SUM(views) v FROM ga4_page_views WHERE site_id = ? AND date >= ? GROUP BY page').all(site.id, p.start) as { page: string; v: number }[]).map((r) => [r.page, r.v]));
	const aiRows = d.prepare('SELECT page, assistant, SUM(sessions) s FROM ga4_ai_daily WHERE site_id = ? AND date >= ? GROUP BY page, assistant').all(site.id, p.start) as { page: string; assistant: string; s: number }[];
	const ai = new Map<string, { s: number; who: Set<string> }>();
	for (const r of aiRows) {
		const x = ai.get(r.page) ?? { s: 0, who: new Set<string>() };
		x.s += r.s;
		if (r.s > 0) x.who.add(r.assistant);
		ai.set(r.page, x);
	}
	// Paths Google has shown in the stored history, and paths in a sitemap (both by path, so every host counts)
	const inSearch = new Set((d.prepare('SELECT DISTINCT page FROM sa_rows WHERE site_id = ?').all(site.id) as { page: string }[]).map((r) => pagePath(r.page).split('?')[0]));
	const inSitemap = new Set((d.prepare('SELECT url FROM sitemap_urls WHERE site_id = ?').all(site.id) as { url: string }[]).map((r) => pagePath(r.url).split('?')[0]));
	const rows = bad.map((t): NotFoundRow => {
		const a = ai.get(t.page);
		const known = inSearch.has(t.page) || inSitemap.has(t.page);
		return { path: t.page, title: t.title, views: views.get(t.page) ?? 0, ai: a?.s ?? 0, assistants: [...(a?.who ?? [])].sort(), inSearch: inSearch.has(t.page), inSitemap: inSitemap.has(t.page), likelyInvented: !!a?.s && !known };
	});
	rows.sort((x, y) => Number(y.likelyInvented) - Number(x.likelyInvented) || y.ai - x.ai || y.views - x.views);
	return { rows: rows.slice(0, 200), ga4: true, titles: titles.length };
}
