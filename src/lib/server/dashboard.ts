import { db } from './db';
import type { SiteRow } from './clients';
import { addDays } from './dates';
import { breakdown, periodFor, summary, topPages, topQueries } from './queries';
import { linksFor } from './links';
import { ctrOf, pctChange } from '../analytics';
import { PERIODS } from '../periods';
import { keyEventsReport, landingPagesReport, trafficSourcesReport } from './insights';
import type { ClarityMetric } from './clarity';
import type { Ga4Dim } from './ga4';
import { ga4UsersFor } from './traffic';

type Site = Pick<SiteRow, 'id' | 'synced_through' | 'site_url' | 'brand_terms' | 'backfilled_to' | 'backfill_done'>;
type Window = { start: string; end: string; prevStart: string; prevEnd: string };

const win = (end: string, days: number): Window => {
	const start = addDays(end, -(days - 1));
	return { start, end, prevStart: addDays(start, -days), prevEnd: addDays(start, -1) };
};

// ── Search Console ───────────────────────────────────────────────────────────
function searchConsole(site: Site, days: number) {
	const p = periodFor(site, days);
	const now = summary(site.id, p.start, p.end);
	const prev = summary(site.id, p.prevStart, p.prevEnd);
	const seg = (dim: 'country' | 'device') => {
		const before = new Map(breakdown(site.id, p.prevStart, p.prevEnd, dim).map((r) => [r.key, r.clicks]));
		return breakdown(site.id, p.start, p.end, dim)
			.slice(0, 10)
			.map((r) => ({ key: dim === 'country' ? r.key.toUpperCase() : r.key, clicks: r.clicks, impressions: r.impressions, clicksDelta: pctChange(r.clicks, before.get(r.key) ?? 0) }));
	};
	return {
		window: { start: p.start, end: p.end },
		clicks: now.clicks,
		impressions: now.impressions,
		ctr: ctrOf(now),
		position: now.position,
		clicksDelta: pctChange(now.clicks, prev.clicks),
		impressionsDelta: pctChange(now.impressions, prev.impressions),
		countries: seg('country'),
		devices: seg('device'),
		pages: topPages(site.id, p.start, p.end, {}, 10).map((r) => ({ page: r.page, clicks: r.clicks, impressions: r.impressions, position: r.position })),
		queries: topQueries(site.id, p.start, p.end, {}, 10).map((r) => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, position: r.position }))
	};
}

// ── Bing ─────────────────────────────────────────────────────────────────────
function bing(site: Site, days: number) {
	const d = db();
	const end = (d.prepare('SELECT MAX(date) d FROM bing_daily WHERE site_id = ?').get(site.id) as { d: string | null }).d;
	if (!end) return null;
	const w = win(end, days);
	const sum = (s: string, e: string) => d.prepare('SELECT COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions FROM bing_daily WHERE site_id = ? AND date BETWEEN ? AND ?').get(site.id, s, e) as { clicks: number; impressions: number };
	const now = sum(w.start, w.end);
	const prev = sum(w.prevStart, w.prevEnd);
	return { window: { start: w.start, end: w.end }, clicks: now.clicks, impressions: now.impressions, clicksDelta: pctChange(now.clicks, prev.clicks) };
}

