import { googleJson, accessToken, type HttpOptions } from './google';
import { assistantOf, GA4_SOURCE_PATTERN, type Assistant } from '../ai';

/** Endpoints and scopes verified against Google's GA4 docs. */
const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
const DATA = 'https://analyticsdata.googleapis.com/v1beta';
export const SCOPE_GA4 = 'https://www.googleapis.com/auth/analytics.readonly';

export interface Ga4Property { property: string; displayName: string; account: string }
export interface Ga4Day { date: string; channel: string; sessions: number; engagedSessions: number; users: number; keyEvents: number; pageviews: number }

const tok = (accountId: number) => () => accessToken(accountId);

export async function listProperties(accountId: number, http: HttpOptions = {}): Promise<Ga4Property[]> {
	const out: Ga4Property[] = [];
	let pageToken = '';
	do {
		const q = new URLSearchParams({ pageSize: '200', ...(pageToken ? { pageToken } : {}) });
		const r = await googleJson<{
			accountSummaries?: { displayName?: string; propertySummaries?: { property: string; displayName: string }[] }[];
			nextPageToken?: string;
		}>(tok(accountId), `${ADMIN}/accountSummaries?${q}`, {}, http);
		for (const a of r.accountSummaries ?? []) for (const p of a.propertySummaries ?? []) out.push({ property: p.property, displayName: p.displayName, account: a.displayName ?? '' });
		pageToken = r.nextPageToken ?? '';
	} while (pageToken);
	return out;
}

/**
 * Website URLs of a property's web data streams, used to auto-match a property to a site.
 * `webStreamData.defaultUri` is not shown on the docs page I could fetch; if the field is absent
 * this returns [] and the UI falls back to manual selection.
 */
export async function webStreamUrls(accountId: number, property: string, http: HttpOptions = {}): Promise<string[]> {
	const r = await googleJson<{ dataStreams?: { webStreamData?: { defaultUri?: string } }[] }>(tok(accountId), `${ADMIN}/${property}/dataStreams`, {}, http);
	return (r.dataStreams ?? []).map((s) => s.webStreamData?.defaultUri).filter((u): u is string => !!u);
}

/**
 * Measurement IDs (G-XXXXXXX) of a property's web data streams, used to check that the Tag Manager container sends data to
 * the property that is linked here. `webStreamData.measurementId` comes from my reading of the Admin API's DataStream
 * resource and is not confirmed against a live response; if absent this returns [] and the cross-check is skipped.
 */
export async function webStreamMeasurementIds(accountId: number, property: string, http: HttpOptions = {}): Promise<string[]> {
	const r = await googleJson<{ dataStreams?: { webStreamData?: { measurementId?: string } }[] }>(tok(accountId), `${ADMIN}/${property}/dataStreams`, {}, http);
	return (r.dataStreams ?? []).map((s) => s.webStreamData?.measurementId).filter((m): m is string => !!m);
}

const ymd = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

/** Daily sessions etc. by default channel group. `date` values come back as YYYYMMDD. */
export async function dailyByChannel(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<Ga4Day[]> {
	const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
		tok(accountId),
		`${DATA}/${property}:runReport`,
		{
			method: 'POST',
			body: JSON.stringify({
				dateRanges: [{ startDate, endDate }],
				dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
				metrics: ['sessions', 'engagedSessions', 'totalUsers', 'keyEvents', 'screenPageViews'].map((name) => ({ name })),
				limit: 100000
			})
		},
		http
	);
	return (r.rows ?? []).map((row) => {
		const m = row.metricValues.map((v) => Number(v.value));
		return { date: ymd(row.dimensionValues[0].value), channel: row.dimensionValues[1].value, sessions: m[0], engagedSessions: m[1], users: m[2], keyEvents: m[3], pageviews: m[4] };
	});
}

export interface Ga4ChannelUsers { channel: string; users: number }
export interface Ga4Landing { page: string; sessions: number; engagedSessions: number; keyEvents: number }

