import { db, audit } from './db';
import type { SiteRow } from './clients';
import { historyCoversPrevious, periodFor, topPages, topQueries } from './queries';
import { compileRuleSet, describeRuleSet, pagePath, parseRuleSet, type RuleSet } from '../rules';
import { pctChange } from '../analytics';

/**
 * Keyword buckets and page groups that people define, and saved views of a tab's filters. A bucket is a rule set over searches; a
 * page group a rule set over page paths. Membership is worked out when the data is read, so new searches and pages join as they
 * arrive, and changing a rule re-sorts the whole history at once.
 */
export type GroupKind = 'bucket' | 'pages';
export const MAX_GROUPS = 50;

export interface RuleGroup { id: number; siteId: number; kind: GroupKind; name: string; set: RuleSet; summary: string; createdAt: number; /** buckets only: its 8 biggest searches are followed on Rank tracking */ track: boolean }

const hydrate = (r: { id: number; site_id: number; kind: GroupKind; name: string; rules: string; created_at: number; track?: number }): RuleGroup | null => {
	const p = parseRuleSet(r.rules);
	if ('error' in p) return null;
	return { id: r.id, siteId: r.site_id, kind: r.kind, name: r.name, set: p.set, summary: describeRuleSet(p.set), createdAt: r.created_at, track: r.track !== 0 };
};

export function listGroups(siteId: number, kind: GroupKind): RuleGroup[] {
	return (db().prepare('SELECT * FROM rule_groups WHERE site_id = ? AND kind = ? ORDER BY name COLLATE NOCASE').all(siteId, kind) as never[]).map(hydrate).filter((g): g is RuleGroup => !!g);
}
export function getGroup(siteId: number, id: number): RuleGroup | null {
	const r = db().prepare('SELECT * FROM rule_groups WHERE site_id = ? AND id = ?').get(siteId, id);
	return r ? hydrate(r as never) : null;
}

/** Create or change a bucket or page group. The rules are checked here, whoever calls (form, MCP or REST). */
export function saveGroup(siteId: number, kind: GroupKind, name: string, rules: unknown, id?: number | null): { id: number } | { error: string } {
	const n = name.trim().slice(0, 80);
	if (!n) return { error: 'Give it a name.' };
	const p = parseRuleSet(rules);
	if ('error' in p) return p;
	const d = db();
	const clash = d.prepare('SELECT id FROM rule_groups WHERE site_id = ? AND kind = ? AND name = ? COLLATE NOCASE').get(siteId, kind, n) as { id: number } | undefined;
	if (clash && clash.id !== id) return { error: `There is already one called “${n}”.` };
	const json = JSON.stringify(p.set);
	if (id) {
		const r = d.prepare('UPDATE rule_groups SET name = ?, rules = ? WHERE id = ? AND site_id = ? AND kind = ?').run(n, json, id, siteId, kind);
		if (!r.changes) return { error: 'It no longer exists.' };
		audit(`${kind === 'bucket' ? 'bucket' : 'page group'} changed`, { siteId, detail: n });
		return { id };
	}
	const count = (d.prepare('SELECT COUNT(*) n FROM rule_groups WHERE site_id = ? AND kind = ?').get(siteId, kind) as { n: number }).n;
	if (count >= MAX_GROUPS) return { error: `Up to ${MAX_GROUPS} per site.` };
	const newId = Number(d.prepare('INSERT INTO rule_groups (site_id, kind, name, rules, created_at) VALUES (?,?,?,?,?)').run(siteId, kind, n, json, Date.now()).lastInsertRowid);
	audit(`${kind === 'bucket' ? 'bucket' : 'page group'} added`, { siteId, detail: n });
	return { id: newId };
}

export function deleteGroup(siteId: number, id: number): boolean {
	const g = getGroup(siteId, id);
	if (!g) return false;
	db().prepare('DELETE FROM rule_groups WHERE id = ? AND site_id = ?').run(id, siteId);
	// Alert rules scoped to it have nothing left to watch.
	db().prepare("UPDATE alert_rules SET enabled = 0 WHERE site_id = ? AND scope_kind IN ('bucket','pages') AND scope_value = ?").run(siteId, String(id));
	audit(`${g.kind === 'bucket' ? 'bucket' : 'page group'} removed`, { siteId, detail: g.name });
	return true;
}

