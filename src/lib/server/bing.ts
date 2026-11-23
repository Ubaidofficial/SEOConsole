import { db } from './db';
import { decrypt, encrypt } from './crypto';
import { env } from './config';
import { sleep } from './google';
import { parseCrawlIssues, parseLinkCounts, parseUrlLinks, type BingCrawlIssue, type BingLinkCount, type BingLinkSource } from '../binglinks';

/** Verified against Microsoft Learn (Bing Webmaster API docs). */
const KEY_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';
const OAUTH_BASE = 'https://www.bing.com/webmaster/api.svc/json';
export const BING_AUTHORIZE = 'https://www.bing.com/webmasters/oauth/authorize';
export const BING_TOKEN = 'https://www.bing.com/webmasters/oauth/token';

export class BingApiError extends Error {
	constructor(message: string, readonly status: number, readonly code?: number) {
		super(message);
	}
}

export interface BingSite { url: string; isVerified: boolean }
export interface BingDay { date: string; clicks: number; impressions: number }
export interface BingTermRow { date: string; term: string; clicks: number; impressions: number; clickPos: number | null; imprPos: number | null }

/** The link and crawl methods, apart from BingClient so the clients and fakes written before them stay valid. Free: same API key, no credits. */
export interface BingLinksClient {
	/** Pages of the site with inbound links and how many, all result pages up to `maxPages` (Bing says how many there are). */
	linkCounts(siteUrl: string, maxPages?: number): Promise<{ links: BingLinkCount[]; totalPages: number; truncated: boolean }>;
	/** The pages that link to one of yours, with anchor text. */
	urlLinks(siteUrl: string, link: string, maxPages?: number): Promise<BingLinkSource[]>;
	/** URLs Bing's crawler had trouble with: HTTP code, issue flags, and how many links point at each. */
	crawlIssues(siteUrl: string): Promise<BingCrawlIssue[]>;
}

/** One day of Bing's crawl statistics (GetCrawlStats: the last six months, updated daily). Field names follow Microsoft's CrawlStats class. */
export interface BingCrawlDay {
	date: string;
	crawled: number;
	crawlErrors: number;
	inIndex: number;
	inLinks: number;
	code2xx: number;
	code301: number;
	code302: number;
	code4xx: number;
	code5xx: number;
	otherCodes: number;
	blockedByRobots: number;
	malware: number;
	dnsFailures: number;
	timeouts: number;
}
/** A sitemap or feed Bing knows for the site (GetFeeds: top-level feeds). Dates are null where Bing has none. */
export interface BingFeed { url: string; type: string; status: string; urlCount: number | null; submitted: string | null; lastCrawled: string | null; fileSize: number | null; compressed: boolean }
/** Crawl statistics, sitemaps and queries per page, apart from BingClient so earlier clients and fakes stay valid. Same API key, free. */
export interface BingCrawlClient {
	crawlStats(siteUrl: string): Promise<BingCrawlDay[]>;
	feeds(siteUrl: string): Promise<BingFeed[]>;
	/** The searches that showed one page (GetPageQueryStats, weekly rows). */
	pageQueryStats(siteUrl: string, page: string): Promise<BingTermRow[]>;
	/** Submit a sitemap or feed (SubmitFeed). Throws BingApiError when Bing refuses. */
	submitFeed(siteUrl: string, feedUrl: string): Promise<void>;
}

export interface BingClient {
	listSites(): Promise<BingSite[]>;
	dailyStats(siteUrl: string): Promise<BingDay[]>;
	queryStats(siteUrl: string): Promise<BingTermRow[]>;
	pageStats(siteUrl: string): Promise<BingTermRow[]>;
	/** Tell Bing about URLs (its URL submission API, up to 500 per call). Throws BingApiError when Bing refuses. */
	submitUrlBatch(siteUrl: string, urls: string[]): Promise<void>;
	/** URLs Bing still accepts today and this month; null where Bing did not say. */
	urlSubmissionQuota(siteUrl: string): Promise<{ daily: number | null; monthly: number | null }>;
}

/** Bing takes at most this many URLs in one SubmitUrlBatch call (Microsoft Learn / the Bing webmaster blog). */
export const BING_MAX_URLS_PER_CALL = 500;

/**
 * Bing returns WCF dates like "/Date(1316156400000-0700)/": epoch ms plus the offset the day was
 * bucketed in. Applying the offset recovers the calendar day Bing meant (here 2011-09-16).
 */
export function parseBingDate(s: string): string {
	const m = /\/Date\((-?\d+)(?:([+-])(\d{2})(\d{2}))?\)\//.exec(s);
	if (!m) throw new Error(`Unrecognised Bing date: ${s}`);
	const offMin = m[2] ? (m[2] === '-' ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4])) : 0;
	return new Date(Number(m[1]) + offMin * 60_000).toISOString().slice(0, 10);
}

type Secret = { apiKey?: string; refreshToken?: string; accessToken?: string; expiresAt?: number };
interface HttpOpts { fetchImpl?: typeof fetch; sleepImpl?: (ms: number) => Promise<void>; retries?: number }

