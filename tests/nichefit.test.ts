import { describe, expect, it } from 'vitest';
import { nicheProfile, scoreKeywords, statusOf } from '../src/lib/nichefit';

const q = (query: string, clicks: number, impressions: number, position: number) => ({ query, clicks, impressions, position });
// A site that wins on "<person> book recommendations" and is shown far down for generic "best <genre> books".
const genres = ['fiction', 'travel', 'history', 'science', 'sports', 'memoir'];
const rows = [
	q('nancy pearl book recommendations', 2, 40, 11), q('james clear book recommendations', 1, 67, 10.7), q('ray dalio book recommendations', 1, 8, 19),
	q('tim ferriss book recommendations', 1, 30, 9), q('naval book recommendations', 0, 25, 8),
	...genres.flatMap((g) => [q(`best ${g} books`, 0, 120, 55), q(`top ${g} books`, 0, 90, 58), q(`great ${g} books`, 0, 60, 62), q(`${g} books to read`, 0, 40, 60)]),
	q('cryptography books 2025', 0, 2700, 6), q('cryptography books 2024', 0, 2400, 5.4), q('cryptography books 2026', 0, 210, 6.6), q('best cryptography books', 0, 150, 8)
];

describe('statusOf', () => {
	it('separates ranking-without-clicks from being shown far down', () => {
		expect(statusOf({ clicks: 0, impressions: 5000, position: 6 })).toBe('ranks-no-clicks');
		expect(statusOf({ clicks: 1, impressions: 2000, position: 50 })).toBe('reach-only');
		expect(statusOf({ clicks: 6, impressions: 300, position: 12 })).toBe('winning');
		expect(statusOf({ clicks: 0, impressions: 30, position: 70 })).toBe('minor');
		expect(statusOf({ clicks: 0, impressions: 400, position: 22 })).toBe('minor'); // mid-table, not judged either way
		expect(statusOf({ clicks: 1, impressions: 4000, position: 12 })).toBe('winning'); // page two: a click rate under 0.5% is normal there
	});
});

describe('nicheProfile', () => {
	const p = nicheProfile(rows);
	it('finds the topic that earns clicks and the topics that only get reach', () => {
		const by = Object.fromEntries(p.topics.map((t) => [t.topic, t.status]));
		expect(by['recommendation']).toBe('winning');
		expect(by['fiction']).toBe('reach-only');
		expect(by['history']).toBe('reach-only');
		expect(by['cryptography']).toBe('ranks-no-clicks');
	});
	it('reports the share of impressions that are shown-far-down reach', () => {
		expect(p.reachOnlyShare).toBeGreaterThan(0.2);
		expect(p.noClicksShare).toBeGreaterThan(0.4);
		expect(p.headline).toMatch(/shown far down/);
		expect(p.headline).toMatch(/page one and almost nobody clicks/);
		expect(p.headline).toMatch(/recommendation/);
	});
	it('does not announce 0% of anything', () => {
		const calm = nicheProfile([q('a b c', 3, 100, 8), q('a b d', 2, 100, 9), q('a b e', 1, 100, 7)]);
		expect(calm.headline).not.toMatch(/\b0%/);
		expect(calm.headline).toMatch(/No topic stands out/);
	});
	it('builds the vocabulary from what wins, not from what is only shown', () => {
		expect(p.vocabulary.has('recommendation')).toBe(true);
		expect(p.vocabulary.has('fiction')).toBe(false);
	});
	it('handles no data', () => {
		const e = nicheProfile([]);
		expect(e.topics).toEqual([]);
		expect(e.headline).toBe('No search data yet.');
	});
});

describe('scoreKeywords', () => {
	const p = nicheProfile(rows);
	const s = Object.fromEntries(scoreKeywords(p, ['elon musk book recommendations', 'best fiction books', 'cheap flights to rome', 'bill gates reading list', '']).map((k) => [k.keyword, k]));
	it('puts keywords that share the winning words first', () => {
		expect(s['elon musk book recommendations'].fit).not.toBe('off');
		expect(s['elon musk book recommendations'].score).toBeGreaterThan(s['cheap flights to rome'].score);
		expect(s['cheap flights to rome'].fit).toBe('off');
	});
	it('warns about topics the site is already shown for without winning', () => {
		expect(s['best fiction books'].note).toMatch(/already appear for "fiction"/);
	});
	it('does not crash on an empty keyword', () => {
		expect(s[''].fit).toBe('off');
	});
	it('orders best first', () => {
		const out = scoreKeywords(p, ['zzz qqq', 'ray dalio book recommendations']);
		expect(out[0].keyword).toBe('ray dalio book recommendations');
	});
});