// ── GA4 ──────────────────────────────────────────────────────────────────────
function ga4(site: Site, days: number) {
	const d = db();
	// GA4 runs about a day behind real time, Search Console about two: each source is shown for its own newest days, with its dates.
	const end = (d.prepare('SELECT MAX(date) d FROM ga4_daily WHERE site_id = ?').get(site.id) as { d: string | null }).d;
	if (!end) return { synced: false as const };
	const w = win(end, days);
	type T = { sessions: number; engaged: number; keyEvents: number; pageviews: number };
	const tot = (s: string, e: string) => d.prepare('SELECT COALESCE(SUM(sessions),0) sessions, COALESCE(SUM(engaged_sessions),0) engaged, COALESCE(SUM(key_events),0) keyEvents, COALESCE(SUM(pageviews),0) pageviews FROM ga4_daily WHERE site_id = ? AND date BETWEEN ? AND ?').get(site.id, s, e) as T;
	const now = tot(w.start, w.end);
	const prev = tot(w.prevStart, w.prevEnd);
	const group = (sql: string, s: string, e: string) => d.prepare(sql).all(site.id, s, e) as { key: string; sessions: number; engaged: number; keyEvents: number }[];
	const chQ = 'SELECT channel key, SUM(sessions) sessions, SUM(engaged_sessions) engaged, SUM(key_events) keyEvents FROM ga4_daily WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY channel ORDER BY sessions DESC';
	const withDelta = (rows: ReturnType<typeof group>, before: ReturnType<typeof group>) => {
		const b = new Map(before.map((r) => [r.key, r.sessions]));
		return rows.map((r) => ({ key: r.key, sessions: r.sessions, share: now.sessions ? r.sessions / now.sessions : 0, engagementRate: r.sessions ? r.engaged / r.sessions : 0, keyEvents: Math.round(r.keyEvents * 10) / 10, sessionsDelta: pctChange(r.sessions, b.get(r.key) ?? 0) }));
	};
	const dim = (name: Ga4Dim) => {
		const q = 'SELECT value key, SUM(sessions) sessions, SUM(engaged_sessions) engaged, SUM(key_events) keyEvents FROM ga4_dim_daily WHERE site_id = ? AND dim = ? AND date BETWEEN ? AND ? GROUP BY value ORDER BY sessions DESC';
		const rows = d.prepare(q).all(site.id, name, w.start, w.end) as ReturnType<typeof group>;
		const before = d.prepare(q).all(site.id, name, w.prevStart, w.prevEnd) as ReturnType<typeof group>;
		return withDelta(rows, before);
	};
	const hasDims = !!d.prepare('SELECT 1 FROM ga4_dim_daily WHERE site_id = ? LIMIT 1').get(site.id);
	const dimsError = (d.prepare('SELECT ga4_dims_error e FROM sites WHERE id = ?').get(site.id) as { e: string | null }).e;
	const src = (PERIODS as readonly number[]).includes(days) ? trafficSourcesReport(site, days) : null;
	return {
		synced: true as const,
		window: { start: w.start, end: w.end },
		sessions: now.sessions,
		// GA4's unique users over the period (exact, pulled once a day for the preset lengths; null for other lengths)
		users: ga4UsersFor(site.id, days),
		engagementRate: now.sessions ? now.engaged / now.sessions : 0,
		keyEvents: Math.round(now.keyEvents * 10) / 10,
		pageviews: now.pageviews,
		sessionsDelta: pctChange(now.sessions, prev.sessions),
		keyEventsDelta: pctChange(now.keyEvents, prev.keyEvents),
		channels: withDelta(group(chQ, w.start, w.end), group(chQ, w.prevStart, w.prevEnd)),
		breakdowns: hasDims ? { countries: dim('country').slice(0, 10), devices: dim('deviceCategory'), visitors: dim('newVsReturning') } : null,
		breakdownsError: dimsError,
		// Sources are stored for whole windows of the PERIODS lengths only, ending on their own pull date.
		sources: src && src.linked && src.status === 'ok' ? { window: src.window, rows: src.rows.slice(0, 10) } : null,
		// Landing pages from every channel, pulled with the sources (same stored windows).
		landing: (() => {
			if (!(PERIODS as readonly number[]).includes(days)) return null;
			const l = landingPagesReport(site, days);
			return l.linked && l.status === 'ok' ? { window: l.window, rows: l.rows.slice(0, 10) } : null;
		})(),
		keyEventsByName: (() => {
			const k = keyEventsReport(site, days);
			return k.linked ? k : null;
		})()
	};
}

