import { db } from './db';
import { config } from './config';
import { RealBingClient, type BingClient, type BingLinksClient } from './bing';
import { bingLinksDue, syncBingLinks } from './binglinks';
import { DemoBing, DEMO_GA4_PROPERTIES, demoClarityFetch, demoGa4Daily, demoGa4Landing, demoGa4UsersByChannel, demoGa4MeasurementId, demoGa4AiTraffic, demoGa4AiDaily, demoGa4OrganicDaily, demoGa4Sources, demoGa4DimDaily, demoGa4KeyEvents, demoGa4LandingAll, demoGtmContainers, demoGtmLive } from './demo-channels';
import { callsLeft, CLARITY_FRESH_MS, CLARITY_SYNC_DIMENSIONS, fetchInsights, utcDay } from './clarity';
import * as ga4 from './ga4';
import * as gtm from './gtm';
import { addDays, pacificToday, retentionHorizon } from './dates';
import { getIntegration, integrationSecret, linksFor, markLink } from './links';
import { getSite } from './clients';
import { logGtmVersion } from './autolog';
import { PERIODS } from '../periods';

// ── factories (real vs demo) ─────────────────────────────────────────────────
export function bingClientFor(integrationId: number): BingClient {
	const i = getIntegration(integrationId);
	if (!i) throw new Error('Unknown Bing connection');
	return i.is_demo ? new DemoBing() : new RealBingClient(integrationId);
}

export interface Ga4Source {
	listProperties(): Promise<ga4.Ga4Property[]>;
	streamUrls(property: string): Promise<string[]>;
	/** Measurement IDs (G-…) of the property's web streams; [] when unknown. */
	measurementIds(property: string): Promise<string[]>;
	daily(property: string, start: string, end: string): Promise<ga4.Ga4Day[]>;
	/** Unique users per channel over a whole window. */
	usersByChannel(property: string, start: string, end: string): Promise<ga4.Ga4ChannelUsers[]>;
	/** Google-organic landing pages over a whole window. */
	landing(property: string, start: string, end: string): Promise<ga4.Ga4Landing[]>;
	/** Sessions from AI assistants over a whole window, by landing page. */
	aiTraffic(property: string, start: string, end: string): Promise<ga4.Ga4Ai[]>;
	/** Google-organic sessions and key events by day and landing page (for SEO tests judged on conversions). */
	organicDaily(property: string, start: string, end: string): Promise<ga4.Ga4PageDay[]>;
	/** AI-assistant sessions by day, assistant and landing page (for LLM tests). Optional so a test double can leave it out. */
	aiDaily?(property: string, start: string, end: string): Promise<ga4.Ga4AiDay[]>;
	/** Sessions by source / medium over a whole window (which sites and campaigns send traffic). Optional so a test double can leave it out. */
	sources?(property: string, start: string, end: string): Promise<ga4.Ga4SourceRow[]>;
	/** Sessions by day for one dimension (country, device, new vs returning). Optional so a test double can leave it out. */
	dimDaily?(property: string, dim: ga4.Ga4Dim, start: string, end: string): Promise<ga4.Ga4DimDay[]>;
	/** Key events by day and event name. Optional so a test double can leave it out. */
	keyEventsDaily?(property: string, start: string, end: string): Promise<ga4.Ga4EventDay[]>;
	/** Landing pages over a whole window, every channel, per channel group. Optional so a test double can leave it out. */
	landingAll?(property: string, start: string, end: string): Promise<{ rows: ga4.Ga4LandingChannel[]; truncated: boolean }>;
}