/** The test for one group, by id; null when the group does not exist (a stale link). */
export function matcherFor(siteId: number, kind: GroupKind, id: number): ((value: string) => boolean) | null {
	const g = getGroup(siteId, id);
	if (!g || g.kind !== kind) return null;
	const m = compileRuleSet(g.set);
	return kind === 'pages' ? (url: string) => m(pagePath(url)) : m;
}

// ── reports ──────────────────────────────────────────────────────────────────
interface Agg { clicks: number; impressions: number; posW: number }
const add = (a: Agg, r: { clicks: number; impressions: number; position: number }) => { a.clicks += r.clicks; a.impressions += r.impressions; a.posW += r.position * r.impressions; };
const blank = (): Agg => ({ clicks: 0, impressions: 0, posW: 0 });

export interface GroupRow { id: number | null; name: string; summary: string; members: number; clicks: number; impressions: number; ctr: number | null; position: number | null; prevClicks: number; deltaPct: number | null; top: string[] }

/**
 * Every bucket (or page group) with its totals for the period, the change against the previous period of the same length, and the
 * biggest members. A search or page may sit in several buckets; the last row counts what sits in none.
 */
export function groupsReportFor(site: SiteRow, kind: GroupKind, days: number): { rows: GroupRow[]; comparable: boolean; groups: RuleGroup[] } {
	const groups = listGroups(site.id, kind);
	const p = periodFor(site, days);
	const comparable = historyCoversPrevious(site, p.prevStart);
	const keyOf = (r: { query?: string; page?: string }) => (kind === 'bucket' ? r.query! : pagePath(r.page!));
	const cur = kind === 'bucket' ? topQueries(site.id, p.start, p.end, {}, 50_000) : topPages(site.id, p.start, p.end, {}, 50_000);
	const prev = comparable ? (kind === 'bucket' ? topQueries(site.id, p.prevStart, p.prevEnd, {}, 50_000) : topPages(site.id, p.prevStart, p.prevEnd, {}, 50_000)) : [];
	const tests = groups.map((g) => compileRuleSet(g.set));
	const now = groups.map(blank);
	const before = groups.map(blank);
	const members = groups.map(() => 0);
	const top: string[][] = groups.map(() => []);
	const none = blank();
	let noneMembers = 0;
	for (const r of cur) {
		const k = keyOf(r as never);
		let hit = false;
		tests.forEach((t, i) => {
			if (!t(k)) return;
			hit = true;
			add(now[i], r);
			members[i]++;
			if (top[i].length < 3) top[i].push(k);
		});
		if (!hit) (add(none, r), noneMembers++);
	}
	const prevNone = blank();
	for (const r of prev) {
		const k = keyOf(r as never);
		let hit = false;
		tests.forEach((t, i) => { if (t(k)) (hit = true, add(before[i], r)); });
		if (!hit) add(prevNone, r);
	}
	const row = (id: number | null, name: string, summary: string, n: number, a: Agg, b: Agg, t: string[]): GroupRow => ({
		id, name, summary, members: n, clicks: a.clicks, impressions: a.impressions,
		ctr: a.impressions ? a.clicks / a.impressions : null, position: a.impressions ? a.posW / a.impressions : null,
		prevClicks: b.clicks, deltaPct: comparable ? pctChange(a.clicks, b.clicks) : null, top: t
	});
	const rows = groups.map((g, i) => row(g.id, g.name, g.summary, members[i], now[i], before[i], top[i]));
	if (groups.length) rows.push(row(null, kind === 'bucket' ? 'In no bucket' : 'In no group', '', noneMembers, none, prevNone, []));
	return { rows, comparable, groups };
}

/** Daily clicks of one bucket or page group over its whole stored history, for its chart (weekly would hide the update dates). */
export function groupHistory(site: SiteRow, kind: GroupKind, id: number, start: string, end: string): { date: string; clicks: number; impressions: number; position: number }[] {
	const test = matcherFor(site.id, kind, id);
	if (!test) return [];
	const dim = kind === 'bucket' ? 'query' : 'page';
	const rows = db().prepare(`SELECT ${dim} k, date, SUM(clicks) c, SUM(impressions) i, SUM(position * impressions) pw FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY ${dim}, date`).iterate(site.id, start, end) as Iterable<{ k: string; date: string; c: number; i: number; pw: number }>;
	const byDay = new Map<string, Agg>();
	const memo = new Map<string, boolean>();
	for (const r of rows) {
		let hit = memo.get(r.k);
		if (hit === undefined) memo.set(r.k, (hit = test(r.k)));
		if (!hit) continue;
		const a = byDay.get(r.date) ?? blank();
		a.clicks += r.c;
		a.impressions += r.i;
		a.posW += r.pw;
		byDay.set(r.date, a);
	}
	return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, a]) => ({ date, clicks: a.clicks, impressions: a.impressions, position: a.impressions ? a.posW / a.impressions : 0 }));
}

