import { db, audit } from './db';
import { accessToken, googleJson, type HttpOptions } from './google';
import { addDays, pacificToday } from './dates';
import { integrationMeta, integrationSecret, listIntegrations } from './links';
import { RealBingClient } from './bing';
import { mcpSession } from './openseo';
import { openSeoCredential } from './openseoauth';
import { GOOGLE_UPDATES_URL } from './gupdates';
import { postWebhook, webhook } from './digest';

/**
 * Live API checks. Most of the app was written from each API's documentation and tested against fakes, so a field Google, Bing or
 * OpenSEO names differently (or renames later) would quietly turn into empty reports. Once a day this makes one small, read-only
 * call per API the app relies on, and checks that the fields the code reads are in the answer. A missing field is "drift": it is
 * logged, put on the Connect page and sent to the digest webhook once. Fields never seen before are logged too, as news.
 *
 * Cost: one URL Inspection (of a site's home page) a day out of the property's allowance, one tiny GA4 report, and a handful of
 * list calls. Nothing is written anywhere except this app's own tables.
 */

export type ProbeStatus = 'ok' | 'drift' | 'error' | 'skipped';
export interface ProbeResult { probe: string; source: string; status: ProbeStatus; message: string; missing: string[]; added: string[] }

interface Probe {
	probe: string;
	source: string;
	/** Key paths the app's code reads. `[]` means "every element"; an empty or absent array cannot be checked and is not drift. */
	expects: string[];
	/** The raw answer, or a string saying why the probe cannot run here (not connected, demo...). */
	run: () => Promise<unknown | { skip: string }>;
}

const MAX_PATHS = 600;

/** Every key path in a JSON value: `a.b`, arrays as `a[]` (merging the first few elements). Depth and count are capped. */
export function keyPaths(v: unknown, prefix = '', depth = 0, out = new Set<string>()): Set<string> {
	if (out.size >= MAX_PATHS || depth > 7 || v == null || typeof v !== 'object') return out;
	if (Array.isArray(v)) {
		const p = `${prefix}[]`;
		out.add(p);
		for (const el of v.slice(0, 5)) keyPaths(el, p, depth + 1, out);
		return out;
	}
	for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
		const p = prefix ? `${prefix}.${k}` : k;
		out.add(p);
		keyPaths(x, p, depth + 1, out);
	}
	return out;
}

/** Which expected paths are missing. A path under an array that is empty or absent in this answer is "unverifiable", not missing. */
export function checkExpected(value: unknown, expects: string[]): { missing: string[]; unverifiable: string[] } {
	const paths = keyPaths(value);
	const missing: string[] = [], unverifiable: string[] = [];
	for (const e of expects) {
		if (paths.has(e)) continue;
		// Each list on the way (not a list at the very end, whose presence is itself the check): if this answer has no element in
		// it, nothing below it can be checked here.
		let blind = false;
		for (let at = e.indexOf('[]'); at >= 0 && at + 2 < e.length; at = e.indexOf('[]', at + 2)) {
			const arr = e.slice(0, at + 2);
			if (![...paths].some((p) => p.startsWith(arr + '.') || p.startsWith(arr + '[]'))) {
				blind = true;
				break;
			}
		}
		(blind ? unverifiable : missing).push(e);
	}
	return { missing, unverifiable };
}

const skip = (why: string) => ({ skip: why });
const isSkip = (v: unknown): v is { skip: string } => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { skip?: unknown }).skip === 'string' && Object.keys(v).length === 1;

/** The first site that can be read live: visible, synced, on an active (not demo) Google account. */
function liveSite(): { id: number; site_url: string; account_id: number } | null {
	return (db()
		.prepare(
			`SELECT s.id, s.site_url, s.account_id FROM sites s JOIN accounts a ON a.id = s.account_id
			 WHERE s.hidden = 0 AND s.deleted_at IS NULL AND a.status = 'active' AND a.is_demo = 0 AND s.permission NOT IN ('siteUnverifiedUser','none') AND s.synced_through IS NOT NULL
			 ORDER BY s.id LIMIT 1`
		)
		.get() as { id: number; site_url: string; account_id: number } | undefined) ?? null;
}

const linkOf = (kind: string) =>
	(db()
		.prepare("SELECT l.site_id, l.account_id, l.integration_id, l.external_id, s.site_url FROM site_links l JOIN sites s ON s.id = l.site_id JOIN integrations i ON i.id = l.integration_id WHERE l.kind = ? AND s.hidden = 0 AND i.is_demo = 0 ORDER BY l.site_id LIMIT 1")
		.get(kind) as { site_id: number; account_id: number | null; integration_id: number; external_id: string; site_url: string } | undefined) ?? null;