export function ga4SourceFor(accountId: number): Ga4Source {
	const a = db().prepare('SELECT google_sub, is_demo FROM accounts WHERE id = ?').get(accountId) as { google_sub: string; is_demo: number } | undefined;
	if (!a) throw new Error('Unknown Google account');
	if (a.is_demo) {
		const props = DEMO_GA4_PROPERTIES(a.google_sub);
		return {
			listProperties: async () => props.map((p) => p.prop),
			streamUrls: async (property) => props.filter((p) => p.prop.property === property).map((p) => p.url),
			measurementIds: async (property) => [demoGa4MeasurementId(property)],
			daily: async (property, s, e) => demoGa4Daily(property, s, e),
			usersByChannel: async (property, s, e) => demoGa4UsersByChannel(property, s, e),
			landing: (property, s, e) => demoGa4Landing(property, s, e),
			aiTraffic: (property, s, e) => demoGa4AiTraffic(property, s, e),
			organicDaily: (property, s, e) => demoGa4OrganicDaily(property, s, e),
			aiDaily: async (property, s, e) => demoGa4AiDaily(property, s, e),
			sources: async (property, s, e) => demoGa4Sources(property, s, e),
			dimDaily: async (property, dim, s, e) => demoGa4DimDaily(property, dim, s, e),
			keyEventsDaily: async (property, s, e) => demoGa4KeyEvents(property, s, e),
			landingAll: (property, s, e) => demoGa4LandingAll(property, s, e)
		};
	}
	return {
		listProperties: () => ga4.listProperties(accountId),
		streamUrls: (p) => ga4.webStreamUrls(accountId, p),
		measurementIds: (p) => ga4.webStreamMeasurementIds(accountId, p),
		daily: (p, s, e) => ga4.dailyByChannel(accountId, p, s, e),
		usersByChannel: (p, s, e) => ga4.usersByChannel(accountId, p, s, e),
		landing: (p, s, e) => ga4.organicGoogleLanding(accountId, p, s, e),
		aiTraffic: (p, s, e) => ga4.aiAssistantTraffic(accountId, p, s, e),
		organicDaily: (p, s, e) => ga4.organicLandingDaily(accountId, p, s, e),
		aiDaily: (p, s, e) => ga4.aiAssistantDaily(accountId, p, s, e),
		sources: (p, s, e) => ga4.trafficSources(accountId, p, s, e),
		dimDaily: (p, dim, s, e) => ga4.dailyByDimension(accountId, p, dim, s, e),
		keyEventsDaily: (p, s, e) => ga4.keyEventsDaily(accountId, p, s, e),
		landingAll: (p, s, e) => ga4.landingAllChannels(accountId, p, s, e)
	};
}

export function gtmSourceFor(accountId: number): gtm.GtmSource {
	const a = db().prepare('SELECT is_demo FROM accounts WHERE id = ?').get(accountId) as { is_demo: number } | undefined;
	if (!a) throw new Error('Unknown Google account');
	if (a.is_demo) return { listContainers: async () => demoGtmContainers(), liveVersion: async (path) => demoGtmLive(path) };
	return { listContainers: () => gtm.listContainers(accountId), liveVersion: (path) => gtm.liveVersion(accountId, path) };
}

// ── sync: Bing ───────────────────────────────────────────────────────────────
export async function syncBing(siteId: number, client?: BingClient) {
	const link = linksFor(siteId).bing;
	if (!link?.integration_id) throw new Error('Site is not linked to Bing');
	markLink(siteId, 'bing', 'running');
	try {
		const c = client ?? bingClientFor(link.integration_id);
		const [daily, queries, pages] = await Promise.all([c.dailyStats(link.external_id), c.queryStats(link.external_id), c.pageStats(link.external_id)]);
		const d = db();
		d.transaction(() => {
			d.prepare('DELETE FROM bing_daily WHERE site_id = ?').run(siteId);
			d.prepare('DELETE FROM bing_terms WHERE site_id = ?').run(siteId);
			const insDay = d.prepare('INSERT OR REPLACE INTO bing_daily VALUES (?,?,?,?)');
			for (const r of daily) insDay.run(siteId, r.date, r.clicks, r.impressions);
			const insTerm = d.prepare('INSERT OR REPLACE INTO bing_terms VALUES (?,?,?,?,?,?,?,?)');
			for (const [kind, rows] of [['query', queries], ['page', pages]] as const) for (const r of rows) insTerm.run(siteId, kind, r.date, r.term, r.clicks, r.impressions, r.clickPos, r.imprPos);
		})();
		markLink(siteId, 'bing', 'idle', null, true);
		// Inbound links and crawl issues: weekly, extra data, so a failure is recorded inside syncBingLinks and never fails this sync.
		if (bingLinksDue(siteId)) await syncBingLinks(siteId, c as Partial<BingLinksClient>);
		return { days: daily.length, queries: queries.length, pages: pages.length };
	} catch (e) {
		markLink(siteId, 'bing', 'error', e instanceof Error ? e.message : String(e));
		throw e;
	}
}

