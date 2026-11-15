import { describe, expect, it } from 'vitest';
import { checkPage, parseOnPage, parseStructuredData } from '../src/lib/onpage';

const page = (head: string, body = '<h1>Garden tools</h1><p>text</p>') => `<!doctype html><html lang="en"><head><title>Garden tools: a practical guide</title><meta name="description" content="A practical guide to garden tools for small gardens.">${head}</head><body>${body}</body></html>`;
const ids = (html: string) => checkPage(parseOnPage(html), []).issues.map((i) => i.id);

describe('viewport', () => {
	it('is read, and a missing one is a warning', () => {
		expect(parseOnPage(page('<meta name="viewport" content="width=device-width, initial-scale=1">')).viewport).toBe('width=device-width, initial-scale=1');
		expect(ids(page(''))).toContain('no-viewport');
		expect(ids(page('<meta name="viewport" content="width=device-width">'))).not.toContain('no-viewport');
		expect(checkPage(parseOnPage(page('')), []).issues.find((i) => i.id === 'no-viewport')!.severity).toBe('warn');
	});
	it('is not judged on a check stored before the field existed', () => {
		const old = { title: 'T', description: 'D', h1: ['x'], canonical: null, robots: null, lang: 'en', ogTitle: null };
		expect(checkPage(old, []).issues.map((i) => i.id)).toEqual(expect.not.arrayContaining(['no-viewport', 'no-og', 'bad-jsonld', 'img-alt']));
	});
});

describe('Open Graph', () => {
	it('flags a missing og:title or og:image as info, and says it does not affect rankings', () => {
		const i = checkPage(parseOnPage(page('<meta property="og:title" content="x">')), []).issues.find((x) => x.id === 'no-og')!;
		expect(i.severity).toBe('info');
		expect(i.message).toMatch(/No og:image tag/);
		expect(i.message).toMatch(/does not affect Google rankings/);
		expect(checkPage(parseOnPage(page('')), []).issues.find((x) => x.id === 'no-og')!.message).toMatch(/og:title and og:image/);
	});
	it('is quiet when the tags are there, in either attribute order', () => {
		expect(ids(page('<meta property="og:title" content="x"><meta content="https://x.test/a.png" property="og:image">'))).not.toContain('no-og');
	});
});

describe('structured data (JSON-LD)', () => {
	const ld = (json: string) => `<script type="application/ld+json">${json}</script>`;
	it('reads the declared types, from lists and @graph too', () => {
		const s = parseStructuredData(page(ld('{"@context":"https://schema.org","@type":"Article","headline":"x"}') + ld('{"@graph":[{"@type":"Organization"},{"@type":["Product","Thing"]}]}')));
		expect(s).toEqual({ blocks: 2, types: ['Article', 'Organization', 'Product', 'Thing'], invalid: 0 });
	});
	it('counts a block that is not valid JSON, and warns', () => {
		const html = page(ld('{"@type":"Article",}') + ld('{"@type":"FAQPage"}'));
		expect(parseStructuredData(html)).toMatchObject({ blocks: 2, invalid: 1, types: ['FAQPage'] });
		const issue = checkPage(parseOnPage(html), []).issues.find((i) => i.id === 'bad-jsonld')!;
		expect(issue.severity).toBe('warn');
		expect(issue.message).toMatch(/1 of 2 structured-data \(JSON-LD\) blocks are not valid JSON/);
	});
	it('does not mistake other scripts for it, and does not warn about having none', () => {
		const html = page('<script>var a = {"@type":"x"};</script><script type="application/json">{bad</script>');
		expect(parseStructuredData(html)).toEqual({ blocks: 0, types: [], invalid: 0 });
		expect(ids(html)).not.toContain('bad-jsonld');
	});
	it('reads a script type with other attributes, quotes either way, any case', () => {
		expect(parseStructuredData(`<SCRIPT async TYPE='application/LD+JSON' id="a">{"@type":"WebSite"}</SCRIPT>`).types).toEqual(['WebSite']);
	});
});

describe('images', () => {
	it('counts images with no alt attribute, and treats alt="" as deliberate', () => {
		const html = page('', '<h1>x</h1><img src="a.png"><img src="b.png" alt=""><img src="c.png" alt="A tool"><IMG SRC=d.png>');
		expect(parseOnPage(html).images).toEqual({ total: 4, missingAlt: 2 });
		const i = checkPage(parseOnPage(html), []).issues.find((x) => x.id === 'img-alt')!;
		expect(i.severity).toBe('info');
		expect(i.message).toBe('2 of 4 images have no alt attribute (an empty alt="" is fine for decoration).');
	});
	it('says nothing when every image has one or there are none', () => {
		expect(ids(page('', '<h1>x</h1><img src="a" alt="a">'))).not.toContain('img-alt');
		expect(ids(page('', '<h1>x</h1>'))).not.toContain('img-alt');
	});
});

describe('hostile pages stay cheap (the whole file scans in linear time)', () => {
	const time = (f: () => unknown) => { const t = Date.now(); f(); return Date.now() - t; };
	it('thousands of unterminated or odd tags', () => {
		expect(time(() => parseOnPage('<html><head>' + '<script type="application/ld+json">'.repeat(60_000)))).toBeLessThan(1500);
		expect(time(() => parseOnPage('<html><body>' + '<img alt='.repeat(60_000)))).toBeLessThan(1500);
		expect(time(() => parseOnPage('<html><body>' + '<img src="a">'.repeat(100_000)))).toBeLessThan(2500);
	});
	it('a huge JSON-LD block is read only up to its cap, and more than 20 blocks stop the scan', () => {
		const big = `<script type="application/ld+json">{"@type":"Article","x":"${'a'.repeat(300_000)}"}</script>`;
		expect(parseStructuredData(big).invalid).toBe(1); // cut at 200 KB, so the JSON is incomplete: counted, not crashed on
		const many = '<script type="application/ld+json">{"@type":"A"}</script>'.repeat(50);
		expect(parseStructuredData(many).blocks).toBe(20);
	});
});