/**
 * Unique users per channel over a whole window. Daily totalUsers cannot be added across days (a visitor on five days
 * would count five times), so this is a separate report with no date dimension, like GA4's own "Total users".
 */
export async function usersByChannel(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<Ga4ChannelUsers[]> {
	const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
		tok(accountId),
		`${DATA}/${property}:runReport`,
		{
			method: 'POST',
			body: JSON.stringify({
				dateRanges: [{ startDate, endDate }],
				dimensions: [{ name: 'sessionDefaultChannelGroup' }],
				metrics: [{ name: 'totalUsers' }],
				limit: 1000
			})
		},
		http
	);
	return (r.rows ?? []).map((row) => ({ channel: row.dimensionValues[0].value, users: Number(row.metricValues[0].value) }));
}

/** Path of a GA4 landing page: no query string or fragment. "/" stays "/". */
export function landingPath(landing: string): string {
	const path = landing.split(/[?#]/)[0] || '/';
	return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
}

/**
 * Sessions, engaged sessions and key events for landing pages reached from Google organic search, the traffic that
 * Search Console clicks lead to. Rows that differ only by query string are merged.
 */
export async function organicGoogleLanding(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<Ga4Landing[]> {
	const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
		tok(accountId),
		`${DATA}/${property}:runReport`,
		{
			method: 'POST',
			body: JSON.stringify({
				dateRanges: [{ startDate, endDate }],
				dimensions: [{ name: 'landingPagePlusQueryString' }],
				metrics: ['sessions', 'engagedSessions', 'keyEvents'].map((name) => ({ name })),
				dimensionFilter: { filter: { fieldName: 'sessionSourceMedium', stringFilter: { matchType: 'EXACT', value: 'google / organic' } } },
				orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
				limit: 10000
			})
		},
		http
	);
	const merged = new Map<string, Ga4Landing>();
	for (const row of r.rows ?? []) {
		const page = landingPath(row.dimensionValues[0].value);
		const m = row.metricValues.map((v) => Number(v.value));
		const cur = merged.get(page) ?? { page, sessions: 0, engagedSessions: 0, keyEvents: 0 };
		cur.sessions += m[0];
		cur.engagedSessions += m[1];
		cur.keyEvents += m[2];
		merged.set(page, cur);
	}
	return [...merged.values()];
}

export interface Ga4Ai { assistant: Assistant; page: string; sessions: number; engagedSessions: number; keyEvents: number }

/**
 * Sessions that arrived from AI assistants (ChatGPT, Perplexity, Gemini, Claude, Copilot), by landing page. Sources are
 * picked with a regular-expression filter and then named by `assistantOf`; rows it does not recognise are dropped.
 */
export async function aiAssistantTraffic(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<Ga4Ai[]> {
	const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
		tok(accountId),
		`${DATA}/${property}:runReport`,
		{
			method: 'POST',
			body: JSON.stringify({
				dateRanges: [{ startDate, endDate }],
				dimensions: [{ name: 'sessionSource' }, { name: 'landingPagePlusQueryString' }],
				metrics: ['sessions', 'engagedSessions', 'keyEvents'].map((name) => ({ name })),
				dimensionFilter: { filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'PARTIAL_REGEXP', value: GA4_SOURCE_PATTERN, caseSensitive: false } } },
				orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
				limit: 10000
			})
		},
		http
	);
	const merged = new Map<string, Ga4Ai>();
	for (const row of r.rows ?? []) {
		const assistant = assistantOf(row.dimensionValues[0].value);
		if (!assistant) continue;
		const page = landingPath(row.dimensionValues[1].value);
		const m = row.metricValues.map((v) => Number(v.value));
		const key = `${assistant}\n${page}`;
		const cur = merged.get(key) ?? { assistant, page, sessions: 0, engagedSessions: 0, keyEvents: 0 };
		cur.sessions += m[0];
		cur.engagedSessions += m[1];
		cur.keyEvents += m[2];
		merged.set(key, cur);
	}
	return [...merged.values()];
}

