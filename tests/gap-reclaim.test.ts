import { describe, expect, it } from 'vitest';
import { computeGap, isPlatform, parseCompetitors, parseRanked, studyList } from '../src/lib/gap';
import { linkProfile, parseBacklinks, reclaimPlan } from '../src/lib/reclaim';

// Shaped like live OpenSEO answers read on 2026-11-14.
const comps = { competitors: [
	{ se_type: 'google', domain: 'www.goodreads.com', avg_position: 3.5, median_position: 3, etv: 588, keywords_count: 2, visibility: 1.5, keywords_positions: { 'enid blyton books in order': [4], 'book recommendations': [3] } },
	{ domain: 'booksfarm.com', avg_position: 8, median_position: 8, etv: 40, keywords_count: 2, visibility: 0.9, keywords_positions: { 'book recommendations': [8, 12] } },
	{ domain: 'www.amazon.com', avg_position: 37, median_position: 35, etv: 19, keywords_count: 2, visibility: 0, keywords_positions: {} },
	{ domain: 'www.bookmentions.net', avg_position: 9, median_position: 9, etv: 1, keywords_count: 1, visibility: 0.1, keywords_positions: {} }
] };
const kw = (keyword: string, volume: number | null, rank: number, url = 'https://c.test/x') => ({ keyword_data: { keyword, keyword_info: { search_volume: volume }, keyword_properties: { keyword_difficulty: 30 }, search_intent_info: { main_intent: 'informational' }, serp_info: { serp_item_types: ['ai_overview', 'organic'] } }, ranked_serp_element: { serp_item: { url, rank_group: rank, etv: 3 } } });

describe('competitors', () => {
	it('parses, takes each keyword\'s best rank, and marks platforms', () => {
		const c = parseCompetitors(comps);
		expect(c[0]).toMatchObject({ domain: 'goodreads.com', platform: true, keywords: 2 });
		expect(c[1].positions['book recommendations']).toBe(8);
		expect(isPlatform('en.wikipedia.org')).toBe(true);
		expect(isPlatform('booksfarm.com')).toBe(false);
	});
	it('the study list leaves out platforms and yourself', () => {
		const s = studyList(parseCompetitors(comps), 'bookmentions.net');
		expect(s.map((x) => x.domain)).toEqual(['booksfarm.com']);
	});
	it('survives nonsense', () => {
		expect(parseCompetitors(null)).toEqual([]);
		expect(parseRanked({ keywords: 'x' })).toEqual([]);
	});
});

describe('computeGap', () => {
	const ranked = parseRanked({ keywords: [kw('Best Sci-Fi Books', 5400, 3), kw('book recommendations', 40500, 6), kw('rare phrase', null, 4), kw('tiny', 5, 2), kw('way down', 9000, 40), kw('enid blyton books in order', 8100, 4)] });
	const own = [{ query: 'book recommendations', position: 13.9, impressions: 165, clicks: 0 }, { query: 'enid blyton books in order', position: 10.2, impressions: 203, clicks: 1 }];
	const gap = computeGap('c.test', ranked, own);
	it('lists keywords you have no query for, and ones where you are well behind', () => {
		const by = Object.fromEntries(gap.map((g) => [g.keyword, g]));
		expect(by['best sci-fi books'].kind).toBe('missing');
		expect(by['book recommendations'].kind).toBe('behind'); // 13.9 vs 6: 7.9 places
		expect(by['enid blyton books in order'].kind).toBe('behind'); // 10.2 vs 4
	});
	it('drops tiny volumes and ranks past 20, keeps unknown volume last', () => {
		const names = gap.map((g) => g.keyword);
		expect(names).not.toContain('tiny');
		expect(names).not.toContain('way down');
		expect(names[names.length - 1]).toBe('rare phrase');
	});
	it('puts the biggest prize first', () => {
		expect(gap[0].keyword).toBe('book recommendations'); // 40,500 x 0.3 beats 5,400 x 1
	});
	it('does not call a keyword you already rank top 10 for a gap', () => {
		const g = computeGap('c.test', ranked, [{ query: 'book recommendations', position: 7, impressions: 1, clicks: 0 }]);
		expect(g.map((x) => x.keyword)).not.toContain('book recommendations');
	});
});

