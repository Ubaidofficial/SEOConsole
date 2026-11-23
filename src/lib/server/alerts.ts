import { db, audit } from './db';
import { config } from './config';
import { displayName, getSite, type SiteRow } from './clients';
import { historyCoversPrevious, periodFor, summary, topPages, topQueries, allSites } from './queries';
import { postWebhook, webhook, type WebhookFormat } from './digest';
import { matcherFor } from './groups';
import { listTracked, rankSeries } from './ranktrack';
import { addDays } from './dates';
import { ALERT_KINDS, ALERT_WINDOWS, MAX_CUSTOM_ALERTS, SCOPE_LABEL, alertKind, clampThreshold, countChangeReal, pctOf, ruleText, type AlertKind, type ScopeKind } from '../alerts';
import { pagePath } from '../rules';
import { safeRegex } from '../trends';
import { chatSafe } from '../digest';

/**
 * Alerts from rules. Each site has the built-in rules (one per kind, created on first use, thresholds editable, each can be switched
 * off) plus up to MAX_CUSTOM_ALERTS custom ones. A rule's alert opens when its condition starts to hold and is announced once (to the
 * site's own webhook, else DIGEST_WEBHOOK_URL). While the condition holds the same alert is updated, not repeated; when it stops the
 * alert ends by itself ("cleared"). Resolving or dismissing an alert closes it in the list, and the rule stays quiet until the
 * condition has ended and starts again. Checked hourly against stored data (new data arrives with each sync, every few hours).
 */

export interface AlertRule {
	id: number;
	siteId: number;
	kind: AlertKind;
	builtin: boolean;
	name: string | null;
	threshold: number;
	windowDays: number;
	scopeKind: ScopeKind | null;
	scopeValue: string | null;
	enabled: boolean;
}

type RuleRow = { id: number; site_id: number; kind: AlertKind; builtin: number; name: string | null; threshold: number; window_days: number; scope_kind: ScopeKind | null; scope_value: string | null; enabled: number };
const toRule = (r: RuleRow): AlertRule => ({ id: r.id, siteId: r.site_id, kind: r.kind, builtin: !!r.builtin, name: r.name, threshold: r.threshold, windowDays: r.window_days, scopeKind: r.scope_kind, scopeValue: r.scope_value, enabled: !!r.enabled });

/** The built-in rules exist for every site from the start; this creates any that are missing (a new site, or a kind added later). */
export function ensureBuiltinRules(siteId: number) {
	const ins = db().prepare('INSERT OR IGNORE INTO alert_rules (site_id, kind, builtin, threshold, window_days, enabled, created_at) VALUES (?,?,1,?,?,?,?)');
	for (const k of ALERT_KINDS) ins.run(siteId, k.kind, k.threshold, k.window, k.builtinOn ? 1 : 0, Date.now());
}

export function listRules(siteId: number): AlertRule[] {
	ensureBuiltinRules(siteId);
	const order = new Map(ALERT_KINDS.map((k, i) => [k.kind, i]));
	return (db().prepare('SELECT * FROM alert_rules WHERE site_id = ? ORDER BY builtin DESC, id').all(siteId) as RuleRow[])
		.filter((r) => alertKind(r.kind))
		.map(toRule)
		.sort((a, b) => Number(b.builtin) - Number(a.builtin) || (a.builtin ? order.get(a.kind)! - order.get(b.kind)! : a.id - b.id));
}

/** One line naming what a rule watches, for lists and messages. */
export function scopeText(siteId: number, r: Pick<AlertRule, 'scopeKind' | 'scopeValue'>): string {
	if (!r.scopeKind || !r.scopeValue) return 'Whole site';
	if (r.scopeKind === 'bucket' || r.scopeKind === 'pages') {
		const g = db().prepare('SELECT name FROM rule_groups WHERE id = ? AND site_id = ?').get(Number(r.scopeValue), siteId) as { name: string } | undefined;
		return `${SCOPE_LABEL[r.scopeKind]}: ${g?.name ?? '(removed)'}`;
	}
	return `${SCOPE_LABEL[r.scopeKind]} ${r.scopeValue}`;
}