/** Breakdowns stored by day, so any period (24h included) can be summed: GA4 dimension name → what the app calls it. */
export const GA4_DIMS = { country: 'country', deviceCategory: 'device', newVsReturning: 'visitor' } as const;
export type Ga4Dim = keyof typeof GA4_DIMS;
export interface Ga4DimDay { date: string; value: string; sessions: number; engagedSessions: number; keyEvents: number; pageviews: number }

/**
 * Sessions, engaged sessions, key events and views by day for one dimension (country, device category, new vs returning). Paged
 * (100,000 rows a request); a load past the cap throws rather than storing a partial history whose newest days are missing.
 */
export async function dailyByDimension(accountId: number, property: string, dim: Ga4Dim, startDate: string, endDate: string, http: HttpOptions = {}): Promise<Ga4DimDay[]> {
	const LIMIT = 100_000;
	const MAX_ROWS = 400_000;
	const out: Ga4DimDay[] = [];
	for (let offset = 0; offset < MAX_ROWS; offset += LIMIT) {
		const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
			tok(accountId),
			`${DATA}/${property}:runReport`,
			{
				method: 'POST',
				body: JSON.stringify({
					dateRanges: [{ startDate, endDate }],
					dimensions: [{ name: 'date' }, { name: dim }],
					metrics: ['sessions', 'engagedSessions', 'keyEvents', 'screenPageViews'].map((name) => ({ name })),
					orderBys: [{ dimension: { dimensionName: 'date' } }, { dimension: { dimensionName: dim } }],
					limit: LIMIT,
					offset
				})
			},
			http
		);
		const rows = r.rows ?? [];
		for (const row of rows) {
			const m = row.metricValues.map((v) => Number(v.value));
			out.push({ date: ymd(row.dimensionValues[0].value), value: row.dimensionValues[1].value || '(not set)', sessions: m[0], engagedSessions: m[1], keyEvents: m[2], pageviews: m[3] });
		}
		if (rows.length < LIMIT) return out;
	}
	throw new Error(`GA4 returned more than ${MAX_ROWS.toLocaleString('en-US')} ${dim} rows for ${startDate} to ${endDate}.`);
}

export interface Ga4PageViewDay { date: string; page: string; views: number }

/**
 * Page views by day and page path, every channel: GA4's "Views by page" over time, so any period can be summed. Paths that differ
 * only by query string are merged. Paged like dailyByDimension; above `maxRows` the oldest days are dropped and `truncated` is set.
 */
export async function pageViewsDaily(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}, maxRows = 500_000): Promise<{ rows: Ga4PageViewDay[]; truncated: boolean }> {
	const LIMIT = 100_000;
	const merged = new Map<string, Ga4PageViewDay>();
	let fetched = 0;
	for (let offset = 0; ; offset += LIMIT) {
		const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
			tok(accountId),
			`${DATA}/${property}:runReport`,
			{
				method: 'POST',
				body: JSON.stringify({
					dateRanges: [{ startDate, endDate }],
					dimensions: [{ name: 'date' }, { name: 'pagePath' }],
					metrics: [{ name: 'screenPageViews' }],
					// Newest days first, so a cut at the row limit loses the oldest days, not the ones people look at.
					orderBys: [{ dimension: { dimensionName: 'date' }, desc: true }, { metric: { metricName: 'screenPageViews' }, desc: true }],
					limit: LIMIT,
					offset
				})
			},
			http
		);
		const rows = r.rows ?? [];
		for (const row of rows) {
			const date = ymd(row.dimensionValues[0].value);
			const page = landingPath(row.dimensionValues[1].value || '/');
			const k = `${date} ${page}`;
			const cur = merged.get(k) ?? { date, page, views: 0 };
			cur.views += Number(row.metricValues[0].value);
			merged.set(k, cur);
		}
		fetched += rows.length;
		if (rows.length < LIMIT) return { rows: [...merged.values()], truncated: false };
		if (fetched >= maxRows) return { rows: [...merged.values()], truncated: true };
	}
}