export function bingSecret(integrationId: number): Secret {
	const row = db().prepare('SELECT secret_enc FROM integrations WHERE id = ?').get(integrationId) as { secret_enc: string | null } | undefined;
	return row?.secret_enc ? (JSON.parse(decrypt(row.secret_enc)) as Secret) : {};
}

async function bearer(integrationId: number, f: typeof fetch): Promise<string> {
	const s = bingSecret(integrationId);
	if (s.accessToken && s.expiresAt && s.expiresAt > Date.now() + 60_000) return s.accessToken;
	if (!s.refreshToken) throw new BingApiError('Bing connection has no refresh token; reconnect it', 401);
	const res = await f(BING_TOKEN, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: env('BING_CLIENT_ID'),
			client_secret: env('BING_CLIENT_SECRET'),
			grant_type: 'refresh_token',
			refresh_token: s.refreshToken
		})
	});
	const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string };
	if (!res.ok || !j.access_token) {
		db().prepare("UPDATE integrations SET status = 'revoked' WHERE id = ?").run(integrationId);
		throw new BingApiError('Bing refused to refresh the token; reconnect the account', res.status || 401);
	}
	const next: Secret = { ...s, accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000, refreshToken: j.refresh_token ?? s.refreshToken };
	db().prepare("UPDATE integrations SET secret_enc = ?, status = 'active' WHERE id = ?").run(encrypt(JSON.stringify(next)), integrationId);
	return next.accessToken!;
}

/** Bing prefixes messages like "ERROR!!! InvalidApiKey"; turn the common ones into something a user can act on. */
export function friendlyBingError(message: string | undefined, code: number | undefined, status: number): string {
	const m = (message ?? '').replace(/^ERROR!+\s*/i, '').trim();
	if (m === 'InvalidApiKey' || code === 3) return 'Bing rejected this API key. Generate one in Bing Webmaster Tools → Settings → API Access, and paste it exactly.';
	return m || `Bing API ${status}`;
}

