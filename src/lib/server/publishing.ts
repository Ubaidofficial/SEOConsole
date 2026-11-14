import { db } from './db';
import type { SiteRow } from './clients';
import { pacificToday } from './dates';
import { periodFor } from './queries';
import { normalizeUrl } from '../analytics';
import { indexState } from '../indexing';
import { flatten } from './indexmon';
import { publishingReport, type IdxState, type PubUrl, type PublishingReport } from '../publishing';

/** Publishing health for one site from the stored sitemap read, Search Console rows and URL Inspection sample. Nothing is fetched. */
export function publishingFor(site: SiteRow, days = 90, depth = 1): PublishingReport & { synced: boolean } {
	const d = db();
	const rows = d.prepare('SELECT url, norm, lastmod FROM sitemap_urls WHERE site_id = ?').all(site.id) as { url: string; norm: string; lastmod: string | null }[];
	const p = periodFor(site, days);
	const seen = new Map<string, { clicks: number; impressions: number }>();
	for (const r of d.prepare('SELECT page, SUM(clicks) clicks, SUM(impressions) impressions FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY page').all(site.id, p.start, p.end) as { page: string; clicks: number; impressions: number }[]) {
		const k = normalizeUrl(r.page);
		const c = seen.get(k) ?? { clicks: 0, impressions: 0 };
		seen.set(k, { clicks: c.clicks + r.clicks, impressions: c.impressions + r.impressions });
	}
	const insp = new Map((d.prepare('SELECT url, result FROM url_inspections WHERE site_id = ?').all(site.id) as { url: string; result: string }[]).map((r) => [r.url, JSON.parse(r.result)]));
	const urls: PubUrl[] = rows.map((r) => {
		const s = seen.get(r.norm);
		const raw = insp.get(r.url);
		const flat = raw ? flatten(raw) : null;
		const index: IdxState | null = raw ? indexState(flat) : null;
		return { url: r.url, lastmod: r.lastmod, clicks: s?.clicks ?? 0, impressions: s?.impressions ?? 0, index, reason: index === 'not_indexed' ? (flat?.coverageState ?? null) : null };
	});
	const synced = !!d.prepare('SELECT 1 FROM sitemap_sync WHERE site_id = ?').get(site.id);
	return { ...publishingReport(urls, pacificToday(), days, depth), synced };
}
