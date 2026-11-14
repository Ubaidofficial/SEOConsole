/**
 * Niche fit: what this site actually earns clicks for, where it is only being shown far down for things it does not win, and how well a
 * list of candidate keywords fits. Pure functions, no I/O.
 *
 * It exists for the "chase every keyword" mistake. A site can collect thousands of impressions on topics far from its strength (position
 * 50 and below, almost no clicks) while the topics that do bring clicks are small. Showing that split is free, from your own data.
 *
 * Honest limits: topics are groups of queries sharing a word (see topicClusters), not meanings; "fit" is word overlap with the queries that
 * already win, so a keyword about the same thing in different words reads as a poor fit, and a keyword that shares a common word reads
 * as a better one than it is. Use it to rank a long list, not to rule on one keyword.
 */
import type { Metrics } from './analytics';
import { queryTokens, topicClusters, type TopicCluster } from './groups';

export type TopicStatus = 'winning' | 'ranks-no-clicks' | 'reach-only' | 'minor';
export const STATUS_LABEL: Record<TopicStatus, string> = {
	winning: 'Earning clicks',
	'ranks-no-clicks': 'Page one, almost no clicks',
	'reach-only': 'Shown far down, not winning',
	minor: 'Small'
};
export const STATUS_ADVICE: Record<TopicStatus, string> = {
	winning: 'This is your ground. Build around it.',
	'ranks-no-clicks': 'You are on page one but the click rate is a fraction of normal: look at the live results (an answer box, an AI summary, a different intent) before changing the page.',
	'reach-only': 'Google shows you here, deep in the results, and almost nobody clicks. More pages on this topic will not fix that; either build real depth or leave it.',
	minor: 'Too small to judge.'
};

/** Thresholds, all rough rules of thumb of this app's own. */
export const MIN_TOPIC_IMPRESSIONS = 100;
export const NO_CLICKS_CTR = 0.005;
/** Page one. Below it a click rate under 0.5% is normal, not a sign that something is wrong. */
export const TOP_POSITION = 10;
export const FAR_POSITION = 35;

export interface NicheTopic { topic: string; status: TopicStatus; queries: number; clicks: number; impressions: number; position: number; examples: string[] }
export interface NicheProfile {
	queriesUsed: number;
	topics: NicheTopic[];
	/** share of all impressions that sit in "shown far down, not winning" topics */
	reachOnlyShare: number;
	/** share of all impressions in topics that rank well and are not clicked */
	noClicksShare: number;
	/** word -> weight, from the queries that earn clicks or rank in the top ten: what the site is about */
	vocabulary: Map<string, number>;
	headline: string;
}

export function statusOf(c: Pick<TopicCluster, 'clicks' | 'impressions' | 'position'>): TopicStatus {
	const ctr = c.impressions ? c.clicks / c.impressions : 0;
	if (c.impressions >= MIN_TOPIC_IMPRESSIONS && ctr < NO_CLICKS_CTR && c.position <= TOP_POSITION) return 'ranks-no-clicks';
	if (c.impressions >= MIN_TOPIC_IMPRESSIONS && ctr < NO_CLICKS_CTR && c.position >= FAR_POSITION) return 'reach-only';
	if (c.clicks >= 1) return 'winning';
	return 'minor';
}

export function nicheProfile(rows: (Metrics & { query: string })[], brandTerms: string[] = []): NicheProfile {
	const { clusters } = topicClusters(rows, { minQueries: 3, limit: 60, brandTerms });
	const topics: NicheTopic[] = clusters.map((c) => ({ topic: c.topic, status: statusOf(c), queries: c.queries, clicks: c.clicks, impressions: c.impressions, position: c.position, examples: c.top }));

	const skip = new Set(brandTerms.flatMap(queryTokens));
	const vocabulary = new Map<string, number>();
	for (const r of rows) {
		const earns = r.clicks > 0;
		const ranks = r.position > 0 && r.position <= 10 && r.impressions >= 20;
		if (!earns && !ranks) continue;
		const w = r.clicks * 5 + (ranks ? Math.min(5, r.impressions / 200) : 0);
		for (const t of queryTokens(r.query)) if (!skip.has(t)) vocabulary.set(t, (vocabulary.get(t) ?? 0) + Math.max(w, 0.5));
	}

	const total = rows.reduce((a, r) => a + r.impressions, 0);
	const share = (s: TopicStatus) => (total ? topics.filter((t) => t.status === s).reduce((a, t) => a + t.impressions, 0) / total : 0);
	const reachOnlyShare = share('reach-only');
	const noClicksShare = share('ranks-no-clicks');
	const winning = topics.filter((t) => t.status === 'winning').slice(0, 3).map((t) => t.topic);
	const parts: string[] = [];
	if (reachOnlyShare >= 0.05) parts.push(`${Math.round(reachOnlyShare * 100)}% of impressions are for topics where you are shown far down and rarely clicked`);
	if (noClicksShare >= 0.05) parts.push(`${Math.round(noClicksShare * 100)}% are for topics where you are on page one and almost nobody clicks`);
	if (!parts.length) parts.push('No topic stands out as shown far down or ignored on page one');
	const headline = !rows.length ? 'No search data yet.' : `${parts.join('; ')}${winning.length ? `. The topics that do earn clicks: ${winning.join(', ')}` : ''}.`;
	return { queriesUsed: rows.length, topics, reachOnlyShare, noClicksShare, vocabulary, headline };
}

export type Fit = 'core' | 'adjacent' | 'off';
export interface KeywordFit { keyword: string; fit: Fit; score: number; matched: string[]; note: string }
export const FIT_LABEL: Record<Fit, string> = { core: 'Core', adjacent: 'Adjacent', off: 'Off-niche' };

/** How much of a keyword's own words the site's winning vocabulary covers. 1 = every word is one the site already wins with. */
export function scoreKeywords(profile: NicheProfile, keywords: string[]): KeywordFit[] {
	const reachOnly = new Map(profile.topics.filter((t) => t.status === 'reach-only').map((t) => [t.topic, t]));
	return keywords.map((keyword) => {
		const toks = queryTokens(keyword);
		const matched = toks.filter((t) => profile.vocabulary.has(t));
		const score = toks.length ? matched.length / toks.length : 0;
		const fit: Fit = !toks.length ? 'off' : score >= 0.67 ? 'core' : score >= 0.34 ? 'adjacent' : 'off';
		const weak = toks.find((t) => reachOnly.has(t) && !profile.vocabulary.has(t));
		const note = !toks.length ? 'No usable words.'
			: weak ? `You already appear for "${weak}" searches but rank far down and are rarely clicked; a new page is unlikely to change that.`
			: fit === 'core' ? 'Close to what already earns you clicks.'
			: fit === 'adjacent' ? 'Shares some words with what earns you clicks.'
			: 'Shares almost nothing with what earns you clicks.';
		return { keyword, fit, score: Math.round(score * 100) / 100, matched, note };
	}).sort((a, b) => b.score - a.score || a.keyword.localeCompare(b.keyword));
}
