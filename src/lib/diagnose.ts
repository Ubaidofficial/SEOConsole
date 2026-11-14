/**
 * Drop diagnosis: "why did clicks change?", answered in the order a careful person would check, before anything on the site is touched.
 * Pure functions, no I/O (the server module gathers the numbers).
 *
 * The idea is the antidote to panicking after a Google update: do not delete or rewrite anything until you know which of these it is.
 *   1. Is the change bigger than noise at all?
 *   2. Is the data complete (is the earlier period still downloading)?
 *   3. Is it less *demand* (fewer impressions at the same position), a *ranking* loss (position worse), or a *click-rate* loss
 *      (same position and impressions, fewer clicks: a changed result, SERP features, an AI answer)?
 *   4. Is it a handful of pages, or broad?
 *   5. Did pages drop out of Google's index?
 *   6. Is a Google update still rolling out? (Rankings move for weeks during one: waiting is an action.)
 *   7. Is it the season? (Same windows a year earlier, when that history exists.)
 *
 * The site-level split is an exact identity: clicks = impressions x CTR, so
 *   change in clicks = (change in impressions) x (earlier CTR)  +  (later impressions) x (change in CTR).
 * The per-row causes (demand / ranking / click rate / lost) are heuristics with the thresholds below; they say where to look, not why Google did it.
 */
import { ctrOf, pctChange, type Metrics } from './analytics';

export interface DiagRow { key: string; now: Metrics; prev: Metrics }
export interface DiagUpdate { name: string; begin: string; end: string | null }

export type Cause = 'demand' | 'ranking' | 'clickrate' | 'lost' | 'new' | 'noise';
export const CAUSE_LABEL: Record<Cause, string> = {
	demand: 'Fewer impressions at a steady position',
	ranking: 'Ranking lower',
	clickrate: 'Same position and impressions, fewer clicks',
	lost: 'Stopped appearing at all',
	new: 'New this period',
	noise: 'Small moves'
};
export const CAUSE_ADVICE: Record<Cause, string> = {
	demand: 'People searched less, or Google showed you for fewer searches. Check last year for a seasonal dip before touching the page.',
	ranking: 'These rank lower than before. Compare the page with what now outranks it; do not change it while an update is still rolling out.',
	clickrate: 'You rank the same and are shown as often, but fewer people click: look at the live result (title, a new feature or AI answer above you) before rewriting.',
	lost: 'The page or search no longer appears at all: check it is indexed, not blocked and still returns a page (Indexing tab).',
	new: 'Gains, not losses.',
	noise: 'Too small to act on.'
};

/** A move in position smaller than this is not called a ranking loss. Positions are averages, so one place is noise. */
export const RANK_SHIFT = 2;
/** Impressions down by at least this share, at a steady position, is "demand". */
export const DEMAND_DROP = 0.2;
/** Click rate down by at least this share, with impressions and position steady, is "click rate". */
export const CTR_DROP = 0.25;
/** Rows that earned fewer clicks than this in the earlier period are too small to classify. */
export const MIN_PREV_CLICKS = 3;
/** A change smaller than this share of the earlier clicks is never called real: a Poisson test alone understates how much real traffic scatters from period to period. */
export const MIN_CHANGE = 0.05;
/** Top pages' share of the lost clicks at or above which the loss is called concentrated. */
export const CONCENTRATED = 0.7;

export interface CauseSummary { cause: Cause; rows: number; clicks: number; examples: { key: string; clicks: number; impressions: number; position: { now: number; prev: number } }[] }

export type StepStatus = 'ok' | 'check' | 'wait' | 'info';
export interface Step { n: number; question: string; status: StepStatus; detail: string }

export interface DiagnoseInput {
	totals: { now: Metrics; prev: Metrics };
	queries: DiagRow[];
	pages: DiagRow[];
	/** the same windows a year earlier; null when the stored history does not reach back that far */
	yearAgo: { now: Metrics; prev: Metrics } | null;
	updates: DiagUpdate[];
	/** the later window's last day (YYYY-MM-DD) */
	windowEnd: string;
	/** false while the earlier window is still being downloaded */
	comparable: boolean;
	/** pages that dropped out of Google's index in the later window (from the indexing monitor); null when it is not switched on */
	deindexed: number | null;
	isBrand: (query: string) => boolean;
}

