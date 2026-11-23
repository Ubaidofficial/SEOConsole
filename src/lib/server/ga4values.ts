import { db } from './db';
import type { SiteRow } from './clients';
import { addDays, retentionHorizon } from './dates';
import { linksFor } from './links';
import { PERIODS } from '../periods';
import type { Ga4SearchTerm, Ga4ValueKind, Ga4ValueRow } from './ga4';

/** The part of a GA4 source this module needs (structural, so channels.ts can pass its Ga4Source without an import cycle). */
export interface Ga4ValueSource {
	values?(property: string, kind: Ga4ValueKind, start: string, end: string): Promise<{ rows: Ga4ValueRow[]; currency: string | null; truncated: boolean }>;
	searchTerms?(property: string, start: string, end: string): Promise<Ga4SearchTerm[]>;
}

const KINDS: Ga4ValueKind[] = ['channel', 'landing', 'campaign'];

/**
 * Engagement time, revenue and transactions by channel, landing page and campaign, and the site's own search terms, for each stored
 * period length. Once a day after a success; every window is replaced together, so a page never mixes days. A failure is recorded on
 * the site and retried on the next sync, and the rows from the last success stay. Site search is an extra inside the extra: when only
 * it fails, the value reports are still stored. Never throws.
 */
export async function pullGa4Values(siteId: number, property: string, src: Ga4ValueSource, today: string): Promise<{ ok: boolean }> {
	if (!src.values) return { ok: true };
	const d = db();
	if (d.prepare('SELECT 1 FROM sites WHERE id = ? AND ga4_values_on = ?').get(siteId, today)) return { ok: true };
	const horizon = retentionHorizon(today);
	try {
		const pulled: { days: number; start: string; currency: string | null; truncated: string[]; rows: Map<Ga4ValueKind, Ga4ValueRow[]>; terms: Ga4SearchTerm[] | null }[] = [];
		let searchFailed = false;
		for (const days of PERIODS) {
			let start = addDays(today, -(days - 1));
			if (start < horizon) start = horizon;
			const [reports, terms] = await Promise.all([
				Promise.all(KINDS.map((k) => src.values!(property, k, start, today))),
				src.searchTerms ? src.searchTerms(property, start, today).catch(() => ((searchFailed = true), null)) : Promise.resolve(null)
			]);
			const rows = new Map<Ga4ValueKind, Ga4ValueRow[]>();
			KINDS.forEach((k, i) => rows.set(k, reports[i].rows));
			pulled.push({ days, start, currency: reports.find((r) => r.currency)?.currency ?? null, truncated: KINDS.filter((_, i) => reports[i].truncated), rows, terms });
		}
		const ins = d.prepare('INSERT OR REPLACE INTO ga4_values VALUES (?,?,?,?,?,?,?,?,?,?)');
		const insW = d.prepare('INSERT OR REPLACE INTO ga4_value_windows VALUES (?,?,?,?,?,?)');
		const insT = d.prepare('INSERT OR REPLACE INTO ga4_search_terms VALUES (?,?,?,?,?)');
		d.transaction(() => {
			d.prepare('DELETE FROM ga4_values WHERE site_id = ?').run(siteId);
			d.prepare('DELETE FROM ga4_value_windows WHERE site_id = ?').run(siteId);
			// Search terms that could not be read keep the last stored ones rather than turning into "nobody searched".
			if (!searchFailed) d.prepare('DELETE FROM ga4_search_terms WHERE site_id = ?').run(siteId);
			for (const w of pulled) {
				insW.run(siteId, w.days, w.start, today, w.currency, w.truncated.join(','));
				for (const [kind, rows] of w.rows) for (const r of rows) ins.run(siteId, w.days, kind, r.key, r.sessions, r.engagedSessions, r.keyEvents, r.engagementSec, r.revenue, r.transactions);
				for (const t of w.terms ?? []) insT.run(siteId, w.days, t.term, t.searches, t.users);
			}
			d.prepare('UPDATE sites SET ga4_values_on = ?, ga4_values_error = NULL WHERE id = ?').run(today, siteId);
		})();
		return { ok: true };
	} catch (e) {
		d.prepare('UPDATE sites SET ga4_values_error = ? WHERE id = ?').run((e instanceof Error ? e.message : String(e)).slice(0, 500), siteId);
		return { ok: false };
	}
}

