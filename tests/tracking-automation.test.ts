import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/lib/server/db';
import { upsertGoogleAccount } from '../src/lib/server/accounts';
import { summarizeVersion } from '../src/lib/server/gtm';
import { checkLiveScript } from '../src/lib/server/gtmlive';
import { realtimeEvents } from '../src/lib/server/ga4';
import { discoverEvents, findEvents, scriptUrls } from '../src/lib/server/datalayer';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const text = (body: string, status = 200) => new Response(body, { status });

describe('consolidated containers', () => {
	it('reads a Google Analytics destination tag (dest_ga) as a GA4 tag, with its ID from destinationId (as exported from a real consolidated container)', () => {
		const live = summarizeVersion({
			containerVersionId: '3',
			name: 'v3',
			tag: [
				{ tagId: '3', name: 'Google Analytics (added by SEOConsole)', type: 'dest_ga', parameter: [{ type: 'boolean', key: 'ignoreDupeGtagConfigCalls', value: 'true' }, { type: 'template', key: 'destinationId', value: 'G-71YY5G1HY9' }], firingTriggerId: ['2147479553'] },
				{ tagId: '10', name: 'GA4 event - job_alert_signup (added by SEOConsole)', type: 'gaawe', parameter: [{ type: 'template', key: 'eventName', value: 'job_alert_signup' }, { type: 'template', key: 'measurementIdOverride', value: 'G-71YY5G1HY9' }], firingTriggerId: ['9'] }
			]
		} as never);
		expect(live.tags.map((t) => [t.type, t.measurementId, t.badTagId])).toEqual([
			['dest_ga', 'G-71YY5G1HY9', null],
			['gaawe', 'G-71YY5G1HY9', null]
		]);
	});
});

describe('is it live?', () => {
	it('confirms when the served container script contains what was published, says "not yet" otherwise, and never throws', async () => {
		const f = vi.fn(async () => text('…"vtp_eventName":"job_alert_signup","vtp_measurementIdOverride":"G-71YY5G1HY9"…'));
		expect(await checkLiveScript('GTM-PV6WJZ8J', ['job_alert_signup', 'G-71YY5G1HY9'], { fetchImpl: f as never })).toMatchObject({ state: 'confirmed', missing: [] });
		expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://www.googletagmanager.com/gtm.js?id=GTM-PV6WJZ8J');
		expect(await checkLiveScript('GTM-PV6WJZ8J', ['sign_up'], { fetchImpl: (async () => text('nothing')) as never })).toMatchObject({ state: 'not-yet', missing: ['sign_up'] });
		expect((await checkLiveScript('GTM-PV6WJZ8J', ['x'], { fetchImpl: (async () => { throw new Error('offline'); }) as never })).state).toBe('unknown');
		expect((await checkLiveScript('G-123', ['x'])).state).toBe('unknown');
	});
});

describe('GA4 Realtime', () => {
	it('asks for event counts by name over the realtime window', async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		const id = upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.readonly' });
		let url = '', body: Record<string, any> = {};
		const f = vi.fn(async (u: string, init?: RequestInit) => ((url = u), (body = JSON.parse(String(init?.body))), json({ rows: [{ dimensionValues: [{ value: 'job_alert_signup' }], metricValues: [{ value: '3' }] }] })));
		expect(await realtimeEvents(id, 'properties/5', { fetchImpl: f as never })).toEqual([{ event: 'job_alert_signup', count: 3 }]);
		expect(url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/5:runRealtimeReport');
		expect(body.dimensions).toEqual([{ name: 'eventName' }]);
		expect(body.metrics).toEqual([{ name: 'eventCount' }]);
	});
});

describe('finding dataLayer events in a site\'s scripts', () => {
	// shaped like the real 6figjobs bundle: a helper that pushes {event, ...params}, called with the event name and its parameters
	const helper = `71195:(e,t,n)=>{function l(e,t={}){try{let n=window;n.dataLayer=n.dataLayer||[],n.dataLayer.push({event:e,...t})}catch{}}n.d(t,{x:()=>l})},95376:(e,t,n)=>{t.ok&&l.ok?(A({kind:"done"}),(0,_.x)("job_alert_signup",{alert_form:n,alert_frequency:S,alert_has_role:!!i||!!e.roleSlugs?.length,alert_remote:J||!!(e.remoteMode||e.remoteOnly)}),c?.()):A({kind:"error"});u("format_date",{a:1})}`;

	it('finds a helper-pushed event with its parameters, and literal pushes with quoted keys', () => {
		// only calls of the helper count: u("format_date", {…}) in the same code is not an event
		expect(findEvents(helper, 'app.js')).toEqual([{ event: 'job_alert_signup', params: ['alert_form', 'alert_frequency', 'alert_has_role', 'alert_remote'], how: 'helper', where: 'app.js' }]);
		// a helper defined in one script and called through its exported alias from another
		const definer = `n.d(t,{x:()=>l});function l(e,t={}){window.dataLayer.push({event:e,...t})}`;
		const caller = `(0,r.x)("quote_request",{product:p});(0,r.y)("not_this",{a:1})`;
		expect(findEvents(caller, 'b.js')).toEqual([]);
		expect(findEvents(caller, 'b.js', ['x'])).toEqual([{ event: 'quote_request', params: ['product'], how: 'helper', where: 'b.js' }]);
		expect(findEvents(definer, 'a.js')).toEqual([]);
		const literal = findEvents(`window.dataLayer = window.dataLayer || []; window.dataLayer.push({ "event": "newsletter_signup", "form_location": "footer", plan: p ? "pro" : "free" });`, 'inline');
		expect(literal).toEqual([{ event: 'newsletter_signup', params: ['form_location', 'plan'], how: 'push', where: 'inline' }]);
	});

	it('ignores events Tag Manager and GA4 send themselves, code without a dataLayer, and snake_case calls when there is no helper', () => {
		expect(findEvents(`dataLayer.push({event:"gtm.js"});dataLayer.push({event:"page_view"})`, 'x')).toEqual([]);
		expect(findEvents(`track("sign_up",{plan:1})`, 'x')).toEqual([]);
		expect(findEvents(`window.dataLayer=[];foo("sign_up",{plan:1})`, 'x')).toEqual([]); // no helper that pushes {event: arg, ...}
	});

	it('reads only the site\'s own scripts, one request at a time', async () => {
		expect(scriptUrls('<script src="/_next/a.js"></script><script src="https://www.googletagmanager.com/gtm.js?id=GTM-1"></script><script async src="https://www.6figjobs.com/b.js"></script>', 'https://www.6figjobs.com/')).toEqual(['https://www.6figjobs.com/_next/a.js', 'https://www.6figjobs.com/b.js']);
		let inFlight = 0, most = 0;
		const f = vi.fn(async (u: string) => {
			most = Math.max(most, ++inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			if (u.endsWith('/')) return text('<script src="/app.js"></script><script src="/missing.js"></script>');
			if (u.endsWith('/app.js')) return text(helper);
			return text('', 404);
		});
		const r = await discoverEvents(['https://www.6figjobs.com/'], { fetchImpl: f as never });
		expect(r.events.map((e) => e.event)).toEqual(['job_alert_signup']);
		expect(r).toMatchObject({ pages: 1, scripts: 2 });
		expect(r.errors[0]).toMatch(/missing\.js: 404/);
		expect(most).toBe(1);
	});
});
