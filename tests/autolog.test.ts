import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { commonFolder, logDetected, logGtmVersion, logRobotsChange, logSitemapChanges } from '../src/lib/server/autolog';
import { syncGtm } from '../src/lib/server/channels';
import { setLink } from '../src/lib/server/links';
import type { GtmSource } from '../src/lib/server/gtm';

beforeEach(() => {
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	const d = db();
	d.prepare("INSERT INTO accounts (id, google_sub, email, status, created_at) VALUES (1, 's', 'o@example.com', 'active', 1)").run();
	d.prepare("INSERT INTO sites (id, account_id, site_url, permission, hidden, created_at) VALUES (1, 1, 'sc-domain:x.example', 'siteOwner', 0, 1)").run();
});

const entries = () => db().prepare('SELECT date, title, note, kind, page_prefix FROM annotations WHERE site_id = 1 ORDER BY id').all() as { date: string; title: string; note: string | null; kind: string; page_prefix: string | null }[];

describe('detected change-log entries', () => {
	it('are written once per event, and a deleted one never comes back', () => {
		expect(logDetected(1, { key: 'k1', title: 'Something changed', date: '2026-11-01' })).toBeTypeOf('number');
		expect(logDetected(1, { key: 'k1', title: 'Something changed', date: '2026-11-01' })).toBeNull();
		expect(entries()).toEqual([{ date: '2026-11-01', title: 'Something changed', note: null, kind: 'detected', page_prefix: null }]);
		db().prepare('DELETE FROM annotations').run();
		expect(logDetected(1, { key: 'k1', title: 'Something changed' })).toBeNull();
		expect(entries()).toEqual([]);
	});

	it('are not written for a site that switched them off', () => {
		db().prepare('UPDATE sites SET changelog_auto = 0 WHERE id = 1').run();
		expect(logDetected(1, { key: 'k', title: 't' })).toBeNull();
		expect(entries()).toEqual([]);
	});

	it('describe a robots.txt change with its rules, on the day it was seen', () => {
		logRobotsChange(1, { id: 7, origin: 'https://x.example', at: Date.parse('2026-11-10T20:00:00Z'), afterState: 'ok', added: ['Disallow: /private'], removed: [] });
		expect(entries()).toEqual([{ date: '2026-11-10', title: 'robots.txt rules changed on x.example', note: 'Added: Disallow: /private', kind: 'detected', page_prefix: null }]);
	});

	it('log a Tag Manager version only when it differs from the one stored before', () => {
		const v = (before: string | null, versionId: string | null) => logGtmVersion(1, { path: 'accounts/1/containers/2', publicId: 'GTM-A', before, versionId, versionName: 'Add GA4 tag' });
		expect(v(null, '3')).toBeNull(); // first sync: nothing to compare with
		expect(v('3', '3')).toBeNull();
		expect(v('3', '4')).toBeTypeOf('number');
		expect(entries()[0].title).toBe('Tag Manager: version 4 "Add GA4 tag" went live in GTM-A');
	});

	it('note sitemap additions from 3 pages and removals from 10, scoped to their shared folder', () => {
		const blog = (n: number) => Array.from({ length: n }, (_, i) => `https://x.example/blog/2026/post-${i}`);
		expect(logSitemapChanges(1, { added: blog(2), removed: blog(9) }, '2026-11-12')).toEqual([]);
		logSitemapChanges(1, { added: blog(3), removed: ['https://x.example/a', ...blog(9)] }, '2026-11-12');
		expect(entries()).toMatchObject([
			{ date: '2026-11-12', title: '3 new pages in the sitemaps under /blog/2026/', page_prefix: 'https://x.example/blog/2026/' },
			{ title: '10 pages left the sitemaps', page_prefix: null }
		]);
	});

	it('find the shared folder, and none across hosts or at the root', () => {
		expect(commonFolder(['https://x.example/blog/a', 'https://x.example/blog/b/c'])).toBe('https://x.example/blog/');
		expect(commonFolder(['https://x.example/blog/a', 'https://x.example/docs/a'])).toBeNull();
		expect(commonFolder(['https://x.example/blog/a', 'https://y.example/blog/a'])).toBeNull();
	});

	it('are written by the Tag Manager sync when the live version changes between two syncs', async () => {
		setLink(1, 'gtm', { accountId: 1, externalId: 'accounts/1/containers/2', label: 'GTM-A · x' });
		let version = '5';
		const src: GtmSource = {
			listContainers: async () => [{ path: 'accounts/1/containers/2', publicId: 'GTM-A', name: 'x', accountName: 'Acct', domains: ['x.example'], usage: ['web'] }],
			liveVersion: async () => ({ versionId: version, versionName: `v${version}`, tags: [], triggers: [], variables: [] })
		};
		await syncGtm(1, src);
		expect(entries()).toEqual([]);
		version = '6';
		await syncGtm(1, src);
		await syncGtm(1, src);
		expect(entries().map((e) => e.title)).toEqual(['Tag Manager: version 6 "v6" went live in GTM-A']);
	});
});
