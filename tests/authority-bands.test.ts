import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BANDS_TEXT, BAND_COLOR, GREEN_FROM, ORANGE_FROM, authorityBand } from '../src/lib/authority';

/** Higher authority reads greener: red low, orange in the middle, green high. The bands are the app's own and are stated as such. */
describe('authority colour bands', () => {
	it('red below 30, orange from 30, green from 60, at the edges and across the range', () => {
		expect([0, 1, 29, 29.9].map(authorityBand)).toEqual(['low', 'low', 'low', 'low']);
		expect([30, 45, 59, 59.9].map(authorityBand)).toEqual(['medium', 'medium', 'medium', 'medium']);
		expect([60, 80, 100].map(authorityBand)).toEqual(['high', 'high', 'high']);
		expect([ORANGE_FROM, GREEN_FROM]).toEqual([30, 60]);
	});
	it('a higher score never reads worse than a lower one', () => {
		const rank = { low: 0, medium: 1, high: 2 };
		let last = 0;
		for (let v = 0; v <= 100; v += 0.5) {
			const r = rank[authorityBand(v)];
			expect(r).toBeGreaterThanOrEqual(last);
			last = r;
		}
	});
	it('uses the theme\'s red, amber and green (which have a dark-mode version) and says so in words', () => {
		expect(BAND_COLOR).toEqual({ low: 'var(--bad)', medium: 'var(--warn)', high: 'var(--good)' });
		const css = readFileSync('src/app.css', 'utf8');
		for (const v of ['--good', '--warn', '--bad']) expect(css).toContain(`${v}:`);
		expect(BANDS_TEXT).toBe('red under 30, orange 30 to 59, green 60 or more');
	});
	it('the circles are coloured from the band, the tooltip and aria-label name the colour, and the dashboard explains the bands as its own', () => {
		const c = readFileSync('src/lib/components/AuthorityBadges.svelte', 'utf8');
		expect(c).toContain('authorityBand(');
		expect(c).toContain('BAND_COLOR[band]');
		// the colour is decided on the rounded number that is shown: 59.8 is drawn as "60", so it must be green, not orange
		expect(c).toContain('authorityBand(shown)');
		expect(c.slice(c.indexOf('</script>'))).toContain('{i.shown}');
		expect(c.slice(c.indexOf('</script>'))).toContain('{BANDS_TEXT}');
		expect(c.slice(c.indexOf('</script>'))).toMatch(/aria-label="[^"]*\{i\.name\}"/);
		const page = readFileSync('src/routes/+page.svelte', 'utf8');
		expect(page).toContain('{BANDS_TEXT}');
		expect(page).toContain("this app's own bands, not Ahrefs' or Moz's");
	});
});