/**
 * Whole-window GA4 reports (unique users per channel, Google-organic landing pages), refreshed at most once a day, for
 * each period length the app offers. Extra data: a failure here is returned, never thrown.
 */
export async function pullGa4Periods(siteId: number, property: string, src: Ga4Source, today: string): Promise<{ ok: boolean }> {
	const d = db();
	if (d.prepare('SELECT 1 FROM sites WHERE id = ? AND ga4_periods_on = ?').get(siteId, today)) return { ok: true };
	const horizon = retentionHorizon(today);
	const insU = d.prepare('INSERT OR REPLACE INTO ga4_period_users VALUES (?,?,?,?,?)');
	const insL = d.prepare('INSERT OR REPLACE INTO ga4_landing VALUES (?,?,?,?,?,?,?)');
	const insLP = d.prepare('INSERT OR REPLACE INTO ga4_landing_prev VALUES (?,?,?,?,?,?,?)');
	const insA = d.prepare('INSERT OR REPLACE INTO ga4_ai VALUES (?,?,?,?,?,?,?,?)');
	const insAP = d.prepare('INSERT OR REPLACE INTO ga4_ai_prev VALUES (?,?,?,?,?,?,?,?)');
	let aiFailed = false;
	try {
		for (const days of PERIODS) {
			let start = addDays(today, -(days - 1));
			if (start < horizon) start = horizon;
			// The AI-assistant report is an extra: if it fails, users and landing pages are still stored.
			// The window just before this one, so each page can show its change. Only when the whole previous window is inside GA4's
			// retention; an extra like the AI report, so a failure just means no change figures.
			const prevStart = addDays(today, -(2 * days - 1));
			const wantPrev = start === addDays(today, -(days - 1)) && prevStart >= horizon;
			const [users, landing, ai, landingPrev, aiPrev] = await Promise.all([
				src.usersByChannel(property, start, today),
				src.landing(property, start, today),
				src.aiTraffic(property, start, today).catch(() => (aiFailed = true, null)),
				wantPrev ? src.landing(property, prevStart, addDays(start, -1)).catch(() => null) : Promise.resolve(null),
				// Same for the AI report: no previous window means no change figures for AI sessions, never a change against an assumed zero.
				wantPrev ? src.aiTraffic(property, prevStart, addDays(start, -1)).catch(() => null) : Promise.resolve(null)
			]);
			d.transaction(() => {
				d.prepare('DELETE FROM ga4_period_users WHERE site_id = ? AND days = ?').run(siteId, days);
				d.prepare('DELETE FROM ga4_landing WHERE site_id = ? AND days = ?').run(siteId, days);
				for (const u of users) insU.run(siteId, days, u.channel, u.users, today);
				for (const l of landing) insL.run(siteId, days, l.page, l.sessions, l.engagedSessions, l.keyEvents, today);
				d.prepare('DELETE FROM ga4_landing_prev WHERE site_id = ? AND days = ?').run(siteId, days);
				for (const l of landingPrev ?? []) insLP.run(siteId, days, l.page, l.sessions, l.engagedSessions, l.keyEvents, today);
				if (ai) {
					d.prepare('DELETE FROM ga4_ai WHERE site_id = ? AND days = ?').run(siteId, days);
					for (const a of ai) insA.run(siteId, days, a.assistant, a.page, a.sessions, a.engagedSessions, a.keyEvents, today);
				}
				d.prepare('DELETE FROM ga4_ai_prev WHERE site_id = ? AND days = ?').run(siteId, days);
				for (const a of aiPrev ?? []) insAP.run(siteId, days, a.assistant, a.page, a.sessions, a.engagedSessions, a.keyEvents, today);
			})();
		}
		d.prepare('UPDATE sites SET ga4_periods_on = ?, ga4_ai_on = ? WHERE id = ?').run(today, aiFailed ? null : today, siteId);
		return { ok: true };
	} catch {
		return { ok: false };
	}
}