/** Change a rule's threshold, window or on/off. Built-in rules keep their kind and scope. */
export function updateRule(siteId: number, id: number, o: { threshold?: number; windowDays?: number; enabled?: boolean }): { ok: true } | { error: string } {
	const r = db().prepare('SELECT * FROM alert_rules WHERE id = ? AND site_id = ?').get(id, siteId) as RuleRow | undefined;
	const k = r && alertKind(r.kind);
	if (!r || !k) return { error: 'That rule no longer exists.' };
	const t = o.threshold === undefined ? r.threshold : clampThreshold(k, o.threshold);
	if (t === null) return { error: `That threshold is outside what this rule accepts.` };
	const w = o.windowDays === undefined ? r.window_days : (ALERT_WINDOWS as readonly number[]).includes(o.windowDays) ? o.windowDays : null;
	if (w === null) return { error: `The window is ${ALERT_WINDOWS.join(', ')} days.` };
	const enabled = o.enabled === undefined ? r.enabled : o.enabled ? 1 : 0;
	db().prepare('UPDATE alert_rules SET threshold = ?, window_days = ?, enabled = ? WHERE id = ?').run(t, w, enabled, id);
	// A rule switched off or changed starts afresh: its active alert ends, so the new setting is judged on its own.
	if (!enabled || t !== r.threshold || w !== r.window_days) endActive(id, 'cleared');
	return { ok: true };
}

export function addCustomRule(siteId: number, o: { kind: string; threshold: number; windowDays: number; scopeKind: string | null; scopeValue: string | null; name?: string | null }): { id: number } | { error: string } {
	const k = alertKind(o.kind);
	if (!k) return { error: 'Pick what the alert watches.' };
	const n = (db().prepare('SELECT COUNT(*) n FROM alert_rules WHERE site_id = ? AND builtin = 0').get(siteId) as { n: number }).n;
	if (n >= MAX_CUSTOM_ALERTS) return { error: `Up to ${MAX_CUSTOM_ALERTS} custom alerts per site.` };
	const t = clampThreshold(k, o.threshold);
	if (t === null) return { error: 'That threshold is outside what this rule accepts.' };
	if (!(ALERT_WINDOWS as readonly number[]).includes(o.windowDays)) return { error: `The window is ${ALERT_WINDOWS.join(', ')} days.` };
	let scopeKind: ScopeKind | null = null;
	let scopeValue: string | null = null;
	if (o.scopeKind && o.scopeKind !== 'site') {
		if (!k.scopable) return { error: `“${k.label}” watches the whole site and cannot be limited to part of it.` };
		if (!['page', 'query', 'bucket', 'pages'].includes(o.scopeKind)) return { error: 'Unknown scope.' };
		scopeKind = o.scopeKind as ScopeKind;
		scopeValue = (o.scopeValue ?? '').trim().slice(0, 300);
		if (!scopeValue) return { error: 'Say which part of the site to watch.' };
		if (scopeKind === 'page' && !scopeValue.startsWith('/')) return { error: 'A URL path starts with “/”, for example /blog/.' };
		if (scopeKind === 'query') {
			const s = safeRegex(scopeValue);
			if ('error' in s) return { error: s.error };
		}
		if ((scopeKind === 'bucket' || scopeKind === 'pages') && !db().prepare('SELECT 1 FROM rule_groups WHERE id = ? AND site_id = ? AND kind = ?').get(Number(scopeValue), siteId, scopeKind)) return { error: 'That bucket or group no longer exists.' };
	}
	const id = Number(db().prepare('INSERT INTO alert_rules (site_id, kind, builtin, name, threshold, window_days, scope_kind, scope_value, enabled, created_at) VALUES (?,?,0,?,?,?,?,?,1,?)').run(siteId, k.kind, o.name?.trim().slice(0, 80) || null, t, o.windowDays, scopeKind, scopeValue, Date.now()).lastInsertRowid);
	audit('alert rule added', { siteId, detail: k.kind });
	return { id };
}

export function deleteCustomRule(siteId: number, id: number): boolean {
	endActive(id, 'cleared');
	return db().prepare('DELETE FROM alert_rules WHERE id = ? AND site_id = ? AND builtin = 0').run(id, siteId).changes > 0;
}

