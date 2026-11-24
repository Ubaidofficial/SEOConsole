import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { insightCounts, tabOfHref } from '../src/lib/insights-hub';
import { SITE_PRIMARY_TABS, SITE_SOURCE_TABS, SITE_TABS, SITE_TAB_GROUPS } from '../src/lib/explain';

/** The site header, the Insights page, report panels and the joined numbers bar. */

describe('Insights page numbers', () => {
	it('reads the tab a finding points to, and only on this site', () => {
		expect(tabOfHref('/sites/4/decay?days=28', 4)).toBe('/decay');
		expect(tabOfHref('/sites/4', 4)).toBe('');
		expect(tabOfHref('/sites/4#plan', 4)).toBe('');
		expect(tabOfHref('/sites/40/decay', 4)).toBeNull();
		expect(tabOfHref('/connect', 4)).toBeNull();
	});
	it('counts findings per tab and keeps the biggest estimate, not the sum', () => {
		const c = insightCounts(
			[
				{ href: '/sites/1/opportunities?view=striking', impact: 120, blocking: false },
				{ href: '/sites/1/opportunities', impact: 300, blocking: false },
				{ href: '/sites/1/opportunities', impact: null, blocking: true },
				{ href: '/sites/1/onpage', impact: null, blocking: false },
				{ href: '/sites/2/decay', impact: 999, blocking: false }
			],
			1
		);
		expect(c['/opportunities']).toEqual({ findings: 3, blocking: 1, best: 300 });
		expect(c['/onpage']).toEqual({ findings: 1, blocking: 0, best: null });
		expect(c['/decay']).toBeUndefined();
	});
	it('Quick wins counts the low-effort findings, wherever they are fixed, and rounds estimates', () => {
		const c = insightCounts(
			[
				{ href: '/sites/1/links', impact: 41.6, blocking: false, effort: 'low' },
				{ href: '/sites/1/opportunities', impact: 12, blocking: false, effort: 'low' },
				{ href: '/sites/1/indexing', impact: null, blocking: true, effort: 'low' },
				{ href: '/sites/1/decay', impact: 300, blocking: false, effort: 'high' }
			],
			1
		);
		expect(c['/quickwins']).toEqual({ findings: 2, blocking: 0, best: 42 });
		expect(c['/links'].best).toBe(42);
	});
});

describe('the site header', () => {
	const layout = readFileSync('src/routes/sites/[id]/+layout.svelte', 'utf8');
	it('is one line: home, the site with its switcher, and a short row of tabs; sources sit in one menu and settings is the gear', () => {
		expect(SITE_PRIMARY_TABS.length).toBeLessThanOrEqual(8);
		expect(SITE_PRIMARY_TABS).toContain('/insights');
		for (const t of SITE_SOURCE_TABS) expect(SITE_PRIMARY_TABS as readonly string[]).not.toContain(t);
		expect(layout).toMatch(/<SiteSwitcher /);
		expect(layout).toMatch(/aria-label="All sites"/);
		expect(layout).toMatch(/aria-label="Settings"/);
		expect(readFileSync('src/lib/components/SiteSwitcher.svelte', 'utf8')).toMatch(/<h1 /);
	});
	it('every tab not on the row is reachable from the Insights page or the Sources menu', () => {
		const row = new Set<string>([...SITE_PRIMARY_TABS, ...SITE_SOURCE_TABS, '/settings']);
		const grouped = SITE_TAB_GROUPS.flatMap(([, p]) => [...p] as string[]);
		for (const [t] of SITE_TABS) expect(row.has(t) || grouped.includes(t), t).toBe(true);
	});
	it('the numbers bar is one card, and each number says what it was before', () => {
		expect(layout).toMatch(/gap-px bg-\[color:var\(--border\)\]/);
		expect(layout).toMatch(/vs \{k\.prev\}/);
		expect(readFileSync('src/routes/sites/[id]/+layout.server.ts', 'utf8')).toMatch(/prev: comparable \?/);
	});
});

describe('report panels', () => {
	it('every panel on the overview has the shared header with save-as-image and full screen', () => {
		const panel = readFileSync('src/lib/components/Panel.svelte', 'utf8');
		expect(panel).toMatch(/toPng\(/);
		expect(panel).toMatch(/Open \$\{title\} full screen|Open \{title\} full screen/);
		const overview = readFileSync('src/routes/sites/[id]/+page.svelte', 'utf8');
		expect(overview).not.toMatch(/<section class="rounded-2xl border bg-card p-5 shadow-xs/);
		expect((overview.match(/<Panel\b/g) ?? []).length).toBeGreaterThanOrEqual(10);
	});
	it('page rows can be opened and copied', () => {
		const mover = readFileSync('src/lib/components/viz/MoverPanel.svelte', 'utf8');
		expect(mover).toMatch(/target="_blank" rel="noreferrer noopener"/);
		expect(mover).toMatch(/navigator\.clipboard\.writeText/);
	});
});