/**
 * Sessions by source / medium, and by landing page and channel (every channel), for each period length and for the equally long
 * window before it when GA4 still keeps all of it, so a referring site or a page can be found and its change shown. Both reports
 * succeed or fail together, so a page never shows sources and landing pages from different days. Once a day after a success; a failure is recorded on the site and
 * retried on the next sync, and the rows from the last success stay (the report says they are older). Never throws.
 */
export async function pullGa4Sources(siteId: number, property: string, src: Ga4Source, today: string): Promise<{ ok: boolean }> {
	if (!src.sources) return { ok: true };
	const d = db();
	if (d.prepare('SELECT 1 FROM sites WHERE id = ? AND ga4_sources_on = ?').get(siteId, today)) return { ok: true };
	const horizon = retentionHorizon(today);
	try {
		type Pages = { rows: ga4.Ga4LandingChannel[]; truncated: boolean } | null;
		const pulled: { days: number; which: 'now' | 'prev'; start: string; end: string; rows: ga4.Ga4SourceRow[]; pages: Pages }[] = [];
		const pages = (s: string, e: string): Promise<Pages> => (src.landingAll ? src.landingAll(property, s, e) : Promise.resolve(null));
		for (const days of PERIODS) {
			let start = addDays(today, -(days - 1));
			if (start < horizon) start = horizon;
			const prevStart = addDays(today, -(2 * days - 1));
			const wantPrev = start === addDays(today, -(days - 1)) && prevStart >= horizon;
			const prevEnd = addDays(start, -1);
			const [now, prev, nowPages, prevPages] = await Promise.all([
				src.sources(property, start, today),
				wantPrev ? src.sources(property, prevStart, prevEnd) : Promise.resolve(null),
				pages(start, today),
				wantPrev ? pages(prevStart, prevEnd) : Promise.resolve(null)
			]);
			pulled.push({ days, which: 'now', start, end: today, rows: now, pages: nowPages });
			if (prev) pulled.push({ days, which: 'prev', start: prevStart, end: prevEnd, rows: prev, pages: prevPages });
		}
		const ins = d.prepare('INSERT OR REPLACE INTO ga4_sources VALUES (?,?,?,?,?,?,?,?,?)');
		const insW = d.prepare('INSERT OR REPLACE INTO ga4_source_windows VALUES (?,?,?,?,?,?,?)');
		const insP = d.prepare('INSERT OR REPLACE INTO ga4_pages VALUES (?,?,?,?,?,?,?,?)');
		// All windows replaced together, so a page never mixes today's sources with an older previous window.
		d.transaction(() => {
			d.prepare('DELETE FROM ga4_sources WHERE site_id = ?').run(siteId);
			d.prepare('DELETE FROM ga4_source_windows WHERE site_id = ?').run(siteId);
			d.prepare('DELETE FROM ga4_pages WHERE site_id = ?').run(siteId);
			for (const w of pulled) {
				insW.run(siteId, w.days, w.which, w.start, w.end, w.rows.length, w.pages?.truncated ? 1 : 0);
				for (const r of w.rows) ins.run(siteId, w.days, w.which, r.source, r.medium, r.channel, r.sessions, r.engagedSessions, r.keyEvents);
				for (const r of w.pages?.rows ?? []) insP.run(siteId, w.days, w.which, r.page, r.channel, r.sessions, r.engagedSessions, r.keyEvents);
			}
			d.prepare('UPDATE sites SET ga4_sources_on = ?, ga4_sources_error = NULL WHERE id = ?').run(today, siteId);
		})();
		return { ok: true };
	} catch (e) {
		d.prepare('UPDATE sites SET ga4_sources_error = ? WHERE id = ?').run((e instanceof Error ? e.message : String(e)).slice(0, 500), siteId);
		return { ok: false };
	}
}

/**
 * Sessions by day by country, device category and new vs returning, and key events by day and event name, for the all-sources
 * dashboard and the GA4 tab. Like the channel data: the
 * whole retained history the first time a dimension is pulled, then the last 10 days (GA4 reprocesses recent days). Extra data: a
 * failure is recorded on the site and retried on the next sync, and never fails it. Never throws.
 */