const googleLinkOf = (kind: 'ga4' | 'gtm') =>
	(db()
		.prepare("SELECT l.site_id, l.account_id, l.external_id FROM site_links l JOIN sites s ON s.id = l.site_id JOIN accounts a ON a.id = l.account_id WHERE l.kind = ? AND s.hidden = 0 AND a.status = 'active' AND a.is_demo = 0 ORDER BY l.site_id LIMIT 1")
		.get(kind) as { site_id: number; account_id: number; external_id: string } | undefined) ?? null;

const homeOf = (siteUrl: string) => (siteUrl.startsWith('sc-domain:') ? `https://${siteUrl.slice(10)}/` : siteUrl);

export function probes(o: { fetchImpl?: typeof fetch } = {}): Probe[] {
	const f = o.fetchImpl ?? fetch;
	const http: HttpOptions = { fetchImpl: f, retries: 1 };
	const g = (accountId: number, url: string, init?: RequestInit) => googleJson<unknown>(() => accessToken(accountId), url, init, http);
	const WM = 'https://www.googleapis.com/webmasters/v3';
	const enc = encodeURIComponent;
	const day = addDays(pacificToday(), -4);
	return [
		{
			probe: 'gsc.sites', source: 'Search Console', expects: ['siteEntry[].siteUrl', 'siteEntry[].permissionLevel'],
			run: async () => { const s = liveSite(); return s ? g(s.account_id, `${WM}/sites`) : skip('No live Search Console site.'); }
		},
		{
			probe: 'gsc.searchAnalytics', source: 'Search Console', expects: ['rows[].keys[]', 'rows[].clicks', 'rows[].impressions', 'rows[].ctr', 'rows[].position'],
			run: async () => {
				const s = liveSite();
				if (!s) return skip('No live Search Console site.');
				return g(s.account_id, `${WM}/sites/${enc(s.site_url)}/searchAnalytics/query`, { method: 'POST', body: JSON.stringify({ startDate: addDays(day, -6), endDate: day, dimensions: ['date', 'query', 'page', 'country', 'device'], rowLimit: 1 }) });
			}
		},
		{
			probe: 'gsc.sitemaps', source: 'Search Console', expects: ['sitemap[].path', 'sitemap[].lastSubmitted', 'sitemap[].isPending'],
			run: async () => { const s = liveSite(); return s ? g(s.account_id, `${WM}/sites/${enc(s.site_url)}/sitemaps`) : skip('No live Search Console site.'); }
		},
		{
			probe: 'gsc.urlInspection', source: 'Search Console (URL Inspection)',
			expects: ['inspectionResult.inspectionResultLink', 'inspectionResult.indexStatusResult.verdict', 'inspectionResult.indexStatusResult.coverageState', 'inspectionResult.indexStatusResult.robotsTxtState', 'inspectionResult.indexStatusResult.pageFetchState'],
			run: async () => {
				const s = liveSite();
				if (!s) return skip('No live Search Console site.');
				return g(s.account_id, 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', { method: 'POST', body: JSON.stringify({ inspectionUrl: homeOf(s.site_url), siteUrl: s.site_url, languageCode: 'en-US' }) });
			}
		},
		{
			probe: 'ga4.accountSummaries', source: 'GA4 Admin', expects: ['accountSummaries[].propertySummaries[].property', 'accountSummaries[].propertySummaries[].displayName'],
			run: async () => { const l = googleLinkOf('ga4'); return l ? g(l.account_id, 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=5') : skip('No GA4 property linked.'); }
		},
		{
			probe: 'ga4.dataStreams', source: 'GA4 Admin', expects: ['dataStreams[].webStreamData.measurementId', 'dataStreams[].webStreamData.defaultUri'],
			run: async () => { const l = googleLinkOf('ga4'); return l ? g(l.account_id, `https://analyticsadmin.googleapis.com/v1beta/${l.external_id}/dataStreams`) : skip('No GA4 property linked.'); }
		},
		{
			probe: 'ga4.runReport', source: 'GA4 Data', expects: ['rows[].dimensionValues[].value', 'rows[].metricValues[].value'],
			run: async () => {
				const l = googleLinkOf('ga4');
				if (!l) return skip('No GA4 property linked.');
				return g(l.account_id, `https://analyticsdata.googleapis.com/v1beta/${l.external_id}:runReport`, { method: 'POST', body: JSON.stringify({ dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }], dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }], limit: 3 }) });
			}
		},
		{
			probe: 'gtm.containers', source: 'Tag Manager', expects: ['container[].path', 'container[].publicId', 'container[].usageContext[]'],
			run: async () => {
				const l = googleLinkOf('gtm');
				if (!l) return skip('No Tag Manager container linked.');
				const acct = l.external_id.split('/containers/')[0];
				return g(l.account_id, `https://tagmanager.googleapis.com/tagmanager/v2/${acct}/containers`);
			}
		},
		{
			probe: 'gtm.liveVersion', source: 'Tag Manager', expects: ['tag[].type', 'tag[].tagId', 'tag[].parameter[].key', 'tag[].firingTriggerId[]', 'trigger[].triggerId', 'trigger[].type'],
			run: async () => { const l = googleLinkOf('gtm'); return l ? g(l.account_id, `https://tagmanager.googleapis.com/tagmanager/v2/${l.external_id}/versions:live`) : skip('No Tag Manager container linked.'); }
		},
		{
			probe: 'bing.sites', source: 'Bing Webmaster', expects: ['[].Url', '[].IsVerified'],
			run: async () => { const l = linkOf('bing'); return l ? new RealBingClient(l.integration_id, { fetchImpl: f, retries: 1 }).raw('GetUserSites') : skip('Bing is not connected.'); }
		},
		{
			probe: 'bing.rankAndTraffic', source: 'Bing Webmaster', expects: ['[].Date', '[].Clicks', '[].Impressions'],
			run: async () => { const l = linkOf('bing'); return l ? new RealBingClient(l.integration_id, { fetchImpl: f, retries: 1 }).raw('GetRankAndTrafficStats', { siteUrl: l.external_id }) : skip('Bing is not connected.'); }
		},
		{
			probe: 'bing.submissionQuota', source: 'Bing Webmaster', expects: ['DailyQuota', 'MonthlyQuota'],
			run: async () => { const l = linkOf('bing'); return l ? new RealBingClient(l.integration_id, { fetchImpl: f, retries: 1 }).raw('GetUrlSubmissionQuota', { siteUrl: l.external_id }) : skip('Bing is not connected.'); }
		},
		{
			probe: 'crux.queryRecord', source: 'Chrome UX Report', expects: ['record.metrics.largest_contentful_paint.percentiles.p75', 'record.metrics.interaction_to_next_paint.percentiles.p75', 'record.metrics.cumulative_layout_shift.percentiles.p75', 'record.metrics.largest_contentful_paint.histogram[].density'],
			run: async () => {
				const i = listIntegrations('crux').find((x) => !x.is_demo);
				if (!i) return skip('Core Web Vitals is not connected.');
				const key = integrationSecret<{ apiKey: string }>(i).apiKey;
				const res = await f(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${enc(key)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'https://web.dev', formFactor: 'PHONE' }) });
				if (!res.ok) throw new Error(`Chrome UX Report answered ${res.status}`);
				return res.json();
			}
		},
		{
			probe: 'google.statusIncidents', source: 'Google Search Status Dashboard', expects: ['[].id', '[].service_name', '[].external_desc', '[].begin'],
			run: async () => {
				const res = await f(GOOGLE_UPDATES_URL, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
				if (!res.ok) throw new Error(`Google's status dashboard answered ${res.status}`);
				return res.json();
			}
		},
		{
			probe: 'openseo.list_projects', source: 'OpenSEO', expects: ['projects[].id', 'projects[].name', 'projects[].domain'],
			run: async () => {
				const i = listIntegrations('openseo').find((x) => !x.is_demo);
				if (!i) return skip('OpenSEO is not connected.');
				return (await mcpSession(integrationMeta(i).baseUrl, openSeoCredential(i, f), f)).callTool('list_projects');
			}
		}
	];
}

