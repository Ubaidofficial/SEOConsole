/**
 * MCP tools for alerts, rank tracking, keyword buckets and page groups, Google update impact and not-found pages. Reads answer from
 * stored data; the two writes (track_queries, close_alert) change only this app's own lists.
 */
import { getSite } from './clients';
import { days, daysArg, limit, r2, resolveSite, siteArg, type Tool } from './mcp-core';
import { closeAlerts, listAlerts, listRules, scopeText } from './alerts';
import { rankReport, trackQueries, untrackQueries } from './ranktrack';
import { groupsReportFor } from './groups';
import { updateImpacts, VERDICT_TEXT } from './updateimpact';
import { notFoundPages } from './notfound';
import { alertKind, ruleText } from '../alerts';

const pct = (x: number | null) => (x == null ? null : r2(x * 100) + '%');

export const MORE_READ_TOOLS: Tool[] = [
	{
		name: 'get_alerts',
		description: 'Alerts raised by each site\'s alert rules (traffic or position falling, top-10 searches lost, pages leaving the index, good news). status: open (default), closed, all. rules=true with a site adds its rules.',
		schema: { site: { type: 'string' }, status: { type: 'string', enum: ['open', 'closed', 'all'] }, rules: { type: 'boolean' }, limit: { type: 'integer' } },
		run: (a, sites) => {
			const one = a.site ? resolveSite(sites, a.site) : null;
			const status = a.status === 'closed' || a.status === 'all' ? a.status : 'open';
			const alerts = listAlerts({ siteIds: sites.map((s) => s.id), siteId: one?.id, status, limit: limit(a, 50) }).map((x) => ({ id: x.id, site: x.site, siteId: x.siteId, title: x.title, detail: x.detail, goodNews: x.positive || undefined, status: x.status, stillTrue: x.active, opened: new Date(x.openedAt).toISOString() }));
			if (!one || a.rules !== true) return { alerts };
			return { alerts, rules: listRules(one.id).map((r) => ({ kind: r.kind, on: r.enabled, builtin: r.builtin, rule: ruleText(alertKind(r.kind)!, r.threshold), windowDays: r.windowDays, scope: scopeText(one.id, r) })) };
		}
	},
	{
		name: 'get_rank_tracking',
		description: 'Tracked searches\' daily Google position from Search Console data (all countries and devices): latest, last 7 days vs the 7 before (+ = up), best, clicks, days in the top 10.',
		schema: { ...siteArg, ...daysArg, limit: { type: 'integer' } },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			const r = rankReport(getSite(site.id)!, days(a));
			return { period: { start: r.start, end: r.end }, tracked: r.rows.filter((x) => x.manual).length, fromBuckets: r.rows.filter((x) => !x.manual).length, rows: r.rows.slice(0, limit(a, 100)).map((x) => ({ query: x.query, bucket: x.buckets.length ? x.buckets : undefined, latest: x.latest && { date: x.latest.date, position: r2(x.latest.position) }, last7: x.week == null ? null : r2(x.week), prev7: x.prevWeek == null ? null : r2(x.prevWeek), change: x.change == null ? null : r2(x.change), best: x.best == null ? null : r2(x.best), clicks: x.clicks, daysTop10: x.daysTop10, daysShown: x.daysShown })) };
		}
	},
	{
		name: 'get_keyword_buckets',
		description: 'Keyword buckets (kind=bucket) or page groups (kind=pages) defined by the team\'s rules: clicks, impressions, position, change vs the previous window.',
		schema: { ...siteArg, ...daysArg, kind: { type: 'string', enum: ['bucket', 'pages'] } },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			const r = groupsReportFor(getSite(site.id)!, a.kind === 'pages' ? 'pages' : 'bucket', days(a));
			return { comparable: r.comparable, rows: r.rows.map((x) => ({ id: x.id, name: x.name, rules: x.summary || undefined, members: x.members, clicks: x.clicks, impressions: x.impressions, position: x.position == null ? null : r2(x.position), change: pct(x.deltaPct), top: x.top })) };
		}
	},
	{
		name: 'get_update_impact',
		description: 'Per Google update: clicks/day 28 days after it ended vs 28 before it began, the trend before, last year, and a verdict (likely helped/hurt, no clear effect). Timing, not proof.',
		schema: { ...siteArg, limit: { type: 'integer' } },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			return updateImpacts(getSite(site.id)!).slice(0, limit(a, 12)).map((u) => ({ update: u.name, begin: u.begin, end: u.end, beforePerDay: u.beforePerDay == null ? null : r2(u.beforePerDay), afterPerDay: u.afterPerDay == null ? null : r2(u.afterPerDay), change: pct(u.change), trendBefore: pct(u.trendBefore), lastYear: pct(u.lastYear), verdict: VERDICT_TEXT[u.verdict], why: u.why }));
		}
	},
	{
		name: 'get_not_found_pages',
		description: 'Not-found addresses visitors reach (GA4 title reads like a 404): views, AI-assistant sessions, known to Google or a sitemap. likelyInvented: an AI sends visits and neither knows it. Needs GA4.',
		schema: { ...siteArg, limit: { type: 'integer' } },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			const r = notFoundPages(getSite(site.id)!, 28);
			if (!r.ga4) return { note: 'GA4 is not linked or has no page titles yet.' };
			return r.rows.slice(0, limit(a, 50)).map((x) => ({ path: x.path, title: x.title, views: x.views, aiSessions: x.ai, assistants: x.assistants, inSearch: x.inSearch, inSitemap: x.inSitemap, likelyInvented: x.likelyInvented }));
		}
	}
];

export const MORE_WRITE_TOOLS: Tool[] = [
	{
		write: true,
		name: 'track_queries',
		description: 'Add searches to rank tracking (up to 100 at a time, 500 per site) or untrack them. Only this app\'s list.',
		schema: { ...siteArg, add: { type: 'array', items: { type: 'string' } }, untrack: { type: 'array', items: { type: 'string' } } },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			const add = Array.isArray(a.add) ? a.add.map(String) : [];
			const drop = Array.isArray(a.untrack) ? a.untrack.map(String) : [];
			if (!add.length && !drop.length) throw new Error('Give `add` or `untrack`.');
			const r = add.length ? trackQueries(site.id, add) : { added: 0, already: 0 };
			if (r.error) throw new Error(r.error);
			return { ok: true, added: r.added, alreadyTracked: r.already, untracked: drop.length ? untrackQueries(site.id, drop) : 0 };
		}
	},
	{
		write: true,
		name: 'close_alert',
		description: 'Close open alerts from get_alerts as resolved or dismissed. The rule stays quiet until its condition ends and recurs.',
		schema: { ids: { type: 'array', items: { type: 'integer' } }, status: { type: 'string', enum: ['resolved', 'dismissed'] } },
		run: (a, sites, ctx) => {
			const ids = (Array.isArray(a.ids) ? a.ids : [a.ids]).map(Number).filter((n) => n > 0).slice(0, 100);
			if (!ids.length) throw new Error('Give the alert `ids` from get_alerts.');
			const n = closeAlerts(ids, a.status === 'dismissed' ? 'dismissed' : 'resolved', `agent: ${ctx.keyName}`, sites.map((s) => s.id));
			return { ok: true, closed: n };
		}
	}
];
