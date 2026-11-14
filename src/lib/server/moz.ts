import { audit, db } from './db';
import { integrationSecret, listIntegrations, removeIntegration, saveIntegration } from './links';
import { getSite } from './clients';
import { config, env } from './config';
import { demoMozFetch } from './demo-channels';
import { authDue, authFor, authSummary, authoritySiteIds, domainTarget, normaliseTarget, saveError, saveValue } from './authority';

/**
 * Moz Domain Authority (DA) for each site, shown next to its name. It needs the operator's own Moz API credentials (Access ID and
 * Secret Key, from a free Moz API account). Moz limits the free plan by monthly "rows", so this is deliberately thrifty: each site
 * is looked up every MOZ_DA_EVERY_DAYS (default 30, at least 7), at most MOZ_MONTHLY_ROWS rows a month (default 40) are spent, and
 * requests are spaced 10 seconds apart. Written from third-party descriptions of Moz's API v2 (POST /v2/url_metrics, HTTP Basic auth,
 * `domain_authority` in `results`): Moz's own documentation could not be read here, so this has been tested against a fake only.
 * Expect fixes on first real use. Moz publishes attribution and branding rules this author could not read: check them before relying on it.
 */
const ENDPOINT = 'https://lsapi.seomoz.com/v2/url_metrics';
const PROBE_TARGET = 'moz.com';
/** Third-party sources disagree on the batch limit (25 or 50); the smaller is used. */
const BATCH = 25;
const GAP_MS = 10_500;

export class MozError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

const clampInt = (v: string, fallback: number, lo: number, hi: number) => {
	const n = Math.floor(Number(v));
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
export const mozEveryDays = () => clampInt(env('MOZ_DA_EVERY_DAYS', '30'), 30, 7, 90);
export const mozMonthlyRows = () => clampInt(env('MOZ_MONTHLY_ROWS', '40'), 40, 1, 1_000_000);

/** Rows spent this calendar month (UTC), counted by this app: one per domain asked about. */
const monthKey = (now: number) => `moz_rows:${new Date(now).toISOString().slice(0, 7)}`;
export const rowsUsed = (now = Date.now()) => Number((db().prepare('SELECT value FROM kv WHERE key = ?').get(monthKey(now)) as { value: string } | undefined)?.value ?? 0);
const addRows = (n: number, now: number) => void db().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(monthKey(now), String(rowsUsed(now) + n));

export function parseUrlMetrics(json: unknown, targets: string[]): Map<string, number> {
	const list = (json as { results?: unknown } | null)?.results;
	if (!Array.isArray(list)) throw new MozError('Moz answered in a shape this app does not recognise (no results).', 502);
	const out = new Map<string, number>();
	list.forEach((r: { page?: unknown; domain_authority?: unknown }, i) => {
		const da = Number(r?.domain_authority);
		if (r?.domain_authority == null || !Number.isFinite(da) || da < 0 || da > 100) return;
		// matched by the page Moz echoes; if it echoes none, by position (results follow the order of the request)
		const key = typeof r.page === 'string' ? normaliseTarget(r.page).split('/')[0] : list.length === targets.length ? normaliseTarget(targets[i]) : null;
		if (key) out.set(key, da);
	});
	return out;
}

async function queryBatch(accessId: string, secretKey: string, targets: string[], fetchImpl: typeof fetch): Promise<Map<string, number>> {
	let res: Response;
	try {
		res = await fetchImpl(ENDPOINT, {
			method: 'POST',
			headers: { authorization: `Basic ${Buffer.from(`${accessId}:${secretKey}`).toString('base64')}`, accept: 'application/json', 'content-type': 'application/json' },
			body: JSON.stringify({ targets }),
			signal: AbortSignal.timeout(30_000)
		});
	} catch (e) {
		throw new MozError(e instanceof Error && e.name === 'TimeoutError' ? 'Moz did not answer within 30 seconds.' : 'Could not reach Moz.', 0);
	}
	const body = (await res.json().catch(() => null)) as { message?: unknown; error?: unknown } | null;
	if (res.status === 401 || res.status === 403) throw new MozError('Moz rejected the Access ID or Secret Key. Copy both again from your Moz API account.', res.status);
	if (res.status === 429) throw new MozError('Moz says the rate limit or your monthly rows are used up. It will be tried again tomorrow.', 429);
	const detail = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : '';
	if (!res.ok) throw new MozError(detail ? `Moz: ${detail.slice(0, 200)}` : `Moz answered HTTP ${res.status}.`, res.status);
	return parseUrlMetrics(body, targets);
}

export async function queryDomainAuthority(accessId: string, secretKey: string, targets: string[], o: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}): Promise<Map<string, number>> {
	const fetchImpl = o.fetchImpl ?? fetch;
	const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const out = new Map<string, number>();
	for (let i = 0; i < targets.length; i += BATCH) {
		if (i > 0) await sleep(GAP_MS); // the free plan allows about one request every 10 seconds
		for (const [k, v] of await queryBatch(accessId, secretKey, targets.slice(i, i + BATCH), fetchImpl)) out.set(k, v);
	}
	return out;
}

export const mozRow = () => listIntegrations('moz')[0];
export const mozIntegration = () => listIntegrations('moz').find((i) => i.status === 'active');

