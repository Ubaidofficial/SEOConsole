import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { getSite } from '../src/lib/server/clients';
import { addDays } from '../src/lib/server/dates';
import { saveGroup } from '../src/lib/server/groups';
import { rankReport, summarise, trackQueries, untrackQueries } from '../src/lib/server/ranktrack';

const END = '2026-11-15';

function makeSite(days = 60): number {
	const d = db();
	d.prepare("INSERT INTO accounts (google_sub, email, created_at) VALUES ('sub', 'a@example.com', 0)").run();
	const id = Number(d.prepare("INSERT INTO sites (account_id, site_url, permission, synced_through, backfilled_to, backfill_done, created_at) VALUES (1, 'https://example.com/', 'siteOwner', ?, ?, 1, 0)").run(END, addDays(END, -(days - 1))).lastInsertRowid);
	const ins = d.prepare('INSERT OR REPLACE INTO site_daily (site_id, date, clicks, impressions, position) VALUES (?,?,?,?,?)');
	for (let i = 0; i < days; i++) ins.run(id, addDays(END, -i), 100, 2000, 5);
	return id;
}
/** [query, page, clicks, impressions, position] on every day from `from` to `to` days before END. */
const rows = (id: number, list: [string, string, number, number, number][], from: number, to: number) => {
	const ins = db().prepare("INSERT OR REPLACE INTO sa_rows (site_id, date, query, page, country, device, clicks, impressions, position) VALUES (?,?,?,?,'usa','DESKTOP',?,?,?)");
	for (let i = from; i <= to; i++) for (const [q, p, c, imp, pos] of list) ins.run(id, addDays(END, -i), q, p, c, imp, pos);
};

/**
 * This week (days 0–6) against the week before (days 7–13):
 *   alpha   5 → 2   (3 better; into the top 3), two landing pages: /a has fewer impressions but more clicks
 *   beta    2 → 4   (2 worse; out of the top 3)
 *   gamma  25 → 25  (no change), followed only because a bucket tracks it
 *   epsilon 8 → 3   (5 better; into the top 3)
 *   delta   never shown
 */
function scenario() {
	const id = makeSite();
	rows(id, [['alpha', 'https://example.com/a', 3, 10, 5], ['alpha', 'https://example.com/b', 1, 40, 5], ['beta', 'https://example.com/beta', 2, 20, 2], ['gamma', 'https://example.com/g', 0, 30, 25], ['epsilon', 'https://example.com/e', 1, 10, 8]], 7, 13);
	rows(id, [['alpha', 'https://example.com/a', 3, 10, 2], ['alpha', 'https://example.com/b', 1, 40, 2], ['beta', 'https://example.com/beta', 2, 20, 4], ['gamma', 'https://example.com/g', 0, 30, 25], ['epsilon', 'https://example.com/e', 1, 10, 3]], 0, 6);
	saveGroup(id, 'bucket', 'Firsts', { rules: [{ kind: 'list', value: 'alpha\nbeta\ngamma' }] });
	saveGroup(id, 'bucket', 'E words', { rules: [{ kind: 'list', value: 'epsilon' }] });
	trackQueries(id, ['alpha', 'beta', 'delta', 'epsilon']);
	return id;
}

beforeEach(() => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	process.env.DEMO_MODE = '0';
	process.env.SCHEDULER = '0';
});

describe('rank tracking summary', () => {
	it('averages each search\'s position this week, and its move against the week before (positive = better)', () => {
		const id = scenario();
		const r = rankReport(getSite(id)!, 28);
		expect(r.summary.tracked).toBe(5);
		// delta has no position, so it counts as tracked but not in the average
		expect(r.summary.position).toBeCloseTo((2 + 4 + 25 + 3) / 4);
		expect(r.summary.change).toBeCloseTo((3 - 2 + 0 + 5) / 4);
		// without the two climbers, the average move is a fall
		untrackQueries(id, ['alpha', 'epsilon']);
		const groupId = (name: string) => (db().prepare('SELECT id FROM rule_groups WHERE name = ?').get(name) as { id: number }).id;
		saveGroup(id, 'bucket', 'Firsts', { rules: [{ kind: 'list', value: 'beta\ngamma' }] }, groupId('Firsts'));
		saveGroup(id, 'bucket', 'E words', { rules: [{ kind: 'list', value: 'nothing here' }] }, groupId('E words'));
		const worse = rankReport(getSite(id)!, 28).summary;
		expect(worse.change).toBeLessThan(0);
		expect(worse.change).toBeCloseTo((-2 + 0) / 2);
	});
	it('counts the searches in the top 3 this week and the week before', () => {
		const r = rankReport(getSite(scenario())!, 28);
		expect(r.summary.top3).toBe(2); // alpha and epsilon
		expect(r.summary.top3Prev).toBe(1); // beta
		expect(summarise([{ week: 3.4, prevWeek: 3.6, change: 0.2 }, { week: 3.6, prevWeek: 1, change: -2.6 }, { week: null, prevWeek: 2, change: null }])).toEqual({ tracked: 3, position: 3.5, change: -1.2, top3: 1, top3Prev: 2 });
		expect(summarise([])).toEqual({ tracked: 0, position: null, change: null, top3: 0, top3Prev: 0 });
	});
	it('puts every tracked search in exactly one band each day of the period', () => {
		const r = rankReport(getSite(scenario())!, 28);
		expect(r.bands).toHaveLength(28);
		expect(r.bands[0].date).toBe(r.start);
		expect(r.bands.at(-1)!.date).toBe(END);
		for (const d of r.bands) expect(d.bands.reduce((a, x) => a + x, 0) + d.none).toBe(r.rows.length);
		const day = (i: number) => r.bands.find((d) => d.date === addDays(END, -i))!;
		expect(day(0)).toEqual({ date: END, bands: [2, 1, 0, 1], none: 1 }); // alpha 2, epsilon 3 | beta 4 | | gamma 25 | delta
		expect(day(10)).toEqual({ date: addDays(END, -10), bands: [1, 2, 0, 1], none: 1 }); // beta 2 | alpha 5, epsilon 8 | | gamma 25 | delta
		expect(day(20).none).toBe(5);
	});
	it('the landing page is the page with the most clicks for the search', () => {
		const r = rankReport(getSite(scenario())!, 28);
		const by = (q: string) => r.rows.find((x) => x.query === q)!;
		expect(by('alpha').landing).toBe('https://example.com/a');
		expect(by('gamma').landing).toBe('https://example.com/g'); // no clicks: the page with impressions
		expect(by('delta').landing).toBeNull();
	});
	it('counts tracked searches per bucket, and the ones added by hand', () => {
		const r = rankReport(getSite(scenario())!, 28);
		expect(r.bucketCounts).toEqual([{ name: 'Firsts', count: 3 }, { name: 'E words', count: 1 }]);
		expect(r.manualCount).toBe(4);
		expect(r.rows.find((x) => x.query === 'gamma')!.manual).toBe(false);
	});
});