// ── saved views ──────────────────────────────────────────────────────────────
export const VIEW_TABS = ['/queries', '/pages'] as const;
export type ViewTab = (typeof VIEW_TABS)[number];
export const MAX_VIEWS = 30;
export interface SavedView { id: number; tab: ViewTab; name: string; params: string; createdBy: string | null; createdAt: number }

/** Only filter parameters are kept: the period stays with the period picker, and anything else in the address is dropped. */
const VIEW_PARAMS: Record<ViewTab, string[]> = { '/queries': ['b', 'qf', 'pos', 'country', 'device', 're', 'nre', 'bucket'], '/pages': ['group', 'view'] };
export function cleanViewParams(tab: ViewTab, raw: string): string {
	const src = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
	const out = new URLSearchParams();
	for (const k of VIEW_PARAMS[tab]) {
		const v = src.get(k);
		if (v) out.set(k, v.slice(0, 300));
	}
	return out.toString();
}

export function listViews(siteId: number, tab: ViewTab): SavedView[] {
	return (db().prepare('SELECT id, tab, name, params, created_by createdBy, created_at createdAt FROM saved_views WHERE site_id = ? AND tab = ? ORDER BY name COLLATE NOCASE').all(siteId, tab) as SavedView[]);
}

export function saveView(siteId: number, tab: string, name: string, params: string, by: string | null): { id: number } | { error: string } {
	if (!(VIEW_TABS as readonly string[]).includes(tab)) return { error: 'Views can be saved on the Queries and Pages tabs.' };
	const n = name.trim().slice(0, 60);
	if (!n) return { error: 'Give the view a name.' };
	const clean = cleanViewParams(tab as ViewTab, params);
	if (!clean) return { error: 'Set at least one filter first: a view with no filters is the plain tab.' };
	const d = db();
	if ((d.prepare('SELECT COUNT(*) n FROM saved_views WHERE site_id = ? AND tab = ?').get(siteId, tab) as { n: number }).n >= MAX_VIEWS && !d.prepare('SELECT 1 FROM saved_views WHERE site_id = ? AND tab = ? AND name = ?').get(siteId, tab, n)) return { error: `Up to ${MAX_VIEWS} views per tab.` };
	d.prepare('INSERT INTO saved_views (site_id, tab, name, params, created_by, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(site_id, tab, name) DO UPDATE SET params = excluded.params, created_by = excluded.created_by, created_at = excluded.created_at').run(siteId, tab, n, clean, by, Date.now());
	return { id: (d.prepare('SELECT id FROM saved_views WHERE site_id = ? AND tab = ? AND name = ?').get(siteId, tab, n) as { id: number }).id };
}

export function deleteView(siteId: number, id: number): boolean {
	return db().prepare('DELETE FROM saved_views WHERE id = ? AND site_id = ?').run(id, siteId).changes > 0;
}

/** Switch whether a bucket's 8 biggest searches are followed on the Rank tracking tab. */
export function setBucketTracking(siteId: number, id: number, on: boolean): boolean {
	return db().prepare("UPDATE rule_groups SET track = ? WHERE id = ? AND site_id = ? AND kind = 'bucket'").run(on ? 1 : 0, id, siteId).changes > 0;
}

/** The searches the buckets follow on Rank tracking: each tracking bucket's 8 biggest by clicks over the last 28 days. */
export const BUCKET_TRACK = 8;
export function bucketTracked(site: Pick<SiteRow, 'id' | 'synced_through'>): Map<string, string[]> {
	const out = new Map<string, string[]>();
	const buckets = listGroups(site.id, 'bucket').filter((g) => g.track);
	if (!buckets.length) return out;
	const p = periodFor(site, 28);
	const rows = topQueries(site.id, p.start, p.end, {}, 20_000);
	for (const b of buckets) {
		const test = compileRuleSet(b.set);
		for (const r of rows.filter((x) => test(x.query)).slice(0, BUCKET_TRACK)) out.set(r.query, [...(out.get(r.query) ?? []), b.name]);
	}
	return out;
}
