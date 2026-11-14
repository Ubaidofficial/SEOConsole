/**
 * Publishing health: is what you publish actually being shown? One row per sitemap URL goes in, and out comes the answer by section of
 * the site (URL folder) and by age. Pure functions, no I/O.
 *
 * It exists for the "publish five hundred pages" mistake: a section that grows by hundreds of URLs while Google shows almost none of them.
 * "Shown" means at least one impression in the window (Search Console's query-level data leaves out anonymised and very rare queries, so this
 * is a list to inspect, not proof). Age comes from the sitemap's own <lastmod> and is only trusted when it is not a build stamp.
 */

export type IdxState = 'indexed' | 'not_indexed' | 'unknown';
export interface PubUrl {
	url: string;
	lastmod: string | null;
	clicks: number;
	impressions: number;
	/** from the stored URL Inspection sample; null = never inspected */
	index: IdxState | null;
	/** Google's coverage text when it is not indexed */
	reason: string | null;
}

export type SectionVerdict = 'working' | 'slow' | 'stalled' | 'too_new' | 'small';
export const VERDICT_LABEL: Record<SectionVerdict, string> = { working: 'Working', slow: 'Slow', stalled: 'Stalled', too_new: 'Too new to judge', small: 'Too few pages to judge' };

export interface SectionRow {
	folder: string;
	urls: number;
	shown: number;
	shownShare: number;
	clicks: number;
	impressions: number;
	clicksPerUrl: number;
	inspected: number;
	indexed: number;
	notIndexed: number;
	noindex: number;
	reasons: { reason: string; count: number }[];
	verdict: SectionVerdict;
	/** fewer than half of the section's pages have a trustworthy date, so "too new" could not be judged */
	ageUnknown: boolean;
	advice: string;
}
export interface CohortRow { bucket: string; urls: number; shown: number; shownShare: number; clicks: number }
export interface PublishingReport {
	days: number;
	totals: { urls: number; shown: number; shownShare: number; clicks: number; impressions: number; inspected: number; indexed: number; notIndexed: number };
	sections: SectionRow[];
	/** how old the URLs are by <lastmod>; "unknown" when there is none or it is a build stamp */
	cohorts: CohortRow[];
	buildStamp: { date: string; share: number } | null;
	velocity: { last30: number; last90: number; known: number };
	headline: string;
}

/** A section with fewer URLs than this is not judged. */
export const MIN_SECTION = 10;
/** Shown share below this, over enough older URLs, is "stalled"; at or above WORKING it is "working". */
export const STALLED = 0.2;
export const WORKING = 0.5;
/** A section whose dated URLs are mostly younger than this many days is too new to judge. */
export const YOUNG_DAYS = 30;
const BUCKETS: [string, number][] = [['0-14 days', 14], ['15-30 days', 30], ['31-60 days', 60], ['61-90 days', 90], ['over 90 days', Infinity]];

export const folderOf = (url: string, depth = 1): string => {
	try {
		const parts = new URL(url).pathname.split('/').filter(Boolean);
		return parts.length <= depth ? '/' : '/' + parts.slice(0, depth).join('/') + '/';
	} catch {
		return '/';
	}
};

const daysAgo = (date: string, today: string) => Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86_400_000);

