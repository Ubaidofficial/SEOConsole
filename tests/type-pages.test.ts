import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { pullTypePages, TYPE_PAGE_LIMIT } from '../src/lib/server/sync';
import { typePagesFor } from '../src/lib/server/queries';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';
import { PERIODS } from '../src/lib/periods';
import type { GscClient, QueryBody, SearchRow } from '../src/lib/server/google';

const TODAY = '2026-11-20';
const row = (page: string, clicks: number): SearchRow => ({ keys: [page], clicks, impressions: clicks * 20, ctr: 0.05, position: 0 });

function fake(answer: (b: QueryBody) => SearchRow[]): GscClient & { bodies: QueryBody[] } {
	const bodies: QueryBody[] = [];
	return { bodies, query: async (_u: string, b: QueryBody) => (bodies.push(b), answer(b)) } as never;
}

beforeEach(async () => {
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
	db().prepare('DELETE FROM site_daily_type WHERE site_id = 1').run();
	db().prepare("INSERT INTO site_daily_type (site_id, search_type, date, clicks, impressions, position) VALUES (1, 'discover', '2026-11-01', 40, 900, 0)").run();
});

describe('pages per search type', () => {
	it('asks only for types with traffic, by page, for each window and the one before it', async () => {
		const c = fake((b) => (b.endDate === TODAY ? [row('https://x.com/viral', 30), row('https://x.com/steady', 5)] : [row('https://x.com/steady', 6), row('https://x.com/old', 50)]));
		const r = await pullTypePages(c, 1, 'sc-domain:x.com', TODAY);
		expect(r).toEqual({ types: ['discover'], failed: [] });
		expect(new Set(c.bodies.map((b) => b.type))).toEqual(new Set(['discover']));
		expect(c.bodies[0]).toMatchObject({ dimensions: ['page'], rowLimit: TYPE_PAGE_LIMIT, startDate: '2026-11-14', endDate: TODAY });
		expect(c.bodies[1]).toMatchObject({ startDate: '2026-11-07', endDate: '2026-11-13' });
		const t = typePagesFor(1, 7);
		expect(t.pulledOn).toBe(TODAY);
		const d = t.types.discover!;
		expect(d.hasPrev).toBe(true);
		expect(d.rows.map((x) => [x.page, x.clicks, x.prevClicks])).toEqual([
			['https://x.com/viral', 30, 0],
			['https://x.com/steady', 5, 6]
		]);
		expect(d.rows[0].clicksDelta).toBeNull(); // no clicks before: new, not an infinite change
		expect(d.rows[1].clicksDelta).toBeCloseTo(5 / 6 - 1);
		// the longest window reaches Google's retention horizon: no previous window, no change figures
		const longest = typePagesFor(1, PERIODS[PERIODS.length - 1]).types.discover!;
		expect(longest.hasPrev).toBe(false);
		expect(longest.rows.every((x) => x.prevClicks === null)).toBe(true);
	});

	it('once a day; a refused type is retried next time and keeps its old rows', async () => {
		const ok = fake(() => [row('https://x.com/a', 3)]);
		await pullTypePages(ok, 1, 'sc-domain:x.com', TODAY);
		const again = fake(() => [row('https://x.com/b', 3)]);
		expect(await pullTypePages(again, 1, 'sc-domain:x.com', TODAY)).toEqual({ types: [], failed: [] });
		expect(again.bodies).toHaveLength(0);
		const refused = fake(() => {
			throw new Error('403');
		});
		expect(await pullTypePages(refused, 1, 'sc-domain:x.com', '2026-11-21')).toEqual({ types: [], failed: ['discover'] });
		expect(typePagesFor(1, 28).types.discover!.rows[0].page).toBe('https://x.com/a');
		expect((db().prepare('SELECT type_pages_on d FROM sites WHERE id = 1').get() as { d: string }).d).toBe(TODAY);
	});

	it('get_search_types view=pages answers for one type', async () => {
		await pullTypePages(fake((b) => (b.endDate === TODAY ? [row('https://x.com/viral', 30)] : [])), 1, 'sc-domain:x.com', TODAY);
		const { key } = createApiKey('t', null);
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_search_types', arguments: { site: '1', view: 'pages', type: 'discover', days: 7 } } }) }));
		const out = (await res.json()).result;
		expect(out.isError, out.content[0].text).toBeFalsy();
		const body = JSON.parse(out.content[0].text);
		expect(body.pages[0]).toMatchObject({ page: 'https://x.com/viral', clicks: 30, previousClicks: 0, change: null });
		expect(body.pages[0]).not.toHaveProperty('position');
	});
});