export interface ValueRow {
	key: string;
	sessions: number;
	engagementRate: number;
	/** Average engagement time per session, seconds (GA4's "Average engagement time per session"). */
	avgEngagementSec: number;
	keyEvents: number;
	/** Key events per session. */
	keyEventRate: number;
	revenue: number;
	transactions: number;
	revenuePerSession: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function toRow(r: { key: string; sessions: number; engaged: number; keyEvents: number; sec: number; revenue: number; transactions: number }): ValueRow {
	const per = (n: number) => (r.sessions ? n / r.sessions : 0);
	return {
		key: r.key,
		sessions: r.sessions,
		engagementRate: per(r.engaged),
		avgEngagementSec: Math.round(per(r.sec)),
		keyEvents: r2(r.keyEvents),
		keyEventRate: per(r.keyEvents),
		revenue: r2(r.revenue),
		transactions: r.transactions,
		revenuePerSession: r2(per(r.revenue))
	};
}

/**
 * Engagement time and revenue by channel, landing page and campaign, plus site search terms, for one of the stored period lengths.
 * `search` keeps landing pages, campaigns and terms containing the text.
 */
export function ga4ValuesReport(site: Pick<SiteRow, 'id'>, days: number, o: { search?: string } = {}) {
	if (!linksFor(site.id).ga4) return { linked: false as const };
	const d = db();
	const s = d.prepare('SELECT ga4_values_on pulled, ga4_values_error error FROM sites WHERE id = ?').get(site.id) as { pulled: string | null; error: string | null };
	if (!s.pulled) return s.error ? { linked: true as const, status: 'failed' as const, error: s.error } : { linked: true as const, status: 'pending' as const };
	const w = d.prepare('SELECT start_date start, end_date end, currency, truncated FROM ga4_value_windows WHERE site_id = ? AND days = ?').get(site.id, days) as { start: string; end: string; currency: string | null; truncated: string } | undefined;
	if (!w) return { linked: true as const, status: 'no-window' as const, periods: [...PERIODS] };
	const needle = o.search?.trim().toLowerCase() ?? '';
	const keep = (k: string) => !needle || k.toLowerCase().includes(needle);
	const rows = (kind: Ga4ValueKind, filter: boolean) =>
		(d.prepare('SELECT key, sessions, engaged_sessions engaged, key_events keyEvents, engagement_sec sec, revenue, transactions FROM ga4_values WHERE site_id = ? AND days = ? AND kind = ? ORDER BY sessions DESC').all(site.id, days, kind) as Parameters<typeof toRow>[0][])
			.filter((r) => !filter || keep(r.key))
			.map(toRow);
	const channels = rows('channel', false);
	const searchTerms = (d.prepare('SELECT term, searches, users FROM ga4_search_terms WHERE site_id = ? AND days = ? ORDER BY searches DESC').all(site.id, days) as Ga4SearchTerm[]).filter((t) => keep(t.term));
	const totals = channels.reduce((a, r) => ({ sessions: a.sessions + r.sessions, sec: a.sec + r.avgEngagementSec * r.sessions, revenue: a.revenue + r.revenue, transactions: a.transactions + r.transactions }), { sessions: 0, sec: 0, revenue: 0, transactions: 0 });
	return {
		linked: true as const,
		status: 'ok' as const,
		window: { start: w.start, end: w.end },
		currency: w.currency,
		/** The last refresh failed: these rows are from the last success (window.end). */
		staleError: s.error,
		/** Kinds whose report hit GA4's row limit, so the smallest rows are missing. */
		truncated: w.truncated ? w.truncated.split(',') : [],
		/** False when no session earned revenue: the property probably has no e-commerce or revenue events, so revenue columns are hidden. */
		hasRevenue: totals.revenue > 0,
		totals: { sessions: totals.sessions, avgEngagementSec: totals.sessions ? Math.round(totals.sec / totals.sessions) : 0, revenue: r2(totals.revenue), transactions: totals.transactions },
		channels,
		landing: rows('landing', true),
		campaigns: rows('campaign', true),
		searchTerms
	};
}