/** The title GA4 recorded most often for each page path over a window (the "Page title" in GA4's pages report). */
export async function pageTitles(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<{ page: string; title: string }[]> {
	const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
		tok(accountId),
		`${DATA}/${property}:runReport`,
		{
			method: 'POST',
			body: JSON.stringify({
				dateRanges: [{ startDate, endDate }],
				dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
				metrics: [{ name: 'screenPageViews' }],
				orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
				limit: 25_000
			})
		},
		http
	);
	const best = new Map<string, string>();
	// Rows come busiest first, so the first title seen for a path is the one GA4 recorded most.
	for (const row of r.rows ?? []) {
		const page = landingPath(row.dimensionValues[0].value || '/');
		const title = (row.dimensionValues[1].value ?? '').trim();
		if (title && title !== '(not set)' && !best.has(page)) best.set(page, title.slice(0, 300));
	}
	return [...best].map(([page, title]) => ({ page, title }));
}

/** Unique active and new users over one whole window, GA4's own "Active users" / "New users" (not a sum of days). */
export async function usersTotal(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<{ activeUsers: number; newUsers: number }> {
	const r = await googleJson<{ rows?: { metricValues: { value: string }[] }[] }>(
		tok(accountId),
		`${DATA}/${property}:runReport`,
		{ method: 'POST', body: JSON.stringify({ dateRanges: [{ startDate, endDate }], metrics: [{ name: 'activeUsers' }, { name: 'newUsers' }] }) },
		http
	);
	const m = r.rows?.[0]?.metricValues ?? [];
	return { activeUsers: Number(m[0]?.value ?? 0), newUsers: Number(m[1]?.value ?? 0) };
}

export interface Ga4EventDay { date: string; event: string; keyEvents: number; eventCount: number }

/**
 * Key events by day and event name (sign_up, purchase, …): which conversions happen, not just how many. Only events marked as key
 * events in GA4 have a non-zero `keyEvents`, so the rest are filtered out on GA4's side. Paged like dailyByDimension.
 */
export async function keyEventsDaily(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<Ga4EventDay[]> {
	const LIMIT = 100_000;
	const MAX_ROWS = 300_000;
	const out: Ga4EventDay[] = [];
	for (let offset = 0; offset < MAX_ROWS; offset += LIMIT) {
		const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
			tok(accountId),
			`${DATA}/${property}:runReport`,
			{
				method: 'POST',
				body: JSON.stringify({
					dateRanges: [{ startDate, endDate }],
					dimensions: [{ name: 'date' }, { name: 'eventName' }],
					metrics: [{ name: 'keyEvents' }, { name: 'eventCount' }],
					metricFilter: { filter: { fieldName: 'keyEvents', numericFilter: { operation: 'GREATER_THAN', value: { doubleValue: 0 } } } },
					orderBys: [{ dimension: { dimensionName: 'date' } }, { dimension: { dimensionName: 'eventName' } }],
					limit: LIMIT,
					offset
				})
			},
			http
		);
		const rows = r.rows ?? [];
		for (const row of rows) out.push({ date: ymd(row.dimensionValues[0].value), event: row.dimensionValues[1].value, keyEvents: Number(row.metricValues[0].value), eventCount: Number(row.metricValues[1].value) });
		if (rows.length < LIMIT) return out;
	}
	throw new Error(`GA4 returned more than ${MAX_ROWS.toLocaleString('en-US')} key-event rows for ${startDate} to ${endDate}.`);
}

export interface Ga4LandingChannel { page: string; channel: string; sessions: number; engagedSessions: number; keyEvents: number }
/** How many landing page × channel rows a window keeps (largest first). */
export const LANDING_ROW_LIMIT = 10_000;

/**
 * Sessions by landing page and channel group over a whole window, every channel (organic, direct, referral, social, email…), so a
 * page that lives on referral or social traffic shows up too. Rows that differ only by query string are merged.
 */
export async function landingAllChannels(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<{ rows: Ga4LandingChannel[]; truncated: boolean }> {
	const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
		tok(accountId),
		`${DATA}/${property}:runReport`,
		{
			method: 'POST',
			body: JSON.stringify({
				dateRanges: [{ startDate, endDate }],
				dimensions: [{ name: 'landingPagePlusQueryString' }, { name: 'sessionDefaultChannelGroup' }],
				metrics: ['sessions', 'engagedSessions', 'keyEvents'].map((name) => ({ name })),
				orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
				limit: LANDING_ROW_LIMIT
			})
		},
		http
	);
	const merged = new Map<string, Ga4LandingChannel>();
	for (const row of r.rows ?? []) {
		const page = landingPath(row.dimensionValues[0].value);
		const channel = row.dimensionValues[1].value;
		const m = row.metricValues.map((v) => Number(v.value));
		const k = `${page}\n${channel}`;
		const cur = merged.get(k) ?? { page, channel, sessions: 0, engagedSessions: 0, keyEvents: 0 };
		cur.sessions += m[0];
		cur.engagedSessions += m[1];
		cur.keyEvents += m[2];
		merged.set(k, cur);
	}
	return { rows: [...merged.values()], truncated: (r.rows?.length ?? 0) >= LANDING_ROW_LIMIT };
}

export interface Ga4RealtimeRow { event: string; count: number }

/**
 * Events in the last 30 minutes (GA4 Realtime, runRealtimeReport; analytics.readonly), by event name, largest first: the quick way to see
 * that a newly published tag sends what it should, minutes after publishing, while the normal reports take up to a day.
 */
export async function realtimeEvents(accountId: number, property: string, http: HttpOptions = {}): Promise<Ga4RealtimeRow[]> {
	const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
		tok(accountId),
		`${DATA}/${property}:runRealtimeReport`,
		{ method: 'POST', body: JSON.stringify({ dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }], orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 250 }) },
		http
	);
	return (r.rows ?? []).map((row) => ({ event: row.dimensionValues[0].value, count: Number(row.metricValues[0].value) }));
}

