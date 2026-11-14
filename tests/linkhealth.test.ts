import { describe, expect, it } from 'vitest';
import { linkHealth, targetState, type CrawlPage } from '../src/lib/linkhealth';

const page = (path: string, links: string[], o: Partial<CrawlPage> = {}): CrawlPage => ({
	url: `https://x.test${path}`, finalUrl: `https://x.test${path}`, status: 200, error: null,
	links: links.map((l, i) => ({ url: `https://x.test${l}`, anchor: `a${i}`, chrome: false })), ...o
});

describe('targetState', () => {
	it('calls 404, 410 and server errors broken, but not bot-protection answers', () => {
		const n = 'x.test/a';
		expect(targetState({ status: 404, finalUrl: null, error: 'x' }, n)).toBe('broken');
		expect(targetState({ status: 410, finalUrl: null, error: 'x' }, n)).toBe('broken');
		expect(targetState({ status: 500, finalUrl: null, error: 'x' }, n)).toBe('broken');
		expect(targetState({ status: 403, finalUrl: null, error: 'x' }, n)).toBe('blocked');
		expect(targetState({ status: 429, finalUrl: null, error: 'x' }, n)).toBe('blocked');
		expect(targetState({ status: 0, finalUrl: null, error: 'Could not fetch' }, n)).toBe('unreachable');
		expect(targetState({ status: 200, finalUrl: 'https://x.test/b', error: null }, n)).toBe('redirect');
		expect(targetState({ status: 200, finalUrl: 'https://www.x.test/a/', error: null }, n)).toBe('ok'); // www and slash are not a redirect
	});
});

describe('linkHealth', () => {
	const pages = [
		page('/', ['/a', '/gone', '/old']),
		page('/a', ['/gone', '/b']),
		page('/b', ['/'], { }),
		page('/gone', [], { status: 404, error: 'The page answered 404' }),
		page('/old', [], { finalUrl: 'https://x.test/new' }) // crawled: redirects to /new
	];
	it('finds broken targets and the pages that link to them, most-linked first', () => {
		const h = linkHealth(pages, new Map());
		expect(h.broken.map((b) => b.target)).toEqual(['x.test/gone']);
		expect(h.broken[0].sources.map((s) => s.page)).toEqual(['https://x.test/', 'https://x.test/a']);
		expect(h.broken[0].status).toBe(404);
	});
	it('finds links that go through a redirect', () => {
		const h = linkHealth(pages, new Map());
		expect(h.redirected.map((r) => [r.target, r.finalUrl])).toEqual([['x.test/old', 'https://x.test/new']]);
	});
	it('counts link targets nobody checked instead of calling them fine', () => {
		const withOutside = [...pages, page('/c', ['/never-fetched', '/also-not'])];
		const h = linkHealth(withOutside, new Map());
		expect(h.unchecked.sort()).toEqual(['x.test/also-not', 'x.test/never-fetched']);
		expect(h.headline).toMatch(/2 other link targets have not been checked/);
		const verified = linkHealth(withOutside, new Map([['x.test/never-fetched', { status: 404, finalUrl: null, error: 'x' }], ['x.test/also-not', { status: 200, finalUrl: 'https://x.test/also-not', error: null }]]));
		expect(verified.unchecked).toEqual([]);
		expect(verified.broken.map((b) => b.target)).toContain('x.test/never-fetched');
	});
	it('ignores a page linking to itself and counts each source once', () => {
		const h = linkHealth([page('/a', ['/a', '/x', '/x'], { }), page('/x', [], { status: 404, error: 'e' })], new Map());
		expect(h.broken[0].sources).toHaveLength(1);
		expect(h.targets).toBe(1);
	});
	it('puts clicks of the linking pages into the ranking, and sorts site-wide menu links by reach', () => {
		const ps = [page('/a', ['/dead1']), page('/b', ['/dead1', '/dead2']), page('/c', ['/dead2']), page('/dead1', [], { status: 404, error: 'e' }), page('/dead2', [], { status: 404, error: 'e' })];
		const h = linkHealth(ps, new Map(), new Map([['x.test/c', 500]]));
		expect(h.broken.map((b) => b.target)).toEqual(['x.test/dead2', 'x.test/dead1']); // equal reach (2 vs 2): clicks decide
	});
	it('says nothing is wrong when nothing is, and asks for a crawl when there is none', () => {
		expect(linkHealth([page('/', ['/b']), page('/b', ['/'])], new Map()).headline).toMatch(/No broken or redirected/);
		expect(linkHealth([], new Map()).headline).toMatch(/run the crawl/);
	});
	it('skips an unreadable page rather than blaming it for links it never showed', () => {
		const h = linkHealth([page('/a', ['/b'], { status: 0, error: 'timeout' }), page('/b', [])], new Map());
		expect(h.targets).toBe(0);
	});
});
