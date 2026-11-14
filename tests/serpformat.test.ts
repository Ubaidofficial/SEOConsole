import { describe, expect, it } from 'vitest';
import { checkSerp, formatOf, pageFormat, parseSerp, serpCredits, type SerpKeyword } from '../src/lib/serpformat';

// Shaped like a real get_serp_results answer from 2026-11-14 (organic URLs were google.com/goto redirects).
const live = {
	results: [{
		keyword: 'enid blyton books in order', ok: true, device: 'desktop',
		items: [
			{ type: 'ai_overview', rank: 1, organicRank: null, title: null, url: null, domain: null, description: null },
			{ type: 'organic', rank: 2, organicRank: 1, title: 'Enid Blyton: books, biography, latest update', url: 'https://google.com/goto?url=x', domain: 'google.com' },
			{ type: 'people_also_ask', rank: 3, organicRank: null, title: null, url: null, domain: null },
			{ type: 'organic', rank: 4, organicRank: 2, title: "Enid Blyton - Lashings of Information about the Children's ...", url: 'https://google.com/goto?url=y', domain: 'google.com' },
			{ type: 'organic', rank: 5, organicRank: 3, title: 'All the Famous Five Books in Order', url: 'https://google.com/goto?url=z', domain: 'google.com' },
			{ type: 'organic', rank: 6, organicRank: 4, title: 'The Adventure Series', url: null, domain: null },
			{ type: 'organic', rank: 7, organicRank: 5, title: 'The Secret Series', url: null, domain: null },
			{ type: 'organic', rank: 8, organicRank: 6, title: 'Enid Blyton Books in Order', url: null, domain: null },
			{ type: 'organic', rank: 9, organicRank: 7, title: 'Best Enid Blyton books ranked', url: null, domain: null },
			{ type: 'organic', rank: 10, organicRank: 8, title: 'Enid Blyton reading list for kids', url: null, domain: null }
		]
	}, { keyword: 'broken one', ok: false, error: 'Internal SE Server Error.' }]
};

describe('formatOf / pageFormat', () => {
	it('reads the format from words', () => {
		expect(formatOf('Best Travel Books | BookMentions')).toBe('list');
		expect(formatOf('Enid Blyton Books In Order')).toBe('list');
		expect(formatOf('CAC calculator for ecommerce')).toBe('tool');
		expect(formatOf('Triple Whale alternatives')).toBe('compare');
		expect(formatOf('How to track UTM parameters')).toBe('howto');
		expect(formatOf('Hyros pricing')).toBe('product');
		expect(formatOf('Enid Blyton: books, biography')).toBe('reference');
	});
	it('reads the format of your own page from the slug', () => {
		expect(pageFormat('https://x.test/series/enid-blyton-books-in-order')).toBe('list');
		expect(pageFormat('https://x.test/compare/bill-gates-vs-tim-ferriss')).toBe('compare');
		expect(pageFormat('https://x.test/people/tim-ferriss')).toBe('reference');
		expect(pageFormat('https://x.test/tools/cac-calculator')).toBe('tool');
		expect(pageFormat('not a url')).toBe('reference');
	});
});

describe('parseSerp', () => {
	it('keeps items and failures, drops untyped items', () => {
		const p = parseSerp({ results: [...live.results, { keyword: 'x', ok: true, items: [{ rank: 1 }, 'junk'] }] });
		expect(p).toHaveLength(3);
		expect(p[0].items).toHaveLength(10);
		expect(p[1]).toMatchObject({ ok: false, error: 'Internal SE Server Error.' });
		expect(p[2].items).toEqual([]);
	});
	it('survives nonsense', () => {
		expect(parseSerp(null)).toEqual([]);
		expect(parseSerp({ results: 'no' })).toEqual([]);
	});
});

describe('checkSerp', () => {
	const k = parseSerp(live)[0];
	it('sees the AI overview above the first organic result and People Also Ask as a softer element', () => {
		const c = checkSerp(k);
		expect(c.above).toEqual(['ai_overview']);
		expect(c.soft).toEqual(['people_also_ask']);
		expect(c.verdict).toBe('crowded');
		expect(c.note).toMatch(/AI overview sits above the first organic result/);
	});
	it('finds the dominant format and a mismatch with your page', () => {
		const c = checkSerp(k, { page: 'https://x.test/people/enid-blyton', position: 10, impressions: 600, clicks: 1 });
		expect(c.dominant?.format).toBe('list');
		expect(c.pageFormat).toBe('reference'); // reference is never called a mismatch: too vague to say
		expect(c.verdict).toBe('crowded');
		const mismatch = checkSerp(k, { page: 'https://x.test/compare/a-vs-b', position: 12, impressions: 100, clicks: 0 });
		expect(mismatch.verdict).toBe('both');
		expect(mismatch.note).toMatch(/list \/ roundup/);
	});
	it('is fine when the page matches and nothing crowds it', () => {
		const clean: SerpKeyword = { ...k, items: k.items.filter((i) => i.type === 'organic') };
		const c = checkSerp(clean, { page: 'https://x.test/series/enid-blyton-books-in-order', position: 10, impressions: 600, clicks: 1 });
		expect(c.verdict).toBe('ok');
		expect(c.note).toMatch(/same kind as most results/);
	});
	it('says so when the lookup failed', () => {
		const c = checkSerp(parseSerp(live)[1]);
		expect(c.verdict).toBe('unclear');
		expect(c.note).toMatch(/lookup failed/);
	});
});

describe('serpCredits', () => {
	it('follows OpenSEO\'s stated price: about 5 a keyword at depth 20, 2.5 less at 10', () => {
		expect(serpCredits(10, 20)).toBe(50);
		expect(serpCredits(10, 10)).toBe(25);
		expect(serpCredits(4, 30)).toBe(30);
	});
});