export async function pullGa4Dims(siteId: number, property: string, src: Ga4Source, today: string): Promise<{ ok: boolean }> {
	if (!src.dimDaily) return { ok: true };
	const d = db();
	const ins = d.prepare('INSERT OR REPLACE INTO ga4_dim_daily VALUES (?,?,?,?,?,?,?,?)');
	try {
		for (const dim of Object.keys(ga4.GA4_DIMS) as ga4.Ga4Dim[]) {
			const have = !!d.prepare('SELECT 1 FROM ga4_dim_daily WHERE site_id = ? AND dim = ? LIMIT 1').get(siteId, dim);
			const start = have ? addDays(today, -10) : retentionHorizon(today);
			const rows = await src.dimDaily(property, dim, start, today);
			d.transaction(() => {
				d.prepare('DELETE FROM ga4_dim_daily WHERE site_id = ? AND dim = ? AND date >= ?').run(siteId, dim, start);
				for (const r of rows) ins.run(siteId, dim, r.date, r.value, r.sessions, r.engagedSessions, r.keyEvents, r.pageviews);
			})();
		}
		if (src.keyEventsDaily) {
			// Key events: an empty table can also mean no key events are set up, so the full history is asked again until one appears.
			const have = !!d.prepare('SELECT 1 FROM ga4_event_daily WHERE site_id = ? LIMIT 1').get(siteId);
			const start = have ? addDays(today, -10) : retentionHorizon(today);
			const rows = await src.keyEventsDaily(property, start, today);
			const insE = d.prepare('INSERT OR REPLACE INTO ga4_event_daily VALUES (?,?,?,?,?)');
			d.transaction(() => {
				d.prepare('DELETE FROM ga4_event_daily WHERE site_id = ? AND date >= ?').run(siteId, start);
				for (const r of rows) insE.run(siteId, r.date, r.event, r.keyEvents, r.eventCount);
			})();
		}
		d.prepare('UPDATE sites SET ga4_dims_error = NULL WHERE id = ?').run(siteId);
		return { ok: true };
	} catch (e) {
		d.prepare('UPDATE sites SET ga4_dims_error = ? WHERE id = ?').run((e instanceof Error ? e.message : String(e)).slice(0, 500), siteId);
		return { ok: false };
	}
}

// ── sync: GA4 ────────────────────────────────────────────────────────────────
export async function syncGa4(siteId: number, source?: Ga4Source, today = pacificToday()) {
	const link = linksFor(siteId).ga4;
	if (!link?.account_id) throw new Error('Site is not linked to a GA4 property');
	markLink(siteId, 'ga4', 'running');
	try {
		const src = source ?? ga4SourceFor(link.account_id);
		const have = (db().prepare('SELECT COUNT(*) n FROM ga4_daily WHERE site_id = ?').get(siteId) as { n: number }).n > 0;
		// GA4 reprocesses recent days, so re-pull the last 10 after the initial backfill.
		const start = have ? addDays(today, -10) : retentionHorizon(today);
		const rows = await src.daily(link.external_id, start, today);
		const d = db();
		d.transaction(() => {
			d.prepare('DELETE FROM ga4_daily WHERE site_id = ? AND date >= ?').run(siteId, start);
			const ins = d.prepare('INSERT OR REPLACE INTO ga4_daily VALUES (?,?,?,?,?,?,?,?)');
			for (const r of rows) ins.run(siteId, r.date, r.channel, r.sessions, r.engagedSessions, r.users, r.keyEvents, r.pageviews);
		})();
		const periods = await pullGa4Periods(siteId, link.external_id, src, today);
		// Recorded on the site and shown with the sources table; it does not change the sync status.
		await pullGa4Sources(siteId, link.external_id, src, today);
		await pullGa4Dims(siteId, link.external_id, src, today);
		markLink(siteId, 'ga4', 'idle', periods.ok ? null : 'Daily data synced; user and landing-page reports could not be fetched (will retry).', true);
		return { rows: rows.length };
	} catch (e) {
		markLink(siteId, 'ga4', 'error', e instanceof Error ? e.message : String(e));
		throw e;
	}
}

// ── sync: Tag Manager ────────────────────────────────────────────────────────
/**
 * Stores the container's live version (tags, triggers, variables) as compact summaries, plus the linked GA4 property's
 * measurement IDs so the tracking audit can check the two agree. Cheap: two or three API calls per site.
 */
