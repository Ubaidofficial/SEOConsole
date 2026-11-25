import { beforeAll, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { addDays } from '../src/lib/server/dates';
import { actionsFor, actionStates, setActionState } from '../src/lib/server/actions';
import { evaluateOutcomes, judge, learnedWeights, listOutcomes, MIN_MEASURED, outcomeStats, recordDone, scopeClicks, scopeOfKey, type TypeStats } from '../src/lib/server/outcomes';
import { rankActions, type ActionItem } from '../src/lib/actions';

beforeAll(async () => {
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
	const client = new DemoClient('demo-a');
	let guard = 0;
	await syncSite(1, { client, backfillChunkDays: 120 });
	while (!getSite(1)!.backfill_done && guard++ < 12) await syncSite(1, { client, backfillChunkDays: 120 });
}, 180_000);

describe('what a finding is about', () => {
	it('reads the page or search from the key, and treats the rest as site-wide', () => {
		expect(scopeOfKey('ctr:best shoes|example.com/shoes')).toEqual({ kind: 'page', value: 'example.com/shoes' });
		expect(scopeOfKey('decay:example.com/a')).toEqual({ kind: 'page', value: 'example.com/a' });
		expect(scopeOfKey('hidden:gem:example.com/b')).toEqual({ kind: 'page', value: 'example.com/b' });
		expect(scopeOfKey('striking:red shoes')).toEqual({ kind: 'query', value: 'red shoes' });
		expect(scopeOfKey('cannibal:red shoes')).toEqual({ kind: 'query', value: 'red shoes' });
		expect(scopeOfKey('robots:abc')).toEqual({ kind: 'site', value: null });
	});
});

describe('the verdict', () => {
	it('needs enough clicks', () => expect(judge(5, 9, 1000, 1000, 'page').verdict).toBe('too-little-data'));
	it('credits a rise only beyond what the rest of the site did', () => {
		// The page doubled, but so did the rest of the site: no clear change.
		expect(judge(100, 200, 1100, 2200, 'page').verdict).toBe('no-clear-change');
		// The page doubled while the rest stayed flat: improved.
		const j = judge(100, 200, 1100, 1200, 'page');
		expect(j.verdict).toBe('improved');
		expect(j.expected).toBeCloseTo(100);
		expect(judge(100, 40, 1100, 1040, 'page').verdict).toBe('worse');
	});
	it('a site-wide item has no control', () => expect(judge(1000, 1300, 1000, 1300, 'site').verdict).toBe('improved'));
});

describe('marking done, then measuring', () => {
	it('stores a baseline when an item is marked done, and forgets it when the item is put back', () => {
		const site = getSite(1)!;
		const item = actionsFor(site).find((a) => a.key.startsWith('striking:') || a.key.startsWith('decay:') || a.key.startsWith('ctr:'))!;
		expect(item).toBeTruthy();
		setActionState(1, item.key, 'done');
		expect(actionStates(1).get(item.key)?.state).toBe('done');
		const [o] = listOutcomes([1]);
		expect(o.key).toBe(item.key);
		expect(o.verdict).toBe('pending');
		expect(o.clicksBefore).toBeGreaterThanOrEqual(0);
		setActionState(1, item.key, 'open');
		expect(listOutcomes([1])).toHaveLength(0);
	});

	it('measures once the 28 days after are in the data, against the rest of the site', () => {
		const site = getSite(1)!;
		const end = site.synced_through!;
		const earlier = { id: 1, synced_through: addDays(end, -40) };
		const q = (db().prepare('SELECT query FROM sa_rows WHERE site_id = 1 GROUP BY query ORDER BY SUM(clicks) DESC LIMIT 1').get() as { query: string }).query;
		recordDone(earlier, `striking:${q}`, { type: 'striking', title: 'Push it', impact: 50, confidence: 'medium' });
		recordDone({ id: 1, synced_through: addDays(end, -5) }, 'robots:x', undefined);
		expect(evaluateOutcomes(site, new Set(['robots:x']))).toBe(1); // only the first: the second needs 23 more days
		const rows = listOutcomes([1]);
		const measured = rows.find((r) => r.key === `striking:${q}`)!;
		expect(measured.verdict).not.toBe('pending');
		const after = scopeClicks(1, { kind: 'query', value: q }, addDays(earlier.synced_through, 1), addDays(earlier.synced_through, 28));
		expect(measured.clicksAfter).toBe(after.clicks);
		expect(measured.stillDetected).toBe(false);
		expect(rows.find((r) => r.key === 'robots:x')!.verdict).toBe('pending');
		const stats = outcomeStats([1]);
		expect(stats.find((s) => s.type === 'striking')).toBeTruthy();
		expect(stats.find((s) => s.type === 'robots')!.pending).toBe(1);
	});
});

describe('learning from outcomes', () => {
	const st = (type: string, measured: number, improved: number): TypeStats => ({ type, measured, improved, worse: 0, noClearChange: measured - improved, tooLittleData: 0, resolved: 0, pending: 0 });
	it('gives no weight before a type has enough measured outcomes', () => {
		expect(learnedWeights([st('striking', MIN_MEASURED - 1, 6)])).toEqual({});
	});
	it('moves types up or down within 0.6-1.4', () => {
		const w = learnedWeights([st('striking', 20, 16), st('decay', 20, 1), st('ctr-gap', 3, 0)]);
		expect(w.striking).toBeGreaterThan(1);
		expect(w.striking).toBeLessThanOrEqual(1.4);
		expect(w.decay).toBeLessThan(1);
		expect(w.decay).toBeGreaterThanOrEqual(0.6);
		expect(w['ctr-gap']).toBeUndefined();
	});
	it('the weights reorder the queue, but blocking items stay first', () => {
		const mk = (key: string, type: ActionItem['type'], impact: number, blocking = false): ActionItem => ({ key, type, siteId: 1, title: key, why: '', how: '', impact, confidence: 'high', effort: 'low', blocking, href: '', evidence: [] });
		const items = [mk('a', 'decay', 100), mk('b', 'striking', 80), mk('c', 'robots', 1, true)];
		expect(rankActions(items).map((x) => x.key)).toEqual(['c', 'a', 'b']);
		expect(rankActions(items, { decay: 0.6, striking: 1.4 }).map((x) => x.key)).toEqual(['c', 'b', 'a']);
	});
});