export interface Diagnosis {
	comparable: boolean;
	clicks: { now: number; prev: number; change: number; pct: number | null; z: number; significant: boolean };
	/** exact: demand + clickRate = change in clicks */
	split: { demand: number; clickRate: number; impressionsPct: number | null; ctrPct: number | null; positionNow: number; positionPrev: number };
	causes: CauseSummary[];
	concentration: { topShare: number; concentrated: boolean; pages: { key: string; lost: number }[] };
	brand: { lost: number; share: number };
	seasonal: { impressionsPct: number; expectedClicks: number } | null;
	updates: { name: string; begin: string; end: string | null; rolling: boolean }[];
	/** wait before changing anything */
	hold: boolean;
	headline: string;
	steps: Step[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const fmtAbs = (x: number | null) => (x == null ? 'n/a' : `${Math.round(Math.abs(x) * 100)}%`);
const fmtPct = (x: number | null) => (x == null ? 'n/a' : `${x > 0 ? '+' : ''}${Math.round(x * 100)}%`);

/** What most plausibly explains one row's move. Position is "worse" when the number is bigger. */
export function classifyRow(now: Metrics, prev: Metrics): Cause {
	if (prev.clicks < MIN_PREV_CLICKS && now.clicks < MIN_PREV_CLICKS) return 'noise';
	if (prev.impressions === 0 && now.impressions > 0) return 'new';
	if (now.impressions === 0) return prev.clicks >= MIN_PREV_CLICKS ? 'lost' : 'noise';
	if (now.clicks >= prev.clicks) return now.clicks > prev.clicks && prev.clicks < MIN_PREV_CLICKS ? 'new' : 'noise';
	if (prev.clicks < MIN_PREV_CLICKS) return 'noise';
	if (now.position - prev.position >= RANK_SHIFT) return 'ranking';
	const impr = pctChange(now.impressions, prev.impressions) ?? 0;
	if (impr <= -DEMAND_DROP) return 'demand';
	const c = pctChange(ctrOf(now), ctrOf(prev)) ?? 0;
	if (c <= -CTR_DROP) return 'clickrate';
	return 'noise';
}

export function diagnose(i: DiagnoseInput): Diagnosis {
	const { now, prev } = i.totals;
	const change = now.clicks - prev.clicks;
	// Poisson: with n1 and n0 clicks, the difference has a standard error of about sqrt(n1 + n0).
	const z = now.clicks + prev.clicks > 0 ? change / Math.sqrt(now.clicks + prev.clicks) : 0;
	const significant = Math.abs(z) >= 2 && Math.abs(change) >= 5 && Math.abs(change) >= MIN_CHANGE * prev.clicks;

	const split = {
		demand: (now.impressions - prev.impressions) * ctrOf(prev),
		clickRate: now.impressions * (ctrOf(now) - ctrOf(prev)),
		impressionsPct: pctChange(now.impressions, prev.impressions),
		ctrPct: prev.impressions > 0 && ctrOf(prev) > 0 ? pctChange(ctrOf(now), ctrOf(prev)) : null,
		positionNow: now.position,
		positionPrev: prev.position
	};

	// Per-row causes, over the queries (what people searched) among the rows that lost clicks.
	const losers = i.queries.filter((r) => r.now.clicks < r.prev.clicks || (r.now.impressions === 0 && r.prev.clicks > 0));
	const byCause = new Map<Cause, CauseSummary>();
	for (const r of losers) {
		const cause = classifyRow(r.now, r.prev);
		if (cause === 'noise' || cause === 'new') continue;
		const s = byCause.get(cause) ?? { cause, rows: 0, clicks: 0, examples: [] };
		s.rows++;
		s.clicks += r.prev.clicks - r.now.clicks;
		s.examples.push({ key: r.key, clicks: r.prev.clicks - r.now.clicks, impressions: r.now.impressions, position: { now: r1(r.now.position), prev: r1(r.prev.position) } });
		byCause.set(cause, s);
	}
	const causes = [...byCause.values()].map((s) => ({ ...s, examples: s.examples.sort((a, b) => b.clicks - a.clicks).slice(0, 5) })).sort((a, b) => b.clicks - a.clicks);

	// Pages: is the loss a few pages or everywhere?
	const lostPages = i.pages.map((r) => ({ key: r.key, lost: r.prev.clicks - r.now.clicks })).filter((r) => r.lost > 0).sort((a, b) => b.lost - a.lost);
	const lostTotal = lostPages.reduce((a, r) => a + r.lost, 0);
	const top = lostPages.slice(0, 5);
	const topShare = lostTotal > 0 ? top.reduce((a, r) => a + r.lost, 0) / lostTotal : 0;
	const concentrated = lostPages.length >= 1 && topShare >= CONCENTRATED && lostTotal >= 5;

	// Brand: a drop in searches for your own name is demand for you, not a ranking problem.
	const brandLost = losers.filter((r) => i.isBrand(r.key)).reduce((a, r) => a + (r.prev.clicks - r.now.clicks), 0);
	const queryLostTotal = losers.reduce((a, r) => a + Math.max(0, r.prev.clicks - r.now.clicks), 0);
	const brand = { lost: brandLost, share: queryLostTotal > 0 ? brandLost / queryLostTotal : 0 };

	// Season: what the same two windows did a year ago. If last year's impressions moved the same way, expect it again.
	let seasonal: Diagnosis['seasonal'] = null;
	if (i.yearAgo && i.yearAgo.prev.impressions >= 200 && i.yearAgo.now.impressions >= 0) {
		const p = pctChange(i.yearAgo.now.impressions, i.yearAgo.prev.impressions)!;
		seasonal = { impressionsPct: p, expectedClicks: Math.round(prev.clicks * p) };
	}

	const updates = i.updates.map((u) => ({ ...u, rolling: u.end == null || u.end >= addDaysStr(i.windowEnd, -3) }));
	const rolling = updates.some((u) => u.rolling);

	const steps: Step[] = [];
	steps.push(
		!i.comparable
			? { n: 1, question: 'Is the earlier period fully downloaded?', status: 'wait', detail: 'No: the earlier period is still being downloaded or empty, so any comparison would be wrong. Wait for the history backfill to finish.' }
			: { n: 1, question: 'Is the earlier period fully downloaded?', status: 'ok', detail: 'Yes: both periods are complete, so the comparison is fair.' }
	);
	steps.push(
		!i.comparable
			? { n: 2, question: 'Is the change bigger than noise?', status: 'info', detail: 'Cannot tell yet.' }
			: significant
				? { n: 2, question: 'Is the change bigger than noise?', status: change < 0 ? 'check' : 'ok', detail: `Yes: clicks went from ${prev.clicks} to ${now.clicks} (${fmtPct(pctChange(now.clicks, prev.clicks))}), about ${r1(Math.abs(z))} standard errors, so it is unlikely to be chance.` }
				: { n: 2, question: 'Is the change bigger than noise?', status: 'ok', detail: `No: clicks went from ${prev.clicks} to ${now.clicks}, within the normal scatter for this amount of traffic (a change under 5%, or too small to be sure of, is never called real). Changing pages in response would be reacting to noise.` }
	);
	if (i.comparable && (significant || Math.abs(change) >= 5)) {
		const dominant = Math.abs(split.demand) >= Math.abs(split.clickRate) ? 'demand' : 'clickRate';
		steps.push({
			n: 3, question: 'Fewer impressions, or fewer clicks per impression?', status: 'info',
			detail: `Impressions ${fmtPct(split.impressionsPct)}, click rate ${fmtPct(split.ctrPct)}, average position ${r1(split.positionPrev)} to ${r1(split.positionNow)}. Of the change of ${Math.round(change)} clicks, ${Math.round(split.demand)} comes from impressions and ${Math.round(split.clickRate)} from click rate: mostly ${dominant === 'demand' ? 'how often you were shown' : 'how often shown results were clicked'}.`
		});
	}
	if (causes.length) {
		const c = causes[0];
		steps.push({ n: 4, question: 'Which searches lost the most, and why?', status: 'info', detail: `${c.rows} search${c.rows === 1 ? '' : 'es'} (${c.clicks} clicks) match "${CAUSE_LABEL[c.cause]}": ${CAUSE_ADVICE[c.cause]}${causes[1] ? ` Next: ${causes[1].rows} search${causes[1].rows === 1 ? '' : 'es'} (${causes[1].clicks} clicks), "${CAUSE_LABEL[causes[1].cause]}".` : ''}` });
	}
	if (lostPages.length) {
		steps.push({ n: 5, question: 'A few pages, or the whole site?', status: 'info', detail: concentrated ? `A few pages: the top ${top.length} account for ${Math.round(topShare * 100)}% of the lost clicks. Start with those.` : `Broad: the top ${top.length} pages are only ${Math.round(topShare * 100)}% of the lost clicks, so it is not one bad page. Look at what is shared (a section, a template) or at demand.` });
	}
	if (brand.share >= 0.3 && brand.lost >= 3) {
		steps.push({ n: 6, question: 'Is it searches for your own name?', status: 'info', detail: `${Math.round(brand.share * 100)}% of the lost query clicks are brand searches (${brand.lost} clicks). These are searches for your own name: check brand demand, and that your site still ranks first for its name, before blaming rankings in general.` });
	}
	steps.push(
		i.deindexed == null
			? { n: 7, question: 'Did pages drop out of Google\'s index?', status: 'info', detail: 'The indexing monitor is not switched on for this site, so this cannot be checked. Turn it on (Indexing tab).' }
			: i.deindexed > 0
				? { n: 7, question: 'Did pages drop out of Google\'s index?', status: 'check', detail: `Yes: ${i.deindexed} pages were seen dropping out of the index. Fix that first (Indexing tab); ranking work is pointless on pages that are not indexed.` }
				: { n: 7, question: 'Did pages drop out of Google\'s index?', status: 'ok', detail: 'No page was seen dropping out of the index in the later period.' }
	);
	if (updates.length) {
		const names = updates.map((u) => `${u.name} (${u.begin}${u.end ? ' to ' + u.end : ', still rolling out'})`).join('; ');
		steps.push(
			rolling
				? { n: 8, question: 'Is a Google update still rolling out?', status: 'wait', detail: `Yes, or it ended within the last few days: ${names}. Rankings move for weeks during an update and often partly come back; judge once it has finished, not before. Deleting, redirecting or rewriting pages now is the usual mistake.` }
				: { n: 8, question: 'Did a Google update overlap?', status: 'info', detail: `Yes, and it has finished: ${names}. It is a possible explanation, not proof; compare the lost searches above with what now ranks.` }
		);
	} else {
		steps.push({ n: 8, question: 'Is a Google update involved?', status: 'ok', detail: 'No ranking update overlaps these two periods.' });
	}
	steps.push(
		seasonal
			? { n: 9, question: 'Is it the season?', status: Math.abs(seasonal.impressionsPct) >= 0.1 && Math.sign(seasonal.impressionsPct) === Math.sign(split.impressionsPct ?? 0) ? 'check' : 'ok', detail: `Over the same two windows a year ago, impressions moved ${fmtPct(seasonal.impressionsPct)} (about ${seasonal.expectedClicks >= 0 ? '+' : ''}${seasonal.expectedClicks} clicks on this period's earlier level). ${Math.abs(seasonal.impressionsPct) >= 0.1 && Math.sign(seasonal.impressionsPct) === Math.sign(split.impressionsPct ?? 0) ? 'That points the same way, so part of this is probably seasonal.' : 'That does not explain it.'}` }
			: { n: 9, question: 'Is it the season?', status: 'info', detail: 'The stored history does not reach back a year for these windows (or last year had too little traffic), so seasonality cannot be checked.' }
	);

	const hold = i.comparable && (rolling || (!significant && change < 0));
	let headline: string;
	if (!i.comparable) headline = 'Not enough history to compare yet.';
	else if (!significant) headline = change < 0 ? `Clicks are ${fmtPct(pctChange(now.clicks, prev.clicks))}, but that is within noise: change nothing.` : 'No meaningful change in clicks.';
	else if (change > 0) headline = `Clicks are up ${fmtAbs(pctChange(now.clicks, prev.clicks))}.`;
	else if (rolling) headline = `Clicks are down ${fmtAbs(pctChange(now.clicks, prev.clicks))} while a Google update is still rolling out: wait, then diagnose.`;
	else if (causes[0]) headline = `Clicks are down ${fmtAbs(pctChange(now.clicks, prev.clicks))}; the biggest cause is "${CAUSE_LABEL[causes[0].cause].toLowerCase()}".`;
	else headline = `Clicks are down ${fmtAbs(pctChange(now.clicks, prev.clicks))}, spread thinly across many searches.`;

	return {
		comparable: i.comparable,
		clicks: { now: now.clicks, prev: prev.clicks, change, pct: pctChange(now.clicks, prev.clicks), z: r1(z), significant },
		split, causes, concentration: { topShare, concentrated, pages: top }, brand, seasonal, updates, hold, headline, steps
	};
}

function addDaysStr(date: string, n: number): string {
	return new Date(Date.parse(date + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
}