export async function syncGtm(siteId: number, source?: gtm.GtmSource, ga4Source?: Ga4Source) {
	const links = linksFor(siteId);
	const link = links.gtm;
	if (!link?.account_id) throw new Error('Site is not linked to a Tag Manager container');
	markLink(siteId, 'gtm', 'running');
	try {
		const src = source ?? gtmSourceFor(link.account_id);
		const [container, live] = await Promise.all([src.listContainers().then((cs) => cs.find((c) => c.path === link.external_id)), src.liveVersion(link.external_id)]);
		let measurementIds: string[] = [];
		if (links.ga4?.account_id) {
			// Best effort: the audit simply skips the ID comparison when this is empty.
			measurementIds = await (ga4Source ?? ga4SourceFor(links.ga4.account_id)).measurementIds(links.ga4.external_id).catch(() => []);
		}
		// The live version stored at the previous sync of this same container: a different one now means a publish happened since.
		const before = (db().prepare('SELECT live_version_id v FROM gtm_snapshots WHERE site_id = ? AND container_path = ?').get(siteId, link.external_id) as { v: string | null } | undefined)?.v;
		logGtmVersion(siteId, { path: link.external_id, publicId: container?.publicId ?? null, before, versionId: live?.versionId ?? null, versionName: live?.versionName ?? null });
		db()
			.prepare('INSERT OR REPLACE INTO gtm_snapshots VALUES (?,?,?,?,?,?,?,?,?,?)')
			.run(
				siteId,
				link.external_id,
				container?.publicId ?? null,
				container?.name ?? link.label,
				JSON.stringify(container?.domains ?? []),
				live?.versionId ?? null,
				live?.versionName ?? null,
				JSON.stringify(measurementIds),
				JSON.stringify(live ? { tags: live.tags, triggers: live.triggers, variables: live.variables } : { tags: [], triggers: [], variables: [] }),
				Date.now()
			);
		markLink(siteId, 'gtm', 'idle', null, true);
		return { tags: live?.tags.length ?? 0, published: !!live };
	} catch (e) {
		markLink(siteId, 'gtm', 'error', e instanceof Error ? e.message : String(e));
		throw e;
	}
}

// ── sync: Clarity (10 calls/day/project: today's snapshot is refreshed every 8.5 hours, 9 calls a day) ───────────
export async function syncClarity(siteId: number, o: { force?: boolean; fetchImpl?: typeof fetch } = {}) {
	const link = linksFor(siteId).clarity;
	if (!link?.integration_id) throw new Error('Site is not linked to Clarity');
	const integ = getIntegration(link.integration_id)!;
	const token = integrationSecret<{ token: string }>(integ).token;
	const fetchImpl = o.fetchImpl ?? (integ.is_demo ? demoClarityFetch(link.external_id) : fetch);
	markLink(siteId, 'clarity', 'running');
	try {
		const day = utcDay();
		let calls = 0;
		for (const dim of CLARITY_SYNC_DIMENSIONS) {
			const have = db().prepare('SELECT fetched_at FROM clarity_snapshots WHERE site_id = ? AND day = ? AND dimension = ?').get(siteId, day, dim) as { fetched_at: number } | undefined;
			// fresh enough: skip (the scheduler comes back every 8.5 hours); "refresh now" forces it
			if (have && !o.force && Date.now() - have.fetched_at < CLARITY_FRESH_MS) continue;
			if (callsLeft(integ.id) <= 1) break; // always leave one call for the user
			const payload = await fetchInsights(integ.id, token, { numOfDays: 1, dimension: dim }, fetchImpl);
			db().prepare('INSERT OR REPLACE INTO clarity_snapshots VALUES (?,?,?,?,?)').run(siteId, day, dim, JSON.stringify(payload), Date.now());
			calls++;
		}
		markLink(siteId, 'clarity', 'idle', null, true);
		return { calls };
	} catch (e) {
		markLink(siteId, 'clarity', 'error', e instanceof Error ? e.message : String(e));
		throw e;
	}
}

export const siteName = (id: number) => getSite(id)?.site_url ?? String(id);
export const demoMode = () => config.demo;
