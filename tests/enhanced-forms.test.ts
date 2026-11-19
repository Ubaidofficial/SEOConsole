import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every .svelte file under a directory. */
function svelteFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((n) => {
		const p = join(dir, n);
		return statSync(p).isDirectory() ? svelteFiles(p) : p.endsWith('.svelte') ? [p] : [];
	});
}

describe('enhanced forms', () => {
	// use:enhance reads the answer as a form action's JSON. A form that posts with it to a plain +server.ts endpoint gets that endpoint's
	// redirect target, an HTML page, and fails with "Unexpected token '<', "<!doctype "... is not valid JSON" (the site Sync button did).
	it('every form with use:enhance posts to a form action (an action="?/name" or "/path?/name", or the page\'s own default action)', () => {
		const bad: string[] = [];
		for (const f of [...svelteFiles('src/routes'), ...svelteFiles('src/lib/components')]) {
			for (const m of readFileSync(f, 'utf8').matchAll(/<form\b[^>]*\buse:enhance\b[^>]*>/g)) {
				const a = /\baction=(?:"([^"]*)"|\{([^}]*)\})/.exec(m[0]);
				const action = a ? (a[1] ?? a[2]) : undefined;
				if (action !== undefined && !action.includes('?/')) bad.push(`${f}: ${m[0].slice(0, 120)}`);
			}
		}
		expect(bad).toEqual([]);
	});
});