// ── Clarity ──────────────────────────────────────────────────────────────────
const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v));
/** The list Clarity puts under one metric name (e.g. Country), as {name, sessions}. */
function list(metrics: ClarityMetric[], name: string, label = 'name', value = 'sessionsCount') {
	return (metrics.find((m) => m.metricName === name)?.information ?? []).map((r) => ({ name: String((r as Record<string, unknown>)[label] ?? ''), sessions: num((r as Record<string, unknown>)[value]) })).filter((r) => r.name);
}
function pctOf(metrics: ClarityMetric[], name: string) {
	const r = metrics.find((m) => m.metricName === name)?.information?.[0] as Record<string, unknown> | undefined;
	return r && r.sessionsWithMetricPercentage != null ? num(r.sessionsWithMetricPercentage) / 100 : null;
}

function clarity(site: Site) {
	const d = db();
	const r = d.prepare("SELECT day, payload FROM clarity_snapshots WHERE site_id = ? AND dimension = '' ORDER BY day DESC LIMIT 1").get(site.id) as { day: string; payload: string } | undefined;
	if (!r) return { synced: false as const };
	const m = JSON.parse(r.payload) as ClarityMetric[];
	const t = (m.find((x) => x.metricName === 'Traffic')?.information ?? []) as Record<string, unknown>[];
	const sum = (k: string) => t.reduce((a, x) => a + num(x[k]), 0);
	const sessions = sum('totalSessionCount');
	const bots = sum('totalBotSessionCount');
	const eng = m.find((x) => x.metricName === 'EngagementTime')?.information?.[0] as Record<string, unknown> | undefined;
	const scroll = m.find((x) => x.metricName === 'ScrollDepth')?.information?.[0] as Record<string, unknown> | undefined;
	const history = (d.prepare("SELECT day, payload FROM clarity_snapshots WHERE site_id = ? AND dimension = '' ORDER BY day DESC LIMIT 14").all(site.id) as { day: string; payload: string }[])
		.map((h) => {
			const tr = ((JSON.parse(h.payload) as ClarityMetric[]).find((x) => x.metricName === 'Traffic')?.information ?? []) as Record<string, unknown>[];
			const s = tr.reduce((a, x) => a + num(x.totalSessionCount), 0);
			const b = tr.reduce((a, x) => a + num(x.totalBotSessionCount), 0);
			return { day: h.day, sessions: s, humans: Math.max(0, s - b) };
		})
		.reverse();
	return {
		synced: true as const,
		day: r.day,
		sessions,
		bots,
		humans: Math.max(0, sessions - bots),
		// Clarity's live API calls this distinctUserCount; earlier documentation and the demo spell it distantUserCount.
		users: sum('distinctUserCount') || sum('distantUserCount'),
		deadClicks: pctOf(m, 'DeadClickCount'),
		rageClicks: pctOf(m, 'RageClickCount'),
		quickBacks: pctOf(m, 'QuickbackClick'),
		scriptErrors: pctOf(m, 'ScriptErrorCount'),
		scrollDepth: scroll?.averageScrollDepth != null ? num(scroll.averageScrollDepth) / 100 : null,
		activeTime: eng?.activeTime != null ? num(eng.activeTime) : null,
		totalTime: eng?.totalTime != null ? num(eng.totalTime) : null,
		countries: list(m, 'Country').slice(0, 10),
		devices: list(m, 'Device'),
		browsers: list(m, 'Browser').slice(0, 6),
		referrers: list(m, 'ReferrerUrl').slice(0, 10),
		pages: list(m, 'PopularPages', 'url', 'visitsCount').slice(0, 10),
		history
	};
}

/** Search Console, Bing, GA4 and Clarity for one site on one screen. Each source keeps its own dates; nothing is mixed across sources. */
export function dashboardFor(site: Site, days: number) {
	const links = linksFor(site.id);
	return {
		gsc: searchConsole(site, days),
		bing: links.bing ? bing(site, days) : null,
		ga4: links.ga4 ? ga4(site, days) : null,
		clarity: links.clarity ? clarity(site) : null,
		linked: { bing: !!links.bing, ga4: !!links.ga4, clarity: !!links.clarity }
	};
}
