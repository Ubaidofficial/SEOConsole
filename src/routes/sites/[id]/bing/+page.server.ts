import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { getSite } from '$lib/server/clients';
import { brandTerms, periodFor, siteEnd, summary } from '$lib/server/queries';
import { daysParam } from '$lib/server/params';
import { linksFor } from '$lib/server/links';
import { config } from '$lib/server/config';
import { bingClientFor } from '$lib/server/channels';
import { bingLinksFor, logBingLinks, syncBingLinks } from '$lib/server/binglinks';
import type { BingCrawlClient, BingLinksClient } from '$lib/server/bing';
import { bingCrawlReport, bingPageQueries } from '$lib/server/bingcrawl';
import { isBranded, pctChange } from '$lib/analytics';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const link = linksFor(site.id).bing;
	if (!link) return { linked: false as const };
	const p = periodFor(site, days);
	const d = db();
	const tot = (s: string, e: string) => d.prepare('SELECT COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions FROM bing_daily WHERE site_id = ? AND date BETWEEN ? AND ?').get(site.id, s, e) as { clicks: number; impressions: number };
	const now = tot(p.start, p.end);
	const prev = tot(p.prevStart, p.prevEnd);
	const g = summary(site.id, p.start, p.end);
	const brand = brandTerms(site);
	const terms = (kind: string) =>
		(d.prepare('SELECT term, SUM(clicks) clicks, SUM(impressions) impressions, AVG(click_pos) clickPos FROM bing_terms WHERE site_id = ? AND kind = ? AND date BETWEEN ? AND ? GROUP BY term ORDER BY clicks DESC, impressions DESC LIMIT 500').all(site.id, kind, p.start, p.end) as { term: string; clicks: number; impressions: number; clickPos: number | null }[]).map((r) => ({ ...r, ctr: r.impressions ? r.clicks / r.impressions : 0, branded: kind === 'query' && isBranded(r.term, brand) }));
	const range = d.prepare('SELECT MIN(date) a, MAX(date) b FROM bing_daily WHERE site_id = ?').get(site.id) as { a: string | null; b: string | null };
	return {
		linked: true as const,
		bingUrl: link.external_id,
		status: { state: link.sync_status, message: link.sync_message, lastSync: link.last_sync_at },
		range,
		series: (d.prepare('SELECT date, clicks, impressions FROM bing_daily WHERE site_id = ? AND date BETWEEN ? AND ? ORDER BY date').all(site.id, p.start, p.end) as { date: string; clicks: number; impressions: number }[]).map((r) => ({ ...r, position: 0 })),
		kpi: { clicks: now.clicks, impressions: now.impressions, clicksDelta: pctChange(now.clicks, prev.clicks), impressionsDelta: pctChange(now.impressions, prev.impressions), googleClicks: g.clicks, shareOfGoogle: g.clicks ? now.clicks / g.clicks : null },
		queries: terms('query'),
		pages: terms('page'),
		linksData: bingLinksFor(site),
		crawl: bingCrawlReport(site.id, p.start, p.end),
		readOnly: config.readOnly
	};
};

/** Asking again within this time is refused: Bing's link data only changes slowly and its calls are rate-limited. */
const REFRESH_COOLDOWN_MS = 10 * 60_000;

export const actions: Actions = {
	/** The searches that showed one page on Bing, read live for the chosen period (nothing stored, nothing changed). */
	pageQueries: async ({ params, request, url }) => {
		const site = getSite(Number(params.id))!;
		const link = linksFor(site.id).bing;
		if (!link?.integration_id) return fail(400, { pqError: 'Bing is not linked to this site.' });
		const page = String((await request.formData()).get('page') ?? '').trim();
		if (!/^https?:\/\//i.test(page) || page.length > 2000) return fail(400, { pqError: 'Pick a page from the table.' });
		const days = daysParam(url, siteEnd(site));
		const p = periodFor(site, days);
		try {
			return { pageQueries: await bingPageQueries(bingClientFor(link.integration_id) as Partial<BingCrawlClient>, link.external_id, page, p.start, p.end) };
		} catch (e) {
			return fail(502, { pqError: e instanceof Error ? e.message : String(e), page });
		}
	},
	refreshLinks: async ({ params }) => {
		if (config.readOnly) return fail(403, { error: 'Read-only mode: nothing was fetched.' });
		const site = getSite(Number(params.id))!;
		const link = linksFor(site.id).bing;
		if (!link?.integration_id) return fail(400, { error: 'Bing is not linked to this site.' });
		const row = db().prepare('SELECT fetched_at, error_at FROM bing_links WHERE site_id = ?').get(site.id) as { fetched_at: number; error_at: number | null } | undefined;
		if (row && Date.now() - Math.max(row.fetched_at, row.error_at ?? 0) < REFRESH_COOLDOWN_MS) return fail(429, { error: 'Fetched a moment ago. Try again in a few minutes.' });
		const r = await syncBingLinks(site.id, bingClientFor(link.integration_id) as Partial<BingLinksClient>);
		logBingLinks(site.id, r.ok ? `refreshed: ${r.pages} pages with links, ${r.issues} crawl issues` : `refresh failed: ${r.error}`);
		return r.ok ? { ok: true as const } : fail(502, { error: r.error ?? 'Bing did not answer.' });
	}
};