function endActive(ruleId: number, status: 'cleared') {
	const now = Date.now();
	db().prepare("UPDATE alert_events SET active = 0, status = CASE WHEN status = 'open' THEN ? ELSE status END, closed_at = COALESCE(closed_at, ?) WHERE rule_id = ? AND active = 1").run(status, now, ruleId);
}

// ── evaluation ───────────────────────────────────────────────────────────────
interface M { clicks: number; impressions: number; position: number }
type Item = { key: string; clicks: number; impressions: number; position: number };
export interface Verdict { fire: boolean; title: string; detail: string; skip?: string }

/** Per-run cache: the same site and window are read once however many rules look at them. */
class Reader {
	private q = new Map<string, Item[]>();
	private p = new Map<string, Item[]>();
	constructor(readonly site: SiteRow) {}
	queries(start: string, end: string): Item[] {
		const k = `${start}|${end}`;
		if (!this.q.has(k)) this.q.set(k, topQueries(this.site.id, start, end, {}, 50_000).map((r) => ({ key: r.query, clicks: r.clicks, impressions: r.impressions, position: r.position })));
		return this.q.get(k)!;
	}
	pages(start: string, end: string): Item[] {
		const k = `${start}|${end}`;
		if (!this.p.has(k)) this.p.set(k, topPages(this.site.id, start, end, {}, 50_000).map((r) => ({ key: r.page, clicks: r.clicks, impressions: r.impressions, position: r.position })));
		return this.p.get(k)!;
	}
}

const sum = (xs: Item[]): M => {
	let c = 0, i = 0, pw = 0;
	for (const x of xs) (c += x.clicks, i += x.impressions, pw += x.position * x.impressions);
	return { clicks: c, impressions: i, position: i ? pw / i : 0 };
};

