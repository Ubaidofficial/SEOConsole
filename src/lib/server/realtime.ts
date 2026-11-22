import { db } from './db';
import { linksFor } from './links';
import { realtimeEvents, realtimeUsers, type Ga4RealtimeRow, type Ga4RealtimeUsers } from './ga4';

const DEMO_USERS: Ga4RealtimeUsers = {
	total: 23,
	pages: [
		{ title: 'Home', users: 9, views: 14 },
		{ title: 'Best indoor plants for low light', users: 6, views: 8 },
		{ title: 'Monstera care guide', users: 4, views: 5 },
		{ title: 'Checkout', users: 2, views: 3 }
	],
	countries: [
		{ country: 'United States', users: 12 },
		{ country: 'United Kingdom', users: 5 },
		{ country: 'Canada', users: 3 },
		{ country: 'Germany', users: 3 }
	],
	devices: [
		{ device: 'mobile', users: 14 },
		{ device: 'desktop', users: 8 },
		{ device: 'tablet', users: 1 }
	],
	minutes: Array.from({ length: 30 }, (_, i) => ({ minutesAgo: i, users: [3, 2, 4, 1, 2, 3, 0, 1, 2, 2][i % 10] }))
};

/**
 * GA4 Realtime for one site, last 30 minutes: events by name, and who is on the site (active users in total and by page title, country,
 * device and minute). Read live from Google on each call (nothing is stored), with the read-only GA4 access every connection has. The
 * visitor breakdown is extra: if only it fails, the events still come back, with `usersError`. Demo sites get a fixed, labelled answer.
 */
export async function realtimeFor(
	siteId: number,
	o: { search?: string; fetchImpl?: typeof fetch } = {}
): Promise<{ linked: false } | { linked: true; ok: true; events: Ga4RealtimeRow[]; total: number; users: Ga4RealtimeUsers | null; usersError?: string; demo: boolean } | { linked: true; ok: false; error: string }> {
	const link = linksFor(siteId).ga4;
	if (!link?.account_id) return { linked: false };
	const demo = !!(db().prepare('SELECT is_demo d FROM accounts WHERE id = ?').get(link.account_id) as { d: number } | undefined)?.d;
	let rows: Ga4RealtimeRow[];
	let users: Ga4RealtimeUsers | null = null;
	let usersError: string | undefined;
	try {
		if (demo) {
			rows = [{ event: 'page_view', count: 42 }, { event: 'user_engagement', count: 31 }, { event: 'scroll', count: 12 }, { event: 'generate_lead', count: 2 }];
			users = DEMO_USERS;
		} else {
			const [ev, us] = await Promise.all([realtimeEvents(link.account_id, link.external_id, { fetchImpl: o.fetchImpl }), realtimeUsers(link.account_id, link.external_id, { fetchImpl: o.fetchImpl }).catch((e: unknown) => ((usersError = e instanceof Error ? e.message : String(e)), null))]);
			rows = ev;
			users = us;
		}
	} catch (e) {
		return { linked: true, ok: false, error: e instanceof Error ? e.message : String(e) };
	}
	const needle = o.search?.trim().toLowerCase();
	const events = needle ? rows.filter((r) => r.event.toLowerCase().includes(needle)) : rows;
	return { linked: true, ok: true, events, total: rows.reduce((a, r) => a + r.count, 0), users, ...(usersError ? { usersError } : {}), demo };
}
