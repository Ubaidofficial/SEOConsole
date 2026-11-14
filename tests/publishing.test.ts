import { describe, expect, it } from 'vitest';
import { buildStamp, folderOf, publishingReport, type PubUrl } from '../src/lib/publishing';

const TODAY = '2026-11-14';
const u = (path: string, o: Partial<PubUrl> = {}): PubUrl => ({ url: `https://x.test${path}`, lastmod: null, clicks: 0, impressions: 0, index: null, reason: null, ...o });
const many = (n: number, f: (i: number) => PubUrl) => Array.from({ length: n }, (_, i) => f(i));

describe('folderOf', () => {
	it('uses the first path segment, and the root for top-level pages', () => {
		expect(folderOf('https://x.test/lists/best-books')).toBe('/lists/');
		expect(folderOf('https://x.test/about')).toBe('/');
		expect(folderOf('https://x.test/')).toBe('/');
		expect(folderOf('https://x.test/a/b/c', 2)).toBe('/a/b/');
		expect(folderOf('nonsense')).toBe('/');
	});
});

describe('buildStamp', () => {
	it('spots a date most URLs share, and ignores small or mixed sets', () => {
		expect(buildStamp(many(20, (i) => u(`/${i}`, { lastmod: i < 15 ? '2026-11-14' : `2026-10-${10 + i}` })))?.date).toBe('2026-11-14');
		expect(buildStamp(many(20, (i) => u(`/${i}`, { lastmod: `2026-10-${10 + i}` })))).toBeNull();
		expect(buildStamp(many(5, () => u('/a', { lastmod: '2026-11-14' })))).toBeNull();
	});
});

describe('publishingReport', () => {
	it('calls a big section that Google shows almost none of stalled, with the numbers in the headline', () => {
		const urls = [
			...many(100, (i) => u(`/compare/a${i}-vs-b${i}`, { lastmod: `2026-0${(i % 4) + 5}-01`, impressions: i < 3 ? 40 : 0, clicks: i < 1 ? 2 : 0 })),
			...many(30, (i) => u(`/people/p${i}`, { lastmod: `2026-08-0${(i % 9) + 1}`, impressions: i < 24 ? 100 : 0, clicks: i < 24 ? 3 : 0 }))
		];
		const r = publishingReport(urls, TODAY);
		const compare = r.sections.find((s) => s.folder === '/compare/')!;
		const people = r.sections.find((s) => s.folder === '/people/')!;
		expect(compare.verdict).toBe('stalled');
		expect(compare.shown).toBe(3);
		expect(people.verdict).toBe('working');
		expect(r.headline).toMatch(/stalled/);
		expect(r.headline).toMatch(/\/compare\/: 3 of 100/);
		expect(r.sections[0].folder).toBe('/compare/'); // biggest first
	});
	it('does not blame a section of brand-new pages', () => {
		const urls = many(40, (i) => u(`/new/p${i}`, { lastmod: `2026-11-${String(1 + (i % 10)).padStart(2, '0')}` }));
		expect(publishingReport(urls, TODAY).sections[0].verdict).toBe('too_new');
	});
	it('does not trust a build-stamp date for age, and says age is unknown', () => {
		const urls = many(30, (i) => u(`/a/p${i}`, { lastmod: '2026-11-14', impressions: i < 3 ? 5 : 0 }));
		const r = publishingReport(urls, TODAY);
		expect(r.buildStamp?.date).toBe('2026-11-14');
		expect(r.cohorts.find((c) => c.bucket === 'age unknown')!.urls).toBe(30);
		expect(r.sections[0].verdict).toBe('stalled'); // not excused as new
		expect(r.velocity.known).toBe(0);
	});
	it('buckets by age and reports the shown share of each', () => {
		const urls = [u('/a/1', { lastmod: '2026-11-10', impressions: 1 }), u('/a/2', { lastmod: '2026-11-12' }), u('/a/3', { lastmod: '2026-08-01', impressions: 5, clicks: 1 }), u('/a/4', { lastmod: '2026-01-01' }), u('/a/5')];
		const r = publishingReport(urls, TODAY);
		const by = Object.fromEntries(r.cohorts.map((c) => [c.bucket, c]));
		expect(by['0-14 days'].urls).toBe(2);
		expect(by['0-14 days'].shown).toBe(1);
		expect(by['over 90 days'].urls).toBe(2);
		expect(by['age unknown'].urls).toBe(1);
		expect(r.velocity.last30).toBe(2);
	});
	it('counts noindex and the reasons among inspected pages', () => {
		const urls = [
			...many(12, (i) => u(`/s/${i}`, { index: 'not_indexed', reason: i < 5 ? "Excluded by 'noindex' tag" : 'URL is unknown to Google' })),
			u('/s/ok', { index: 'indexed', impressions: 3 }), u('/s/unk', { index: 'unknown' })
		];
		const s = publishingReport(urls, TODAY).sections[0];
		expect([s.inspected, s.indexed, s.notIndexed, s.noindex]).toEqual([13, 1, 12, 5]);
		expect(s.reasons[0]).toEqual({ reason: 'URL is unknown to Google', count: 7 });
	});
	it('handles an empty sitemap', () => {
		const r = publishingReport([], TODAY);
		expect(r.sections).toEqual([]);
		expect(r.headline).toMatch(/read the sitemaps/);
		expect(r.totals.shownShare).toBe(0);
	});
});
