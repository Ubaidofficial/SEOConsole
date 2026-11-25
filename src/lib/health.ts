/**
 * The technical health score: one number from 0 to 100 for "is anything technical in the way?", from the to-do list the app
 * already keeps, so it says nothing the findings do not. 100 minus a penalty for each open technical finding: 20 for a blocking
 * one, 4 for another, the latter up to twice as much when the finding puts many clicks at stake. Pure, unit-tested.
 *
 * It is this app's own rule of thumb, not Google's, and a site with little data may score well simply because little can be
 * checked. Content findings (striking distance, decay, CTR gaps...) are left out: they are opportunities, not technical faults.
 */
import type { ActionItem, ActionType } from './actions';

export const TECH_TYPES: ReadonlySet<ActionType> = new Set<ActionType>([
	'connection', 'tracking', 'blocked', 'robots', 'deindexed', 'dead', 'not-indexed', 'onpage', 'sitemap', 'lastmod', 'submitted', 'vitals', 'broken-links', 'audit', 'publishing', 'reclaim'
]);
export const BLOCKING_PENALTY = 20;
export const OTHER_PENALTY = 4;

export interface HealthScore { score: number; grade: 'good' | 'fair' | 'poor'; findings: { type: ActionType; title: string; blocking: boolean; penalty: number; href: string }[]; checked: number }

export function healthScore(items: Pick<ActionItem, 'type' | 'title' | 'blocking' | 'impact' | 'href'>[]): HealthScore {
	const tech = items.filter((a) => TECH_TYPES.has(a.type));
	const findings = tech
		.map((a) => {
			const weight = a.impact != null && a.impact > 0 ? 1 + Math.min(1, Math.log10(1 + a.impact) / 3) : 1;
			const penalty = a.blocking ? BLOCKING_PENALTY : Math.round(OTHER_PENALTY * weight * 10) / 10;
			return { type: a.type, title: a.title, blocking: a.blocking, penalty, href: a.href };
		})
		.sort((x, y) => y.penalty - x.penalty);
	const score = Math.max(0, Math.round(100 - findings.reduce((s, f) => s + f.penalty, 0)));
	return { score, grade: score >= 90 ? 'good' : score >= 70 ? 'fair' : 'poor', findings, checked: tech.length };
}