const live = { backlinks: { rows: [
	{ domainFrom: 'seolinkagency.shop', urlFrom: 'https://seolinkagency.shop/x', urlTo: 'https://bookmentions.net/', anchor: 'Premium Backlink Services', isDofollow: false, spamScore: 25, domainFromRank: 0, isLost: false, isBroken: false },
	{ domainFrom: 'obake.pages.dev', urlFrom: 'https://obake.pages.dev/y', urlTo: 'https://bookmentions.net/', anchor: 'bookmentions.net', isDofollow: false, spamScore: 25, domainFromRank: 15, isLost: false, isBroken: false },
	{ domainFrom: 'global-website.pages.dev', urlFrom: 'https://global-website.pages.dev/z', urlTo: 'https://bookmentions.net/', anchor: 'x', isDofollow: false, spamScore: 35, isLost: false, isBroken: false }
], totalCount: 3, hasMore: false } };

describe('link profile', () => {
	it('says a tiny profile is tiny (the real BookMentions answer)', () => {
		const { rows, total } = parseBacklinks(live);
		const p = linkProfile(rows, total);
		expect(p).toMatchObject({ backlinks: 3, referringDomains: 3, dofollow: 0, nofollow: 3, quality: 'tiny' });
		expect(p.headline).toMatch(/very thin link profile/);
		expect(p.headline).not.toMatch(/holding this site back/);
	});
	it('says none when there are none', () => {
		expect(linkProfile([], 0).quality).toBe('none');
	});
});

describe('reclaimPlan', () => {
	const rows = parseBacklinks({ backlinks: { rows: [
		{ domainFrom: 'blog.example', urlFrom: 'https://blog.example/a', urlTo: 'https://x.test/lists/best-self-help-book', anchor: 'self help list', isDofollow: true, spamScore: 5, isLost: false, isBroken: true },
		{ domainFrom: 'news.example', urlFrom: 'https://news.example/b', urlTo: 'https://x.test/old-page', anchor: 'old', isDofollow: false, spamScore: 10, isLost: false, isBroken: false },
		{ domainFrom: 'spam.example', urlFrom: 'https://spam.example/c', urlTo: 'https://x.test/old-page', anchor: 'cheap', isDofollow: true, spamScore: 80, isLost: false, isBroken: false },
		{ domainFrom: 'gone.example', urlFrom: 'https://gone.example/d', urlTo: 'https://x.test/old-page', anchor: 'g', isDofollow: true, spamScore: 1, isLost: true, isBroken: false },
		{ domainFrom: 'fine.example', urlFrom: 'https://fine.example/e', urlTo: 'https://x.test/working', anchor: 'w', isDofollow: true, spamScore: 1, isLost: false, isBroken: false }
	], totalCount: 5 } }).rows;
	const live = [{ url: 'https://x.test/lists/best-self-help-books', clicks: 4, impressions: 300 }, { url: 'https://x.test/people/tim-ferriss', clicks: 1, impressions: 50 }];
	const plan = reclaimPlan(rows, new Map([['x.test/old-page', 'The page answers 404.']]), live);
	it('groups links to dead targets, skipping spam, lost links and working pages', () => {
		expect(plan.map((p) => p.target)).toEqual(['https://x.test/lists/best-self-help-book', 'https://x.test/old-page']);
		const old = plan.find((p) => p.target.endsWith('old-page'))!;
		expect(old.links).toHaveLength(1); // the spam and the lost link are out
		expect(old.why).toBe('The page answers 404.');
	});
	it('suggests the closest live page by the words in its address, or none', () => {
		expect(plan[0].redirectTo).toBe('https://x.test/lists/best-self-help-books');
		expect(plan[0].match).toBeGreaterThan(0.5);
		expect(plan.find((p) => p.target.endsWith('old-page'))!.redirectTo).toBeNull();
	});
});