/** A WCF date or null: missing, unparseable, or Bing's "never" (DateTime.MinValue, year 1). */
export function optBingDate(v: unknown): string | null {
	if (typeof v !== 'string' || !v) return null;
	try {
		const d = parseBingDate(v);
		return d >= '2000-01-01' ? d : null;
	} catch {
		return null;
	}
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

export function parseCrawlStats(r: Record<string, unknown>[] | null | undefined): BingCrawlDay[] {
	return (r ?? [])
		.map((x) => ({
			date: optBingDate(x.Date) ?? '',
			crawled: num(x.CrawledPages),
			crawlErrors: num(x.CrawlErrors),
			inIndex: num(x.InIndex),
			inLinks: num(x.InLinks),
			code2xx: num(x.Code2xx),
			code301: num(x.Code301),
			code302: num(x.Code302),
			code4xx: num(x.Code4xx),
			code5xx: num(x.Code5xx),
			otherCodes: num(x.AllOtherCodes),
			blockedByRobots: num(x.BlockedByRobotsTxt),
			malware: num(x.ContainsMalware),
			dnsFailures: num(x.DnsFailures),
			timeouts: num(x.ConnectionTimeout)
		}))
		.filter((x) => x.date)
		.sort((a, b) => a.date.localeCompare(b.date));
}

export function parseFeeds(r: Record<string, unknown>[] | null | undefined): BingFeed[] {
	return (r ?? [])
		.filter((x) => typeof x.Url === 'string' && x.Url)
		.map((x) => ({
			url: String(x.Url),
			type: String(x.Type ?? ''),
			status: String(x.Status ?? ''),
			urlCount: x.UrlCount == null ? null : num(x.UrlCount),
			submitted: optBingDate(x.Submitted),
			lastCrawled: optBingDate(x.LastCrawled),
			fileSize: x.FileSize == null ? null : num(x.FileSize),
			compressed: !!x.Compressed
		}));
}

export class RealBingClient implements BingClient, BingLinksClient, BingCrawlClient {
	constructor(
		private integrationId: number,
		private http: HttpOpts = {}
	) {}

	private async call<T>(method: string, params: Record<string, string> = {}, payload?: unknown): Promise<T> {
		const f = this.http.fetchImpl ?? fetch;
		const wait = this.http.sleepImpl ?? sleep;
		const secret = bingSecret(this.integrationId);
		for (let attempt = 0; ; attempt++) {
			const q = new URLSearchParams(params);
			const headers: Record<string, string> = {};
			let base = KEY_BASE;
			if (secret.apiKey) q.set('apikey', secret.apiKey);
			else (base = OAUTH_BASE), (headers.authorization = `Bearer ${await bearer(this.integrationId, f)}`);
			let res: Response;
			try {
				res = await f(`${base}/${method}?${q}`, payload === undefined ? { headers } : { method: 'POST', headers: { ...headers, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) });
			} catch {
				// Never surface the raw error: its message can contain the URL, and the URL contains the API key.
				throw new BingApiError('Could not reach Bing Webmaster API', 0);
			}
			if (res.ok) return ((await res.json().catch(() => ({}))) as { d: T }).d;
			if ((res.status === 429 || res.status >= 500) && attempt < (this.http.retries ?? 3)) {
				await wait(800 * 2 ** attempt);
				continue;
			}
			const body = (await res.json().catch(() => ({}))) as { ErrorCode?: number; Message?: string };
			throw new BingApiError(friendlyBingError(body.Message, body.ErrorCode, res.status), res.status, body.ErrorCode);
		}
	}

	async listSites() {
		const r = await this.call<{ Url: string; IsVerified: boolean }[]>('GetUserSites');
		return r.map((s) => ({ url: s.Url, isVerified: !!s.IsVerified }));
	}
	async dailyStats(siteUrl: string) {
		const r = await this.call<{ Date: string; Clicks: number; Impressions: number }[]>('GetRankAndTrafficStats', { siteUrl });
		return r.map((x) => ({ date: parseBingDate(x.Date), clicks: x.Clicks, impressions: x.Impressions }));
	}
	private terms(r: { Date: string; Query: string; Clicks: number; Impressions: number; AvgClickPosition?: number; AvgImpressionPosition?: number }[]): BingTermRow[] {
		return r.map((x) => ({ date: parseBingDate(x.Date), term: x.Query, clicks: x.Clicks, impressions: x.Impressions, clickPos: x.AvgClickPosition ?? null, imprPos: x.AvgImpressionPosition ?? null }));
	}
	async queryStats(siteUrl: string) {
		return this.terms(await this.call('GetQueryStats', { siteUrl }));
	}
	async submitUrlBatch(siteUrl: string, urls: string[]) {
		if (urls.length > BING_MAX_URLS_PER_CALL) throw new BingApiError(`At most ${BING_MAX_URLS_PER_CALL} URLs per call.`, 400);
		await this.call('SubmitUrlBatch', {}, { siteUrl, urlList: urls });
	}
	async urlSubmissionQuota(siteUrl: string) {
		const r = await this.call<{ DailyQuota?: number; MonthlyQuota?: number } | null>('GetUrlSubmissionQuota', { siteUrl });
		const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
		return { daily: n(r?.DailyQuota), monthly: n(r?.MonthlyQuota) };
	}
	async pageStats(siteUrl: string) {
		// Per Microsoft's docs GetPageStats reuses the QueryStats shape, with the page URL in `Query`.
		return this.terms(await this.call('GetPageStats', { siteUrl }));
	}
	// The three link methods follow Microsoft's reference (Microsoft Learn, read 2026-11-15) and have not been run against a live Bing account here.
	async linkCounts(siteUrl: string, maxPages = 20) {
		const links: BingLinkCount[] = [];
		let total = 1;
		for (let page = 0; page < total && page < maxPages; page++) {
			const r = parseLinkCounts(await this.call('GetLinkCounts', { siteUrl, page: String(page) }));
			total = r.totalPages;
			links.push(...r.links);
		}
		return { links, totalPages: total, truncated: total > maxPages };
	}
	async urlLinks(siteUrl: string, link: string, maxPages = 3) {
		const out: BingLinkSource[] = [];
		// Microsoft's JSON sample passes `link` as a JSON string literal (in quotes); if that finds nothing, the plain address is tried once.
		for (const arg of [JSON.stringify(link), link]) {
			out.length = 0;
			let total = 1;
			for (let page = 0; page < total && page < maxPages; page++) {
				const r = parseUrlLinks(await this.call('GetUrlLinks', { siteUrl, link: arg, page: String(page) }));
				total = Math.max(r.totalPages, 1);
				out.push(...r.sources);
			}
			if (out.length) break;
		}
		return out;
	}
	// GetCrawlStats, GetFeeds and GetPageQueryStats follow Microsoft's reference (Microsoft Learn, read 2026-11-22) and have not been run
	// against a live Bing account here.
	async crawlStats(siteUrl: string) {
		return parseCrawlStats(await this.call<Record<string, unknown>[]>('GetCrawlStats', { siteUrl }));
	}
	async feeds(siteUrl: string) {
		return parseFeeds(await this.call<Record<string, unknown>[]>('GetFeeds', { siteUrl }));
	}
	async pageQueryStats(siteUrl: string, page: string) {
		return this.terms((await this.call('GetPageQueryStats', { siteUrl, page })) ?? []);
	}
	// SubmitFeed follows Microsoft's reference (Microsoft Learn: POST with siteUrl and feedUrl in the JSON body, like SubmitUrlBatch).
	async submitFeed(siteUrl: string, feedUrl: string) {
		await this.call('SubmitFeed', {}, { siteUrl, feedUrl });
	}
	async crawlIssues(siteUrl: string) {
		return parseCrawlIssues(await this.call('GetCrawlIssues', { siteUrl }));
	}
}