export interface Ga4RealtimeUsers {
	/** Active users in the last 30 minutes (GA4 Realtime activeUsers). */
	total: number;
	/** By page title: Realtime has no page path, only unifiedScreenName (the title on the web). */
	pages: { title: string; users: number; views: number }[];
	countries: { country: string; users: number }[];
	devices: { device: string; users: number }[];
	/** Active users per minute, 0 = this minute, up to 29. */
	minutes: { minutesAgo: number; users: number }[];
}

/**
 * Who is on the site right now (GA4 Realtime, last 30 minutes): active users in total and by page title, country, device and minute. Five
 * small Realtime requests, read live. A user can appear under several pages, so the breakdowns need not add up to the total.
 */
export async function realtimeUsers(accountId: number, property: string, http: HttpOptions = {}): Promise<Ga4RealtimeUsers> {
	type R = { rows?: { dimensionValues?: { value: string }[]; metricValues: { value: string }[] }[] };
	const run = (body: object) => googleJson<R>(tok(accountId), `${DATA}/${property}:runRealtimeReport`, { method: 'POST', body: JSON.stringify(body) }, http);
	const by = (dim: string, metrics = ['activeUsers'], limit = 50) => run({ dimensions: [{ name: dim }], metrics: metrics.map((name) => ({ name })), orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }], limit });
	const [total, pages, countries, devices, minutes] = await Promise.all([
		run({ metrics: [{ name: 'activeUsers' }] }),
		by('unifiedScreenName', ['activeUsers', 'screenPageViews']),
		by('country'),
		by('deviceCategory', ['activeUsers'], 10),
		run({ dimensions: [{ name: 'minutesAgo' }], metrics: [{ name: 'activeUsers' }], limit: 30 })
	]);
	const v = (x: { value: string } | undefined) => Number(x?.value) || 0;
	const dim = (row: NonNullable<R['rows']>[number]) => row.dimensionValues?.[0]?.value || '(not set)';
	return {
		total: v(total.rows?.[0]?.metricValues[0]),
		pages: (pages.rows ?? []).map((r) => ({ title: dim(r), users: v(r.metricValues[0]), views: v(r.metricValues[1]) })),
		countries: (countries.rows ?? []).map((r) => ({ country: dim(r), users: v(r.metricValues[0]) })),
		devices: (devices.rows ?? []).map((r) => ({ device: dim(r), users: v(r.metricValues[0]) })),
		minutes: (minutes.rows ?? []).map((r) => ({ minutesAgo: Number(dim(r)) || 0, users: v(r.metricValues[0]) })).sort((a, b) => a.minutesAgo - b.minutesAgo)
	};
}

