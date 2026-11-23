import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { connectClarity } from '../src/lib/server/connect';
import { syncClarity } from '../src/lib/server/channels';
import { clarityByDimension, clarityDashboardUrl } from '../src/lib/claritydims';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';

describe('Clarity rows by dimension', () => {
	it('reads sessions and behaviour shares per value, matching the dimension key in any case, and leaves missing metrics null', () => {
		const rows = clarityByDimension(
			[
				{ metricName: 'Traffic', information: [{ Channel: 'Organic search', totalSessionCount: '400', totalBotSessionCount: '20' }, { Channel: 'Social', totalSessionCount: '100', totalBotSessionCount: '1' }] },
				{ metricName: 'RageClickCount', information: [{ channel: 'Social', sessionsCount: '9', sessionsWithMetricPercentage: 9 }] },
				{ metricName: 'ScrollDepth', information: [{ Channel: 'Organic search', averageScrollDepth: 55.5 }] },
				{ metricName: 'EngagementTime', information: [{ Channel: 'Organic search', totalTime: 300, activeTime: 80 }] },
				{ metricName: 'Traffic', information: [{ OS: 'Android', totalSessionCount: '5' }] }
			],
			'Channel'
		);
		expect(rows).toEqual([
			{ value: 'Organic search', sessions: 400, botSessions: 20, rageClicks: null, deadClicks: null, quickBacks: null, scriptErrors: null, scrollDepth: 0.555, activeTime: 80 },
			{ value: 'Social', sessions: 100, botSessions: 1, rageClicks: 0.09, deadClicks: null, quickBacks: null, scriptErrors: null, scrollDepth: null, activeTime: null }
		]);
	});

	it('links to the project only when the ID looks like a Clarity project ID', () => {
		expect(clarityDashboardUrl('abc123xyz9')).toBe('https://clarity.microsoft.com/projects/view/abc123xyz9/dashboard');
		expect(clarityDashboardUrl('../evil')).toBe('https://clarity.microsoft.com/projects');
		expect(clarityDashboardUrl(null)).toBe('https://clarity.microsoft.com/projects');
	});
});

describe('Channel in the sync and MCP', () => {
	beforeEach(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
	});

	it('the second refresh reads Channel instead of Device, and get_clarity_snapshot summarises it', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2026-11-09T00:30:00Z'));
			await ensureDemoAccounts();
			await connectClarity(1, 'demo');
			await syncClarity(1);
			vi.setSystemTime(new Date('2026-11-09T09:00:00Z'));
			await syncClarity(1);
		} finally {
			vi.useRealTimers();
		}
		const dims = (db().prepare('SELECT dimension FROM clarity_snapshots WHERE site_id = 1 ORDER BY dimension').all() as { dimension: string }[]).map((r) => r.dimension);
		expect(dims).toEqual(['', 'Channel', 'Device', 'URL']);
		const { key } = createApiKey('t', null);
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_clarity_snapshot', arguments: { site: '1', dimension: 'Channel' } } }) }));
		const out = (await res.json()).result;
		expect(out.isError, out.content[0].text).toBeFalsy();
		const body = JSON.parse(out.content[0].text);
		expect(body.clarityUrl).toMatch(/^https:\/\/clarity\.microsoft\.com\/projects/);
		const social = body.byChannel.find((c: { channel: string }) => c.channel === 'Social');
		const organic = body.byChannel.find((c: { channel: string }) => c.channel === 'Organic search');
		expect(organic.sessions).toBeGreaterThan(social.sessions);
		expect(parseFloat(social.rageClicks)).toBeGreaterThan(parseFloat(organic.rageClicks));
	});
});
