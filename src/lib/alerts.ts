/**
 * Alert rules: what each kind watches, its default threshold, and how the threshold reads. Every site gets the built-in rules from
 * the start (thresholds editable, each can be switched off); custom rules add the same kinds scoped to part of the site: a URL path,
 * a search pattern, a keyword bucket or a page group.
 *
 * Every rule compares the last N complete days with the N days before (N = the rule's window), which is what the period picker does too.
 */
export type AlertKind =
	| 'clicks_drop'
	| 'impressions_drop'
	| 'position_drop'
	| 'ctr_drop'
	| 'top10_lost'
	| 'pages_drop'
	| 'deindexed'
	| 'tracked_drop'
	| 'clicks_rise'
	| 'top3_new';

export interface AlertKindInfo {
	kind: AlertKind;
	label: string;
	/** how the threshold reads in a sentence, with {t} for the number */
	rule: string;
	unit: '%' | 'places' | 'count' | 'pp';
	threshold: number;
	window: number;
	/** good news rather than a problem */
	positive: boolean;
	/** may be scoped to part of the site by a custom rule */
	scopable: boolean;
	/** switched on for every site from the start */
	builtinOn: boolean;
}

export const ALERT_KINDS: AlertKindInfo[] = [
	{ kind: 'clicks_drop', label: 'Clicks falling', rule: 'Clicks fell by {t}% or more', unit: '%', threshold: 25, window: 7, positive: false, scopable: true, builtinOn: true },
	{ kind: 'impressions_drop', label: 'Impressions falling', rule: 'Impressions fell by {t}% or more', unit: '%', threshold: 30, window: 7, positive: false, scopable: true, builtinOn: true },
	{ kind: 'position_drop', label: 'Average position worse', rule: 'Average position got worse by {t} places or more', unit: 'places', threshold: 3, window: 7, positive: false, scopable: true, builtinOn: true },
	{ kind: 'ctr_drop', label: 'Click rate falling', rule: 'Click-through rate fell by {t} percentage points or more', unit: 'pp', threshold: 1, window: 28, positive: false, scopable: true, builtinOn: true },
	{ kind: 'top10_lost', label: 'Top-10 searches lost', rule: '{t} or more searches left the top 10', unit: 'count', threshold: 5, window: 7, positive: false, scopable: true, builtinOn: true },
	{ kind: 'pages_drop', label: 'Pages losing clicks', rule: '{t} or more pages each lost half their clicks (10+ clicks before)', unit: 'count', threshold: 3, window: 28, positive: false, scopable: true, builtinOn: true },
	{ kind: 'deindexed', label: 'Pages leaving Google', rule: '{t} or more watched pages dropped out of Google’s index', unit: 'count', threshold: 1, window: 7, positive: false, scopable: false, builtinOn: true },
	{ kind: 'tracked_drop', label: 'Tracked searches falling', rule: 'A tracked search fell {t} places or more, or left the top 10', unit: 'places', threshold: 3, window: 7, positive: false, scopable: false, builtinOn: true },
	{ kind: 'clicks_rise', label: 'Clicks rising', rule: 'Clicks rose by {t}% or more', unit: '%', threshold: 25, window: 7, positive: true, scopable: true, builtinOn: true },
	{ kind: 'top3_new', label: 'New top-3 searches', rule: '{t} or more searches reached the top 3', unit: 'count', threshold: 3, window: 7, positive: true, scopable: true, builtinOn: true }
];
export const alertKind = (k: string): AlertKindInfo | null => ALERT_KINDS.find((x) => x.kind === k) ?? null;
export const ruleText = (k: AlertKindInfo, t: number) => k.rule.replace('{t}', String(t));

export const ALERT_WINDOWS = [7, 14, 28] as const;
export const MAX_CUSTOM_ALERTS = 20;

export type ScopeKind = 'page' | 'query' | 'bucket' | 'pages';
export const SCOPE_LABEL: Record<ScopeKind, string> = { page: 'URL path starts with', query: 'Searches matching (regex)', bucket: 'Keyword bucket', pages: 'Page group' };

/** Bounds a threshold so a typo cannot make a rule meaningless (a 0% drop alerts every day, a 900% one never). */
export function clampThreshold(k: AlertKindInfo, v: number): number | null {
	if (!Number.isFinite(v)) return null;
	const [lo, hi] = k.unit === '%' ? [5, 95] : k.unit === 'places' ? [0.5, 50] : k.unit === 'pp' ? [0.1, 50] : [1, 1000];
	if (k.kind === 'clicks_rise') return v >= 5 && v <= 1000 ? v : null;
	return v >= lo && v <= hi ? v : null;
}

/**
 * Whether a change is more than day-to-day noise, for counts (clicks, impressions): at least two standard deviations under a Poisson
 * model, and a floor so a site with 4 clicks a week does not alert on 2. The same test the weekly digest uses.
 */
export function countChangeReal(now: number, prev: number, floor = 10): boolean {
	if (now + prev === 0) return false;
	return Math.abs(now - prev) / Math.sqrt(now + prev) >= 2 && Math.abs(now - prev) >= floor;
}

/** The percentage change, or null when the previous value is too small for a percentage to mean anything. */
export const pctOf = (now: number, prev: number, minPrev: number) => (prev >= minPrev ? ((now - prev) / prev) * 100 : null);

/**
 * How much a site needs looking at, for the dashboard's "Needs a look" order: "look" for a real fall in clicks (beyond day-to-day
 * noise) of 20% or more against the previous period, "watch" for 10% or more, null otherwise or when the periods cannot be compared.
 */
export function attentionOf(c: { comparable: boolean; now: { clicks: number }; prev: { clicks: number } }): 'look' | 'watch' | null {
	if (!c.comparable || c.prev.clicks < 20 || !countChangeReal(c.now.clicks, c.prev.clicks)) return null;
	const fall = (c.prev.clicks - c.now.clicks) / c.prev.clicks;
	return fall >= 0.2 ? 'look' : fall >= 0.1 ? 'watch' : null;
}