export interface Ga4SourceRow { source: string; medium: string; channel: string; sessions: number; engagedSessions: number; keyEvents: number }

/** How many source / medium rows a window keeps: the long tail past this is a handful of sessions each. */
export const SOURCE_ROW_LIMIT = 1000;

/**
 * Sessions by source and medium (with the channel group GA4 put them in) over a whole window: which sites, newsletters and
 * campaigns send traffic, e.g. `example.com / referral`. Every channel, Direct included, so a link that arrives without a referrer
 * is visible as `(direct) / (none)` rather than missing. The largest SOURCE_ROW_LIMIT rows by sessions.
 */
export async function trafficSources(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<Ga4SourceRow[]> {
	const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
		tok(accountId),
		`${DATA}/${property}:runReport`,
		{
			method: 'POST',
			body: JSON.stringify({
				dateRanges: [{ startDate, endDate }],
				dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }, { name: 'sessionDefaultChannelGroup' }],
				metrics: ['sessions', 'engagedSessions', 'keyEvents'].map((name) => ({ name })),
				orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
				limit: SOURCE_ROW_LIMIT
			})
		},
		http
	);
	return (r.rows ?? []).map((row) => {
		const m = row.metricValues.map((v) => Number(v.value));
		return { source: row.dimensionValues[0].value, medium: row.dimensionValues[1].value, channel: row.dimensionValues[2].value, sessions: m[0], engagedSessions: m[1], keyEvents: m[2] };
	});
}

export interface Ga4PageDay { date: string; page: string; sessions: number; keyEvents: number }

/**
 * Google-organic sessions and key events by day and landing page: what an SEO test needs to be judged on conversions as well as
 * clicks. Paged (100,000 rows a request, 600,000 in all) and merged by landing path, so query-string variants of a page count once.
 */
