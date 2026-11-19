import { db } from './db';
import { linksFor } from './links';
import { realtimeEvents, type Ga4RealtimeRow } from './ga4';

/**
 * GA4 Realtime for one site: events in the last 30 minutes by name. Read live from Google on each call (nothing is stored), with the
 * read-only GA4 access every connection has. Demo sites get a fixed, labelled answer.
 */
export async function realtimeFor(siteId: number, o: { search?: string; fetchImpl?: typeof fetch } = {}): Promise<{ linked: false } | { linked: true; ok: true; events: Ga4RealtimeRow[]; total: number; demo: boolean } | { linked: true; ok: false; error: string }> {
	const link = linksFor(siteId).ga4;
	if (!link?.account_id) return { linked: false };
	const demo = !!(db().prepare('SELECT is_demo d FROM accounts WHERE id = ?').get(link.account_id) as { d: number } | undefined)?.d;
	let rows: Ga4RealtimeRow[];
	try {
		rows = demo
			? [{ event: 'page_view', count: 42 }, { event: 'user_engagement', count: 31 }, { event: 'scroll', count: 12 }, { event: 'generate_lead', count: 2 }]
			: await realtimeEvents(link.account_id, link.external_id, { fetchImpl: o.fetchImpl });
	} catch (e) {
		return { linked: true, ok: false, error: e instanceof Error ? e.message : String(e) };
	}
	const needle = o.search?.trim().toLowerCase();
	const events = needle ? rows.filter((r) => r.event.toLowerCase().includes(needle)) : rows;
	return { linked: true, ok: true, events, total: rows.reduce((a, r) => a + r.count, 0), demo };
}