/** Check the credentials with one lookup (it costs one row on Moz's side, counted here), then store them encrypted. */
export async function connectMoz(accessId: string, secretKey: string, o: { fetchImpl?: typeof fetch; now?: number } = {}) {
	const id = accessId.trim(), key = secretKey.trim();
	if (!id || !key) throw new MozError('Enter both the Access ID and the Secret Key', 400);
	const demo = config.demo && id === 'demo' && key === 'demo';
	const now = o.now ?? Date.now();
	if (!demo) {
		const r = await queryDomainAuthority(id, key, [PROBE_TARGET], { fetchImpl: o.fetchImpl });
		addRows(1, now);
		if (!r.has(PROBE_TARGET)) throw new MozError('Moz accepted the credentials but did not answer the check. Try again in a moment.', 502);
	}
	for (const i of listIntegrations('moz')) removeIntegration(i.id);
	const saved = saveIntegration('moz', 'Moz', { accessId: id, secretKey: key }, {}, demo);
	audit('moz.connected');
	return { id: saved };
}

export function disconnectMoz() {
	for (const i of listIntegrations('moz')) removeIntegration(i.id);
	audit('moz.disconnected');
}

export const daFor = (siteId: number) => authFor(siteId, 'da');
export const daSiteIds = authoritySiteIds;

export function daDue(siteId: number, now = Date.now()): boolean {
	if (!mozIntegration() || !daSiteIds().includes(siteId)) return false;
	return authDue(siteId, 'da', mozEveryDays(), now);
}
export const daAnyDue = (now = Date.now()) => !!mozIntegration() && daSiteIds().some((id) => daDue(id, now));

/**
 * Look due sites up, within the month's row budget: sites with no value yet first, then the oldest. `force` ignores the schedule (the
 * Refresh button) but never the budget. A domain Moz did not answer keeps its last value and records why.
 */
export async function syncDaAll(o: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: number; force?: boolean } = {}): Promise<{ stored: number; missing: number; deferred: number }> {
	const integ = mozIntegration();
	if (!integ) throw new Error('Moz is not connected');
	const now = o.now ?? Date.now();
	const bySite = new Map<number, string>();
	for (const id of daSiteIds()) {
		const site = getSite(id);
		const t = site ? domainTarget(site.site_url) : null;
		if (t && (o.force || daDue(id, now))) bySite.set(id, t);
	}
	if (!bySite.size) return { stored: 0, missing: 0, deferred: 0 };
	// distinct domains, those with no value first, then the stalest
	const age = (id: number) => (authFor(id, 'da')?.fetched_on ?? '0000-00-00');
	const domains = [...new Set([...bySite.entries()].sort((a, b) => age(a[0]).localeCompare(age(b[0])) || a[0] - b[0]).map(([, t]) => t))];
	const left = Math.max(0, mozMonthlyRows() - rowsUsed(now));
	const chosen = domains.slice(0, left);
	const deferred = domains.length - chosen.length;
	const d = db();
	if (!chosen.length) {
		const msg = `This month's row budget (${mozMonthlyRows()}) is used up. Lookups resume next month; MOZ_MONTHLY_ROWS raises it.`;
		d.transaction(() => { for (const id of bySite.keys()) saveError(id, 'da', msg, now); })();
		return { stored: 0, missing: 0, deferred };
	}
	const { accessId, secretKey } = integrationSecret<{ accessId: string; secretKey: string }>(integ);
	const fetchImpl = o.fetchImpl ?? (integ.is_demo ? demoMozFetch() : fetch);
	let answers: Map<string, number>;
	try {
		answers = await queryDomainAuthority(accessId, secretKey, chosen, { fetchImpl, sleep: o.sleep });
	} catch (e) {
		const err = e instanceof MozError ? e : new MozError(e instanceof Error ? e.message : String(e), 0);
		// A failure other than a refusal may still have been counted by Moz, so it is counted here; a refused key cost nothing.
		if (err.status !== 401 && err.status !== 403) addRows(chosen.length, now);
		d.transaction(() => { for (const id of bySite.keys()) saveError(id, 'da', err.message, now); })();
		if (err.status === 401 || err.status === 403) d.prepare("UPDATE integrations SET status = 'rejected' WHERE id = ?").run(integ.id);
		throw err;
	}
	addRows(chosen.length, now);
	let stored = 0, missing = 0;
	d.transaction(() => {
		for (const [id, target] of bySite) {
			if (!chosen.includes(target)) continue; // over budget: untouched, due again next time
			const da = answers.get(normaliseTarget(target));
			if (da == null) {
				missing++;
				saveError(id, 'da', `Moz gave no Domain Authority for ${target}.`, now);
			} else {
				stored++;
				saveValue(id, 'da', da, now);
			}
		}
	})();
	return { stored, missing, deferred };
}

/** What the Connect page shows. */
export function mozStatus(now = Date.now()) {
	const row = mozRow();
	if (!row) return null;
	const x = authSummary('da');
	return { demo: !!row.is_demo, rejected: row.status === 'rejected', total: x.total, withDa: x.withValue, lastError: x.lastError, rowsUsed: rowsUsed(now), rowBudget: mozMonthlyRows(), everyDays: mozEveryDays() };
}
