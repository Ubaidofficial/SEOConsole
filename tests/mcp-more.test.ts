import { beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleRest } from '../src/lib/server/rest';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { saveGroup } from '../src/lib/server/groups';
import { runAlertRules } from '../src/lib/server/alerts';

let key = '';
let writer = '';
const call = async (tool: string, q: string, k = key) => {
	const r = await handleRest(new Request(`http://x/api/v1/${tool}?${q}`, { headers: { authorization: `Bearer ${k}` } }), tool);
	return { status: r.status, body: (await r.json()) as any };
};

beforeAll(async () => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	delete process.env.DIGEST_WEBHOOK_URL;
	await ensureDemoAccounts();
	const client = new DemoClient('demo-a');
	let guard = 0;
	await syncSite(1, { client, backfillChunkDays: 120 });
	while (!getSite(1)!.backfill_done && guard++ < 12) await syncSite(1, { client, backfillChunkDays: 120 });
	key = createApiKey('more', null).key;
	writer = createApiKey('more-writer', null, null, 'submit').key;
}, 120_000);

describe('the alert, rank-tracking, bucket, update and not-found tools on demo data', () => {
	it('each read tool answers without an error', async () => {
		saveGroup(1, 'bucket', 'Everything', { rules: [{ kind: 'words_min', value: '1' }] });
		await runAlertRules({ siteIds: [1] });
		for (const [tool, q] of [['get_alerts', 'status=all'], ['get_alerts', 'site=1&rules=true'], ['get_rank_tracking', 'site=1'], ['get_keyword_buckets', 'site=1'], ['get_keyword_buckets', 'site=1&kind=pages'], ['get_update_impact', 'site=1'], ['get_not_found_pages', 'site=1']] as const) {
			const r = await call(tool, q);
			expect(r.status, `${tool} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
		}
		const b = await call('get_keyword_buckets', 'site=1');
		const rows = b.body.data.rows as { name: string; members: number }[];
		expect(rows[0].name).toBe('Everything');
		expect(rows[0].members).toBeGreaterThan(0);
		const rules = await call('get_alerts', 'site=1&rules=true');
		expect(rules.body.data.rules.length).toBeGreaterThanOrEqual(10);
	});
	it('track_queries needs the submit level, then adds searches that get_rank_tracking reports', async () => {
		const refused = await handleRest(new Request('http://x/api/v1/track_queries', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ site: '1', add: ['x'] }) }), 'track_queries');
		expect(refused.status).not.toBe(200);
		const ok = await handleRest(new Request('http://x/api/v1/track_queries', { method: 'POST', headers: { authorization: `Bearer ${writer}`, 'content-type': 'application/json' }, body: JSON.stringify({ site: '1', add: ['Some Search', 'another search'] }) }), 'track_queries');
		expect(ok.status).toBe(200);
		const r = await call('get_rank_tracking', 'site=1');
		expect(r.body.data.tracked).toBe(2);
	});
});