interface Stored { probe: string; shape: string | null; status: ProbeStatus }

/** Error text without anything that could carry a key (Bing puts its key in the URL; this app's own messages never do). */
const safeMessage = (e: unknown) => (e instanceof Error ? e.message : 'Failed').replace(/(apikey|key)=[^&\s]+/gi, '$1=…').slice(0, 300);

/** Run every probe (or the named ones), store the result, log what changed, and return what was found. */
export async function runContractChecks(o: { fetchImpl?: typeof fetch; only?: string[]; notify?: boolean; now?: number } = {}): Promise<ProbeResult[]> {
	const d = db();
	const now = o.now ?? Date.now();
	const out: ProbeResult[] = [];
	const newDrift: ProbeResult[] = [];
	const get = d.prepare('SELECT probe, shape, status FROM api_contracts WHERE probe = ?');
	const put = d.prepare('INSERT OR REPLACE INTO api_contracts (probe, source, shape, checked_at, ok_at, status, message) VALUES (?,?,?,?,?,?,?)');
	const okAt = d.prepare('SELECT ok_at FROM api_contracts WHERE probe = ?');
	const event = d.prepare('INSERT INTO api_contract_events (at, probe, kind, added, removed, message) VALUES (?,?,?,?,?,?)');
	for (const p of probes(o)) {
		if (o.only && !o.only.includes(p.probe)) continue;
		const before = get.get(p.probe) as Stored | undefined;
		const known = new Set<string>(before?.shape ? (JSON.parse(before.shape) as string[]) : []);
		const prevOk = (okAt.get(p.probe) as { ok_at: number | null } | undefined)?.ok_at ?? null;
		let r: ProbeResult;
		try {
			const value = await p.run();
			if (isSkip(value)) {
				r = { probe: p.probe, source: p.source, status: 'skipped', message: value.skip, missing: [], added: [] };
				put.run(p.probe, p.source, before?.shape ?? null, now, prevOk, 'skipped', value.skip);
			} else {
				const paths = keyPaths(value);
				const { missing, unverifiable } = checkExpected(value, p.expects);
				const added = known.size ? [...paths].filter((x) => !known.has(x)).sort() : [];
				const union = [...new Set([...known, ...paths])].sort().slice(0, MAX_PATHS * 2);
				const status: ProbeStatus = missing.length ? 'drift' : 'ok';
				const message = missing.length ? `Missing: ${missing.join(', ')}` : unverifiable.length ? `OK; not checkable in this answer (empty list): ${unverifiable.join(', ')}` : 'OK';
				r = { probe: p.probe, source: p.source, status, message, missing, added };
				put.run(p.probe, p.source, JSON.stringify(union), now, status === 'ok' ? now : prevOk, status, message);
				if (!before?.shape) event.run(now, p.probe, 'baseline', JSON.stringify([...paths].sort().slice(0, 200)), null, null);
				else if (added.length) event.run(now, p.probe, 'new-fields', JSON.stringify(added.slice(0, 100)), null, null);
				if (status === 'drift' && before?.status !== 'drift') (event.run(now, p.probe, 'drift', null, JSON.stringify(missing), message), newDrift.push(r));
				if (status === 'ok' && (before?.status === 'drift' || before?.status === 'error')) event.run(now, p.probe, 'recovered', null, null, null);
			}
		} catch (e) {
			const message = safeMessage(e);
			r = { probe: p.probe, source: p.source, status: 'error', message, missing: [], added: [] };
			put.run(p.probe, p.source, before?.shape ?? null, now, prevOk, 'error', message);
			if (before?.status !== 'error') event.run(now, p.probe, 'error', null, null, message);
		}
		out.push(r);
	}
	// Only a new drift is logged and announced (an ongoing one was announced when it started).
	if (newDrift.length) audit('contracts.drift', { detail: newDrift.map((r) => `${r.probe}: ${r.missing.join(', ')}`).join('; ').slice(0, 1000) });
	if (o.notify !== false && newDrift.length && webhook().url) {
		const text = `SEOConsole: an API answer changed shape. ${newDrift.map((r) => `${r.source} (${r.probe}) no longer has ${r.missing.join(', ')}`).join('; ')}. Reports built on these fields may be empty until the code is updated.`;
		await postWebhook(text, { apiChecks: newDrift }, o.fetchImpl).catch(() => {});
	}
	return out;
}

export interface ContractRow { probe: string; source: string; status: ProbeStatus; message: string | null; checkedAt: number; okAt: number | null }
export const contractStatus = (): ContractRow[] =>
	(db().prepare('SELECT probe, source, status, message, checked_at, ok_at FROM api_contracts ORDER BY source, probe').all() as { probe: string; source: string; status: ProbeStatus; message: string | null; checked_at: number; ok_at: number | null }[]).map((r) => ({
		probe: r.probe, source: r.source, status: r.status, message: r.message, checkedAt: r.checked_at, okAt: r.ok_at
	}));

export const contractEvents = (limit = 30) =>
	(db().prepare('SELECT at, probe, kind, added, removed, message FROM api_contract_events WHERE kind != \'baseline\' ORDER BY at DESC, id DESC LIMIT ?').all(limit) as { at: number; probe: string; kind: string; added: string | null; removed: string | null; message: string | null }[]).map((e) => ({
		at: e.at, probe: e.probe, kind: e.kind, added: e.added ? (JSON.parse(e.added) as string[]) : [], removed: e.removed ? (JSON.parse(e.removed) as string[]) : [], message: e.message
	}));