export async function organicLandingDaily(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<Ga4PageDay[]> {
	const LIMIT = 100_000;
	const MAX_ROWS = 600_000;
	const merged = new Map<string, Ga4PageDay>();
	for (let offset = 0; offset < MAX_ROWS; offset += LIMIT) {
		const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
			tok(accountId),
			`${DATA}/${property}:runReport`,
			{
				method: 'POST',
				body: JSON.stringify({
					dateRanges: [{ startDate, endDate }],
					dimensions: [{ name: 'date' }, { name: 'landingPagePlusQueryString' }],
					metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
					dimensionFilter: { filter: { fieldName: 'sessionSourceMedium', stringFilter: { matchType: 'EXACT', value: 'google / organic' } } },
					orderBys: [{ dimension: { dimensionName: 'date' } }, { dimension: { dimensionName: 'landingPagePlusQueryString' } }],
					limit: LIMIT,
					offset
				})
			},
			http
		);
		const rows = r.rows ?? [];
		for (const row of rows) {
			const date = ymd(row.dimensionValues[0].value);
			const page = landingPath(row.dimensionValues[1].value);
			const k = `${date}\n${page}`;
			const cur = merged.get(k) ?? { date, page, sessions: 0, keyEvents: 0 };
			cur.sessions += Number(row.metricValues[0].value);
			cur.keyEvents += Number(row.metricValues[1].value);
			merged.set(k, cur);
		}
		if (rows.length < LIMIT) break;
		// Rows come oldest day first, so stopping here would silently drop the most recent days and read as a collapse after a change.
		if (offset + LIMIT >= MAX_ROWS) throw new Error(`GA4 returned more than ${MAX_ROWS.toLocaleString('en-US')} landing-page rows for ${startDate} to ${endDate}; conversions cannot be judged on a partial load.`);
	}
	return [...merged.values()];
}

export interface Ga4AiDay { date: string; assistant: Assistant; page: string; sessions: number; keyEvents: number }

/**
 * Sessions from AI assistants by day, assistant and landing page: what an LLM test (an SEO test judged on AI-assistant sessions)
 * needs. Same source filter as aiAssistantTraffic, so the same assistants are recognised and the same caveat holds: an assistant
 * that sends no referrer lands in Direct and cannot be counted. Paged like organicLandingDaily; AI traffic is small, so the cap is
 * rarely near.
 */
export async function aiAssistantDaily(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<Ga4AiDay[]> {
	const LIMIT = 100_000;
	const MAX_ROWS = 300_000;
	const merged = new Map<string, Ga4AiDay>();
	for (let offset = 0; offset < MAX_ROWS; offset += LIMIT) {
		const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
			tok(accountId),
			`${DATA}/${property}:runReport`,
			{
				method: 'POST',
				body: JSON.stringify({
					dateRanges: [{ startDate, endDate }],
					dimensions: [{ name: 'date' }, { name: 'sessionSource' }, { name: 'landingPagePlusQueryString' }],
					metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
					dimensionFilter: { filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'PARTIAL_REGEXP', value: GA4_SOURCE_PATTERN, caseSensitive: false } } },
					orderBys: [{ dimension: { dimensionName: 'date' } }, { dimension: { dimensionName: 'sessionSource' } }, { dimension: { dimensionName: 'landingPagePlusQueryString' } }],
					limit: LIMIT,
					offset
				})
			},
			http
		);
		const rows = r.rows ?? [];
		for (const row of rows) {
			const assistant = assistantOf(row.dimensionValues[1].value);
			if (!assistant) continue;
			const date = ymd(row.dimensionValues[0].value);
			const page = landingPath(row.dimensionValues[2].value);
			const k = `${date}\n${assistant}\n${page}`;
			const cur = merged.get(k) ?? { date, assistant, page, sessions: 0, keyEvents: 0 };
			cur.sessions += Number(row.metricValues[0].value);
			cur.keyEvents += Number(row.metricValues[1].value);
			merged.set(k, cur);
		}
		if (rows.length < LIMIT) break;
		// Oldest day first, so a cut-off load would drop the latest days and read as a collapse after the change.
		if (offset + LIMIT >= MAX_ROWS) throw new Error(`GA4 returned more than ${MAX_ROWS.toLocaleString('en-US')} AI-assistant rows for ${startDate} to ${endDate}; the test cannot be judged on a partial load.`);
	}
	return [...merged.values()];
}

/** What a value report is broken down by: GA4 dimension per kind. */
export const VALUE_DIMS = { channel: 'sessionDefaultChannelGroup', landing: 'landingPagePlusQueryString', campaign: 'sessionCampaignName' } as const;
export type Ga4ValueKind = keyof typeof VALUE_DIMS;
/**
 * Sessions with what they were worth: engagement time (seconds, GA4 userEngagementDuration), revenue (totalRevenue: purchases,
 * subscriptions and ad revenue, in the property's currency) and transactions. A property without e-commerce returns 0 revenue.
 */
