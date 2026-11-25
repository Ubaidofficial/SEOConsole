import { describe, expect, it } from 'vitest';
import { AUTO_LINK_SCORE, rankOpenSeoProjects } from '../src/lib/server/connect';

const projects = [
	{ id: 'a', name: 'AskTheSubs', domain: 'askthesubs.com' },
	{ id: 's', name: 'Six Figure Jobs', domain: '6figjobs.com' },
	{ id: 'b', name: 'BookMentions', domain: 'bookmentions.net' },
	{ id: 'd', name: 'Default', domain: null }
];

describe('suggesting an OpenSEO project for a site whose domain matches none', () => {
	it('a moved site: the Tag Manager container is on the old domain and the project is named after the site', () => {
		const r = rankOpenSeoProjects('sc-domain:sixfigurejobs.net', ['www.6figjobs.com', 'https://sixfigurejobs.net/'], projects, new Set(['a', 'b']));
		expect(r[0].id).toBe('s');
		expect(r[0].suggested).toBe(true);
		expect(r[0].score).toBeGreaterThanOrEqual(AUTO_LINK_SCORE); // strong enough to link without a click
		expect(r.slice(-2).map((p) => p.id).sort()).toEqual(['a', 'b']); // projects other sites use go last
	});
	it('a name alone is suggested, not linked by itself', () => {
		const r = rankOpenSeoProjects('sc-domain:sixfigurejobs.net', [], projects, new Set());
		expect(r[0]).toMatchObject({ id: 's', suggested: true });
		expect(r[0].score).toBeLessThan(AUTO_LINK_SCORE);
	});
	it('nothing that names the site: no suggestion', () => {
		const r = rankOpenSeoProjects('sc-domain:100kbconverter.com', [], projects, new Set());
		expect(r.some((p) => p.suggested)).toBe(false);
	});
	it('a tie is not a suggestion', () => {
		const r = rankOpenSeoProjects('sc-domain:jobs.com', [], [{ id: 'x', name: 'Jobs', domain: null }, { id: 'y', name: 'jobs', domain: null }], new Set());
		expect(r.some((p) => p.suggested)).toBe(false);
	});
});