/** A date shared by at least half of the dated URLs (and at least ten of them) is a build or deploy stamp, not an edit date. */
export function buildStamp(urls: { lastmod: string | null }[]): { date: string; share: number } | null {
	const counts = new Map<string, number>();
	let dated = 0;
	for (const u of urls) if (u.lastmod) (dated++, counts.set(u.lastmod, (counts.get(u.lastmod) ?? 0) + 1));
	if (dated < 10) return null;
	const [date, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
	return n / dated >= 0.5 ? { date, share: n / dated } : null;
}

export function publishingReport(urls: PubUrl[], today: string, days = 90, depth = 1): PublishingReport {
	const stamp = buildStamp(urls);
	const ageOf = (u: PubUrl): number | null => (u.lastmod && u.lastmod !== stamp?.date && u.lastmod <= today ? daysAgo(u.lastmod, today) : null);
	const isShown = (u: PubUrl) => u.impressions > 0;

	const groups = new Map<string, PubUrl[]>();
	for (const u of urls) {
		const f = folderOf(u.url, depth);
		const g = groups.get(f);
		if (g) g.push(u);
		else groups.set(f, [u]);
	}

	const sections: SectionRow[] = [...groups].map(([folder, list]) => {
		const shown = list.filter(isShown).length;
		const clicks = list.reduce((a, u) => a + u.clicks, 0);
		const inspected = list.filter((u) => u.index === 'indexed' || u.index === 'not_indexed');
		const reasons = new Map<string, number>();
		for (const u of list) if (u.index === 'not_indexed') reasons.set(u.reason ?? 'No reason given', (reasons.get(u.reason ?? 'No reason given') ?? 0) + 1);
		const dated = list.map(ageOf).filter((a): a is number => a != null);
		const young = dated.length >= MIN_SECTION && dated.filter((a) => a <= YOUNG_DAYS).length / dated.length >= 0.6;
		const share = list.length ? shown / list.length : 0;
		const verdict: SectionVerdict = list.length < MIN_SECTION ? 'small' : share >= WORKING ? 'working' : young ? 'too_new' : share < STALLED ? 'stalled' : 'slow';
		const ageUnknown = dated.length < list.length * 0.5;
		const advice =
			verdict === 'stalled' ? `Google shows almost none of these pages. Publishing more of the same will not change that: make the best few clearly better than what already ranks (something only you have), link to them from your strongest pages, and fold or remove the rest.${ageUnknown ? ' The age of these pages could not be judged (the sitemap dates are missing or a build stamp), so some of them may simply be new: check when they were published before removing anything.' : ''}`
			: verdict === 'slow' ? 'Some of these are shown and many are not. Look at what the shown ones have that the rest lack before adding more.'
			: verdict === 'too_new' ? 'Most of these pages are recent, so a low share is expected. Check again in a few weeks.'
			: verdict === 'working' ? 'Most of these pages are being shown. This section is worth extending, carefully.'
			: 'Too few pages to say anything.';
		return {
			folder, urls: list.length, shown, shownShare: share, clicks, impressions: list.reduce((a, u) => a + u.impressions, 0), clicksPerUrl: list.length ? clicks / list.length : 0,
			inspected: inspected.length, indexed: inspected.filter((u) => u.index === 'indexed').length, notIndexed: inspected.filter((u) => u.index === 'not_indexed').length,
			noindex: list.filter((u) => u.index === 'not_indexed' && /noindex/i.test(u.reason ?? '')).length,
			reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 4),
			verdict, ageUnknown, advice
		};
	}).sort((a, b) => b.urls - a.urls);

	const cohorts: CohortRow[] = [...BUCKETS.map(([bucket]) => bucket), 'age unknown'].map((bucket) => ({ bucket, urls: 0, shown: 0, shownShare: 0, clicks: 0 }));
	for (const u of urls) {
		const a = ageOf(u);
		const i = a == null ? BUCKETS.length : BUCKETS.findIndex(([, max]) => a <= max);
		const c = cohorts[i];
		c.urls++;
		if (isShown(u)) c.shown++;
		c.clicks += u.clicks;
	}
	for (const c of cohorts) c.shownShare = c.urls ? c.shown / c.urls : 0;

	const known = urls.map(ageOf).filter((a): a is number => a != null);
	const inspected = urls.filter((u) => u.index === 'indexed' || u.index === 'not_indexed');
	const shown = urls.filter(isShown).length;
	const totals = {
		urls: urls.length, shown, shownShare: urls.length ? shown / urls.length : 0, clicks: urls.reduce((a, u) => a + u.clicks, 0), impressions: urls.reduce((a, u) => a + u.impressions, 0),
		inspected: inspected.length, indexed: inspected.filter((u) => u.index === 'indexed').length, notIndexed: inspected.filter((u) => u.index === 'not_indexed').length
	};
	const stalled = sections.filter((s) => s.verdict === 'stalled');
	const headline = !urls.length ? 'No sitemap URLs stored yet: read the sitemaps first (Indexing tab).'
		: stalled.length ? `${Math.round(totals.shownShare * 100)}% of ${totals.urls} sitemap pages were shown in ${days} days; ${stalled.length === 1 ? 'one section is' : `${stalled.length} sections are`} stalled (${stalled.slice(0, 3).map((s) => `${s.folder}: ${s.shown} of ${s.urls}`).join(', ')}).`
		: `${Math.round(totals.shownShare * 100)}% of ${totals.urls} sitemap pages were shown in ${days} days.`;
	return { days, totals, sections, cohorts, buildStamp: stamp, velocity: { last30: known.filter((a) => a <= 30).length, last90: known.filter((a) => a <= 90).length, known: known.length }, headline };
}