export interface Ga4ValueRow { key: string; sessions: number; engagedSessions: number; keyEvents: number; engagementSec: number; revenue: number; transactions: number }
/** How many rows a value report keeps, per kind (largest by sessions first). */
export const VALUE_ROW_LIMIT: Record<Ga4ValueKind, number> = { channel: 100, landing: 5000, campaign: 1000 };

/** Sessions, engagement time, revenue and transactions over a whole window, by channel group, landing page or campaign. */
export async function valueReport(accountId: number, property: string, kind: Ga4ValueKind, startDate: string, endDate: string, http: HttpOptions = {}): Promise<{ rows: Ga4ValueRow[]; currency: string | null; truncated: boolean }> {
	const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[]; metadata?: { currencyCode?: string } }>(
		tok(accountId),
		`${DATA}/${property}:runReport`,
		{
			method: 'POST',
			body: JSON.stringify({
				dateRanges: [{ startDate, endDate }],
				dimensions: [{ name: VALUE_DIMS[kind] }],
				metrics: ['sessions', 'engagedSessions', 'keyEvents', 'userEngagementDuration', 'totalRevenue', 'transactions'].map((name) => ({ name })),
				orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
				limit: VALUE_ROW_LIMIT[kind]
			})
		},
		http
	);
	const merged = new Map<string, Ga4ValueRow>();
	for (const row of r.rows ?? []) {
		// Landing pages that differ only by query string are one page, as everywhere else in the app.
		const raw = row.dimensionValues[0].value;
		const key = kind === 'landing' ? landingPath(raw) : raw || '(not set)';
		const m = row.metricValues.map((v) => Number(v.value) || 0);
		const cur = merged.get(key) ?? { key, sessions: 0, engagedSessions: 0, keyEvents: 0, engagementSec: 0, revenue: 0, transactions: 0 };
		cur.sessions += m[0];
		cur.engagedSessions += m[1];
		cur.keyEvents += m[2];
		cur.engagementSec += m[3];
		cur.revenue += m[4];
		cur.transactions += m[5];
		merged.set(key, cur);
	}
	return { rows: [...merged.values()], currency: r.metadata?.currencyCode || null, truncated: (r.rows?.length ?? 0) >= VALUE_ROW_LIMIT[kind] };
}

export interface Ga4SearchTerm { term: string; searches: number; users: number }
export const SEARCH_TERM_LIMIT = 500;

/**
 * What visitors typed into the site's own search box over a window: GA4's searchTerm on view_search_results events, which enhanced
 * measurement records when a results page carries the term in its address (?q=, ?s=, ?search= and similar). [] when site search is not tracked.
 */
export async function siteSearchTerms(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<Ga4SearchTerm[]> {
	const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
		tok(accountId),
		`${DATA}/${property}:runReport`,
		{
			method: 'POST',
			body: JSON.stringify({
				dateRanges: [{ startDate, endDate }],
				dimensions: [{ name: 'searchTerm' }],
				metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
				dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'view_search_results' } } },
				orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
				limit: SEARCH_TERM_LIMIT
			})
		},
		http
	);
	const merged = new Map<string, Ga4SearchTerm>();
	for (const row of r.rows ?? []) {
		const term = row.dimensionValues[0].value.trim().toLowerCase();
		if (!term || term === '(not set)') continue;
		const cur = merged.get(term) ?? { term, searches: 0, users: 0 };
		cur.searches += Number(row.metricValues[0].value) || 0;
		// Users of differently cased spellings can overlap; the larger count is the honest floor.
		cur.users = Math.max(cur.users, Number(row.metricValues[1].value) || 0);
		merged.set(term, cur);
	}
	return [...merged.values()].sort((a, b) => b.searches - a.searches);
}