/** The items (searches or pages) a rule looks at, already narrowed to its scope; `dim` says which. */
function scoped(rd: Reader, r: AlertRule, start: string, end: string, prefer: 'query' | 'page'): { dim: 'query' | 'page'; items: Item[] } | null {
	const s = r.scopeKind;
	if (s === 'page' || s === 'pages') {
		const test = s === 'page' ? (u: string) => pagePath(u).toLowerCase().startsWith(r.scopeValue!.toLowerCase()) : matcherFor(rd.site.id, 'pages', Number(r.scopeValue));
		if (!test) return null;
		return { dim: 'page', items: rd.pages(start, end).filter((x) => test(x.key)) };
	}
	if (s === 'query' || s === 'bucket') {
		let test: ((q: string) => boolean) | null;
		if (s === 'query') {
			const re = safeRegex(r.scopeValue ?? '');
			test = 're' in re ? (q: string) => re.re.test(q) : null;
		} else test = matcherFor(rd.site.id, 'bucket', Number(r.scopeValue));
		if (!test) return null;
		return { dim: 'query', items: rd.queries(start, end).filter((x) => test(x.key)) };
	}
	return { dim: prefer, items: prefer === 'query' ? rd.queries(start, end) : rd.pages(start, end) };
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const short = (u: string) => (u.length > 70 ? u.slice(0, 67) + '…' : u);
const list = (xs: string[], dim: 'query' | 'page') => xs.map((x) => (dim === 'page' ? short(pagePath(x)) : `“${short(x)}”`)).join(', ');

export function evaluateRule(rd: Reader, r: AlertRule, nowMs = Date.now()): Verdict {
	const k = alertKind(r.kind)!;
	const site = rd.site;
	const p = periodFor(site, r.windowDays);
	const span = `${r.windowDays} days to ${p.end}`;
	const title = k.label + (r.scopeKind ? ` · ${scopeText(site.id, r)}` : '');
	const no = (skip?: string): Verdict => ({ fire: false, title, detail: '', skip });
	if (!site.synced_through) return no('no data yet');

	if (r.kind === 'deindexed') {
		const since = nowMs - r.windowDays * 86_400_000;
		const urls = db().prepare("SELECT url FROM index_events WHERE site_id = ? AND kind = 'deindexed' AND at >= ? ORDER BY at DESC").all(site.id, since) as { url: string }[];
		const uniq = [...new Set(urls.map((u) => u.url))];
		return uniq.length >= r.threshold ? { fire: true, title, detail: `${uniq.length} page${uniq.length === 1 ? '' : 's'} dropped out of Google’s index in the last ${r.windowDays} days: ${list(uniq.slice(0, 3), 'page')}${uniq.length > 3 ? '…' : ''}` } : no();
	}

	if (r.kind === 'tracked_drop') {
		const qs = listTracked(site.id).map((t) => t.query);
		if (!qs.length) return no('no tracked searches');
		const end = p.end;
		const s = rankSeries(site.id, qs, addDays(end, -(2 * r.windowDays - 1)), end);
		const fell: string[] = [];
		for (const [q, days] of s) {
			const avg = (xs: typeof days) => { let i = 0, pw = 0; for (const x of xs) if (x.position != null) (i += x.impressions, pw += x.position * x.impressions); return i ? pw / i : null; };
			const now = avg(days.slice(-r.windowDays));
			const before = avg(days.slice(0, -r.windowDays));
			if (before == null) continue;
			if ((now == null && before <= 10.5) || (now != null && (now - before >= r.threshold || (before <= 10.5 && now > 10.5)))) fell.push(`“${short(q)}” ${before.toFixed(1)} → ${now == null ? 'not shown' : now.toFixed(1)}`);
		}
		return fell.length ? { fire: true, title, detail: `${fell.length} tracked search${fell.length === 1 ? '' : 'es'} fell over the ${span}: ${fell.slice(0, 4).join('; ')}${fell.length > 4 ? '…' : ''}` } : no();
	}

	if (!historyCoversPrevious(site, p.prevStart)) return no('previous period not downloaded yet');

	if (r.kind === 'top10_lost' || r.kind === 'top3_new' || r.kind === 'pages_drop') {
		const prefer = r.kind === 'pages_drop' ? 'page' : 'query';
		const cur = scoped(rd, r, p.start, p.end, prefer);
		const prev = scoped(rd, r, p.prevStart, p.prevEnd, prefer);
		if (!cur || !prev) return no('its bucket or group was removed');
		const nowBy = new Map(cur.items.map((x) => [x.key, x]));
		const what = cur.dim === 'query' ? 'search' : 'page';
		let hits: Item[] = [];
		if (r.kind === 'top10_lost') hits = prev.items.filter((x) => x.impressions >= 10 && x.position <= 10.5 && !((nowBy.get(x.key)?.impressions ?? 0) > 0 && nowBy.get(x.key)!.position <= 10.5));
		if (r.kind === 'top3_new') {
			const before = new Map(prev.items.map((x) => [x.key, x]));
			hits = cur.items.filter((x) => x.impressions >= 10 && x.position <= 3.5 && !((before.get(x.key)?.impressions ?? 0) > 0 && before.get(x.key)!.position <= 3.5));
		}
		if (r.kind === 'pages_drop') hits = prev.items.filter((x) => x.clicks >= 10 && (nowBy.get(x.key)?.clicks ?? 0) <= x.clicks / 2);
		if (hits.length < r.threshold) return no();
		hits.sort((a, b) => (r.kind === 'pages_drop' ? b.clicks - a.clicks : b.impressions - a.impressions));
		const verb = r.kind === 'top10_lost' ? 'left the top 10' : r.kind === 'top3_new' ? 'reached the top 3' : 'lost half their clicks or more';
		return { fire: true, title, detail: `${hits.length} ${what}${hits.length === 1 ? '' : r.kind === 'pages_drop' ? 's' : what === 'search' ? 'es' : 's'} ${verb} over the ${span}: ${list(hits.slice(0, 3).map((h) => h.key), cur.dim)}${hits.length > 3 ? '…' : ''}` };
	}

	// totals: the whole site from the accurate daily totals, a scope from its searches or pages
	let now: M, prev: M;
	if (!r.scopeKind) {
		now = summary(site.id, p.start, p.end);
		prev = summary(site.id, p.prevStart, p.prevEnd);
	} else {
		const a = scoped(rd, r, p.start, p.end, 'query');
		const b = scoped(rd, r, p.prevStart, p.prevEnd, 'query');
		if (!a || !b) return no('its bucket or group was removed');
		now = sum(a.items);
		prev = sum(b.items);
	}
	switch (r.kind) {
		case 'clicks_drop':
		case 'clicks_rise': {
			const pct = pctOf(now.clicks, prev.clicks, 20);
			if (pct == null || !countChangeReal(now.clicks, prev.clicks)) return no();
			const fire = r.kind === 'clicks_drop' ? pct <= -r.threshold : pct >= r.threshold;
			return fire ? { fire, title, detail: `Clicks over the ${span}: ${fmt(now.clicks)}, ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(0)}% from ${fmt(prev.clicks)} the ${r.windowDays} days before.` } : no();
		}
		case 'impressions_drop': {
			const pct = pctOf(now.impressions, prev.impressions, 500);
			if (pct == null || !countChangeReal(now.impressions, prev.impressions, 50)) return no();
			return pct <= -r.threshold ? { fire: true, title, detail: `Impressions over the ${span}: ${fmt(now.impressions)}, down ${Math.abs(pct).toFixed(0)}% from ${fmt(prev.impressions)}.` } : no();
		}
		case 'position_drop': {
			if (now.impressions < 100 || prev.impressions < 100) return no();
			const worse = now.position - prev.position;
			return worse >= r.threshold ? { fire: true, title, detail: `Average position over the ${span}: ${now.position.toFixed(1)}, from ${prev.position.toFixed(1)} (${worse.toFixed(1)} places worse).` } : no();
		}
		case 'ctr_drop': {
			if (now.impressions < 500 || prev.impressions < 500) return no();
			const a = now.clicks / now.impressions, b = prev.clicks / prev.impressions;
			const pp = (b - a) * 100;
			return pp >= r.threshold && countChangeReal(now.clicks, (prev.clicks / prev.impressions) * now.impressions) ? { fire: true, title, detail: `Click-through rate over the ${span}: ${(a * 100).toFixed(1)}%, from ${(b * 100).toFixed(1)}% (${pp.toFixed(1)} points lower).` } : no();
		}
	}
	return no();
}

/** Open, update or end the alert of one rule from its verdict. Returns the id of a newly opened alert. */
function applyVerdict(siteId: number, r: AlertRule, v: Verdict, now: number): number | null {
	const d = db();
	if (v.skip) return null; // nothing to judge (no data, history still downloading): leave things as they are
	const active = d.prepare('SELECT id FROM alert_events WHERE rule_id = ? AND active = 1').get(r.id) as { id: number } | undefined;
	if (v.fire) {
		if (active) {
			d.prepare('UPDATE alert_events SET title = ?, detail = ?, updated_at = ? WHERE id = ?').run(v.title, v.detail, now, active.id);
			return null;
		}
		return Number(d.prepare('INSERT INTO alert_events (site_id, rule_id, kind, positive, title, detail, opened_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(siteId, r.id, r.kind, alertKind(r.kind)!.positive ? 1 : 0, v.title, v.detail, now, now).lastInsertRowid);
	}
	if (active) endActive(r.id, 'cleared');
	return null;
}

const visibleSites = () => allSites().filter((s) => !['siteUnverifiedUser', 'none'].includes(s.permission));

/** Check every rule of every site (or of one site), then announce the alerts that just opened. */
export async function runAlertRules(o: { siteIds?: number[]; fetchImpl?: typeof fetch; now?: number } = {}): Promise<{ opened: number; checked: number; delivered: number }> {
	const now = o.now ?? Date.now();
	let opened = 0, checked = 0;
	const sites = o.siteIds ? o.siteIds.map((id) => getSite(id)).filter((s): s is SiteRow => !!s) : visibleSites();
	for (const site of sites) {
		const rd = new Reader(site);
		for (const r of listRules(site.id).filter((x) => x.enabled)) {
			try {
				checked++;
				if (applyVerdict(site.id, r, evaluateRule(rd, r, now), now)) opened++;
			} catch {
				/* one broken rule (a removed group, a bad pattern) must not stop the others */
			}
		}
	}
	const delivered = await deliverPending(o.fetchImpl, now);
	return { opened, checked, delivered };
}

// ── delivery ─────────────────────────────────────────────────────────────────
const SLACK_HOSTS = ['hooks.slack.com'];
const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'];

/**
 * A site's own alert webhook, checked: only Slack's and Discord's webhook addresses are accepted, so the form cannot point the server
 * at an arbitrary address (an internal service, a cloud metadata URL). Anything else keeps using DIGEST_WEBHOOK_URL from .env.
 */
export function siteWebhook(raw: string | null | undefined): { url: string; format: WebhookFormat } | { error: string } | null {
	const s = (raw ?? '').trim();
	if (!s) return null;
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		return { error: 'That is not a web address.' };
	}
	if (u.protocol !== 'https:' || u.port || u.username || u.password) return { error: 'Use the https address Slack or Discord gave you.' };
	if (SLACK_HOSTS.includes(u.hostname) && u.pathname.startsWith('/services/')) return { url: u.toString(), format: 'slack' };
	if (DISCORD_HOSTS.includes(u.hostname) && u.pathname.startsWith('/api/webhooks/')) return { url: u.toString(), format: 'discord' };
	return { error: 'Only Slack (hooks.slack.com/services/…) and Discord (discord.com/api/webhooks/…) webhooks can be set here. Any other address goes in DIGEST_WEBHOOK_URL.' };
}

export function setSiteWebhook(siteId: number, raw: string): { ok: true } | { error: string } {
	const w = siteWebhook(raw);
	if (w && 'error' in w) return w;
	db().prepare('UPDATE sites SET alert_webhook = ? WHERE id = ?').run(w ? w.url : null, siteId);
	audit(w ? 'alert webhook set' : 'alert webhook removed', { siteId, detail: w ? new URL(w.url).hostname : undefined });
	return { ok: true };
}

/** The address of a stored webhook with its secret part hidden, for the settings form. */
export const maskedWebhook = (url: string | null) => {
	if (!url) return null;
	try {
		const u = new URL(url);
		return `${u.hostname}${u.pathname.split('/').slice(0, 3).join('/')}/…`;
	} catch {
		return null;
	}
};

export function renderAlerts(items: { site: string; title: string; detail: string; positive: boolean; siteId: number }[], base = ''): string {
	const lines = items.map((a) => `${a.positive ? '▲' : '▼'} ${chatSafe(a.site)} · ${chatSafe(a.title)}: ${chatSafe(a.detail)}${base ? ` ${base}/sites/${a.siteId}/alerts` : ''}`);
	return [`SEOConsole alerts (${items.length})`, ...lines].join('\n');
}

/** Send every alert that opened and has not been announced (or whose announcement failed in the last day), grouped by webhook. */
async function deliverPending(fetchImpl: typeof fetch | undefined, now: number): Promise<number> {
	const d = db();
	const rows = d.prepare("SELECT e.id, e.site_id siteId, e.title, e.detail, e.positive, s.site_url, s.label, s.alert_webhook FROM alert_events e JOIN sites s ON s.id = e.site_id WHERE e.status = 'open' AND (e.delivery = 'none' OR (e.delivery = 'failed' AND e.opened_at > ?)) AND e.opened_at > ? ORDER BY e.opened_at").all(now - 86_400_000, now - 3 * 86_400_000) as { id: number; siteId: number; title: string; detail: string | null; positive: number; site_url: string; label: string | null; alert_webhook: string | null }[];
	const groups = new Map<string, { target: { url: string; format: WebhookFormat } | undefined; rows: typeof rows }>();
	const global = webhook();
	for (const r of rows) {
		const own = siteWebhook(r.alert_webhook);
		const target = own && !('error' in own) ? own : global.url ? undefined : null;
		if (target === null) continue; // nowhere to send: it stays in the app's list
		const key = target ? target.url : 'global';
		if (!groups.has(key)) groups.set(key, { target, rows: [] });
		groups.get(key)!.rows.push(r);
	}
	let delivered = 0;
	const mark = d.prepare('UPDATE alert_events SET delivery = ?, delivery_message = ? WHERE id = ?');
	for (const g of groups.values()) {
		// Discord cuts a message at 2,000 characters: send in batches of a few
		const size = (g.target?.format ?? global.format) === 'discord' ? 4 : 15;
		for (let i = 0; i < g.rows.length; i += size) {
			const batch = g.rows.slice(i, i + size);
			const text = renderAlerts(batch.map((b) => ({ site: b.label || displayName(b.site_url), title: b.title, detail: b.detail ?? '', positive: !!b.positive, siteId: b.siteId })), config.origin);
			const res = await postWebhook(text, { alerts: batch.map((b) => ({ id: b.id, siteId: b.siteId, title: b.title, detail: b.detail, positive: !!b.positive })) }, fetchImpl, g.target);
			for (const b of batch) mark.run(res.ok ? 'sent' : 'failed', res.message, b.id);
			if (res.ok) delivered += batch.length;
		}
	}
	return delivered;
}

// ── the list ─────────────────────────────────────────────────────────────────
export interface AlertEvent { id: number; siteId: number; site: string; kind: AlertKind; positive: boolean; title: string; detail: string | null; openedAt: number; updatedAt: number; active: boolean; status: 'open' | 'resolved' | 'dismissed' | 'cleared'; closedAt: number | null; closedBy: string | null; delivery: string; deliveryMessage: string | null }

export function listAlerts(o: { siteIds: number[] | null; status?: 'open' | 'closed' | 'all'; siteId?: number; limit?: number }): AlertEvent[] {
	const where: string[] = [];
	const args: (string | number)[] = [];
	if (o.siteId) (where.push('e.site_id = ?'), args.push(o.siteId));
	if (o.siteIds) where.push(`e.site_id IN (${o.siteIds.map(Number).join(',') || '0'})`);
	if (o.status === 'open') where.push("e.status = 'open'");
	if (o.status === 'closed') where.push("e.status != 'open'");
	const rows = db().prepare(`SELECT e.*, s.site_url, s.label FROM alert_events e JOIN sites s ON s.id = e.site_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (e.status = 'open') DESC, e.positive, e.opened_at DESC LIMIT ?`).all(...args, o.limit ?? 300) as { id: number; site_id: number; site_url: string; label: string | null; kind: AlertKind; positive: number; title: string; detail: string | null; opened_at: number; updated_at: number; active: number; status: AlertEvent['status']; closed_at: number | null; closed_by: string | null; delivery: string; delivery_message: string | null }[];
	return rows.map((r) => ({ id: r.id, siteId: r.site_id, site: r.label || displayName(r.site_url), kind: r.kind, positive: !!r.positive, title: r.title, detail: r.detail, openedAt: r.opened_at, updatedAt: r.updated_at, active: !!r.active, status: r.status, closedAt: r.closed_at, closedBy: r.closed_by, delivery: r.delivery, deliveryMessage: r.delivery_message }));
}

export const openAlertCount = (siteIds: number[] | null): { open: number; problems: number } => {
	const scope = siteIds ? ` AND site_id IN (${siteIds.map(Number).join(',') || '0'})` : '';
	const r = db().prepare(`SELECT COUNT(*) open, SUM(positive = 0) problems FROM alert_events WHERE status = 'open'${scope}`).get() as { open: number; problems: number | null };
	return { open: r.open, problems: r.problems ?? 0 };
};

/** Resolve (dealt with) or dismiss (not relevant) open alerts. The rule stays quiet until its condition has ended and starts again. */
export function closeAlerts(ids: number[], status: 'resolved' | 'dismissed', by: string, siteIds: number[] | null): number {
	const d = db();
	const upd = d.prepare("UPDATE alert_events SET status = ?, closed_at = ?, closed_by = ? WHERE id = ? AND status = 'open'");
	let n = 0;
	d.transaction(() => {
		for (const id of ids) {
			const row = d.prepare('SELECT site_id FROM alert_events WHERE id = ?').get(id) as { site_id: number } | undefined;
			if (!row || (siteIds && !siteIds.includes(row.site_id))) continue;
			n += upd.run(status, Date.now(), by, id).changes;
		}
	})();
	return n;
}

/** Put a closed alert back on the open list (a resolve or dismiss by mistake). */
export function reopenAlert(id: number, siteIds: number[] | null): boolean {
	const row = db().prepare('SELECT site_id, active FROM alert_events WHERE id = ?').get(id) as { site_id: number; active: number } | undefined;
	if (!row || !row.active || (siteIds && !siteIds.includes(row.site_id))) return false;
	return db().prepare("UPDATE alert_events SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = ? AND status IN ('resolved','dismissed')").run(id).changes > 0;
}

export { ruleText };
