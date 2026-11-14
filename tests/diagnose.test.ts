import { describe, expect, it } from 'vitest';
import { classifyRow, diagnose, type DiagnoseInput, type DiagRow } from '../src/lib/diagnose';

const m = (clicks: number, impressions: number, position: number) => ({ clicks, impressions, position });
const row = (key: string, now: ReturnType<typeof m>, prev: ReturnType<typeof m>): DiagRow => ({ key, now, prev });
const base = (o: Partial<DiagnoseInput> = {}): DiagnoseInput => ({
	totals: { now: m(100, 10_000, 8), prev: m(200, 10_000, 8) },
	queries: [], pages: [], yearAgo: null, updates: [], windowEnd: '2026-11-14', comparable: true, deindexed: 0, isBrand: () => false, ...o
});

describe('classifyRow', () => {
	it('separates ranking, demand and click-rate losses', () => {
		expect(classifyRow(m(10, 1000, 12), m(40, 1000, 6))).toBe('ranking'); // 6 places worse
		expect(classifyRow(m(20, 500, 6), m(40, 1000, 6.4))).toBe('demand'); // half the impressions, same place
		expect(classifyRow(m(20, 1000, 6), m(40, 1000, 6))).toBe('clickrate'); // same everything, half the clicks
		expect(classifyRow(m(0, 0, 0), m(30, 800, 5))).toBe('lost');
	});
	it('leaves small and rising rows alone', () => {
		expect(classifyRow(m(1, 50, 9), m(2, 50, 9))).toBe('noise');
		expect(classifyRow(m(50, 900, 4), m(40, 900, 4))).toBe('noise');
		expect(classifyRow(m(8, 200, 9), m(0, 0, 0))).toBe('new');
		expect(classifyRow(m(36, 1000, 6), m(40, 1000, 6))).toBe('noise'); // a 10% dip
	});
});

describe('diagnose', () => {
	it('splits the change in clicks exactly into impressions and click rate', () => {
		const d = diagnose(base({ totals: { now: m(120, 8000, 8), prev: m(200, 10_000, 8) } }));
		expect(d.split.demand + d.split.clickRate).toBeCloseTo(120 - 200, 6);
		expect(d.split.demand).toBeCloseTo(-2000 * 0.02, 6);
	});
	it('calls a small wobble noise and says to change nothing', () => {
		const d = diagnose(base({ totals: { now: m(48, 4000, 8), prev: m(55, 4100, 8) } }));
		expect(d.clicks.significant).toBe(false);
		expect(d.hold).toBe(true);
		expect(d.headline).toMatch(/within noise/);
	});
	it('never calls a change under 5% real, however much traffic there is', () => {
		const d = diagnose(base({ totals: { now: m(15_968, 300_000, 6.7), prev: m(16_406, 300_000, 6.5) } }));
		expect(d.clicks.significant).toBe(false); // 438 clicks is 2.4 standard errors, but only 2.7%
		expect(d.headline).toMatch(/within noise/);
		expect(d.headline).not.toMatch(/down -/);
	});
	it('words a real drop without a double negative and with correct plurals', () => {
		const d = diagnose(base({ queries: [row('a', m(0, 0, 0), m(12, 300, 4))] }));
		expect(d.headline).toMatch(/^Clicks are down 50%/);
		expect(d.steps.find((s) => s.n === 4)!.detail).toMatch(/^1 search \(12 clicks\)/);
	});
	it('holds and waits while a Google update is rolling out, and names it', () => {
		const d = diagnose(base({ updates: [{ name: 'November 2026 core update', begin: '2026-11-10', end: null }] }));
		expect(d.hold).toBe(true);
		expect(d.updates[0].rolling).toBe(true);
		expect(d.headline).toMatch(/wait/);
		expect(d.steps.find((s) => s.n === 8)!.status).toBe('wait');
	});
	it('an update that finished weeks ago is context, not a reason to wait', () => {
		const d = diagnose(base({ updates: [{ name: 'March 2026 core update', begin: '2026-03-27', end: '2026-04-08' }], windowEnd: '2026-11-14' }));
		expect(d.updates[0].rolling).toBe(false);
		expect(d.hold).toBe(false);
	});
	it('ranks the causes by clicks lost and gives examples', () => {
		const d = diagnose(base({
			queries: [
				row('a', m(5, 900, 14), m(40, 1000, 5)),
				row('b', m(20, 1000, 6), m(35, 1000, 6)),
				row('c', m(0, 0, 0), m(12, 300, 4))
			]
		}));
		expect(d.causes.map((c) => c.cause)).toEqual(['ranking', 'clickrate', 'lost']);
		expect(d.causes[0].clicks).toBe(35);
		expect(d.causes[0].examples[0].key).toBe('a');
	});
	it('tells a few-pages loss from a broad one', () => {
		const few = diagnose(base({ pages: [row('/a', m(0, 10, 9), m(60, 500, 4)), row('/b', m(40, 900, 5), m(45, 900, 5))] }));
		expect(few.concentration.concentrated).toBe(true);
		const broad = diagnose(base({ pages: Array.from({ length: 20 }, (_, i) => row(`/p${i}`, m(5, 100, 8), m(10, 100, 8))) }));
		expect(broad.concentration.concentrated).toBe(false);
	});
	it('reads brand searches as demand for you, and flags last year\'s same dip as seasonal', () => {
		const d = diagnose(base({
			queries: [row('acme', m(10, 200, 1), m(60, 240, 1)), row('acme login', m(0, 0, 0), m(20, 90, 1))],
			isBrand: (q) => q.includes('acme'),
			totals: { now: m(100, 7000, 8), prev: m(200, 10_000, 8) },
			yearAgo: { now: m(150, 7200, 8), prev: m(220, 10_000, 8) }
		}));
		expect(d.brand.share).toBeGreaterThan(0.9);
		expect(d.seasonal!.impressionsPct).toBeCloseTo(-0.28, 2);
		expect(d.steps.find((s) => s.n === 9)!.status).toBe('check');
		expect(d.steps.find((s) => s.n === 9)!.detail).toMatch(/seasonal/);
	});
	it('refuses to compare when the earlier period is still downloading', () => {
		const d = diagnose(base({ comparable: false }));
		expect(d.hold).toBe(false);
		expect(d.headline).toMatch(/Not enough history/);
		expect(d.steps[0].status).toBe('wait');
	});
	it('puts de-indexing first when pages dropped out, and says so when the monitor is off', () => {
		expect(diagnose(base({ deindexed: 7 })).steps.find((s) => s.n === 7)!.status).toBe('check');
		expect(diagnose(base({ deindexed: null })).steps.find((s) => s.n === 7)!.detail).toMatch(/not switched on/);
	});
});
