import { db } from './db';
import type { SiteRow } from './clients';
import { addDays } from './dates';
import { siteEnd } from './queries';
import { listUpdates } from './gupdates';
import { countChangeReal } from '../alerts';

/**
 * Did a Google ranking update help or hurt this site? For each update in the stored history: clicks per day in the W days after it
 * finished against the W days before it began (equal windows, so weekdays balance), checked against what the site was already doing
 * (the W days before that) and, when the history reaches back, against the same dates a year earlier (seasonality).
 *
 * The verdict is "likely helped", "likely hurt" or "no clear effect": a correlation in time, not proof. Something else that changed
 * in the same weeks (a launch, a migration, a seasonal peak the year-ago check cannot see) moves the same numbers.
 */
export type UpdateVerdict = 'helped' | 'hurt' | 'none' | 'rolling' | 'too_soon' | 'no_data';
export const VERDICT_TEXT: Record<UpdateVerdict, string> = {
	helped: 'Likely helped',
	hurt: 'Likely hurt',
	none: 'No clear effect',
	rolling: 'Still rolling out',
	too_soon: 'Too soon to tell',
	no_data: 'Not enough history'
};

export interface UpdateImpact {
	id: string;
	name: string;
	kind: string;
	begin: string;
	end: string | null;
	window: number;
	beforePerDay: number | null;
	afterPerDay: number | null;
	/** after against before, as a fraction (+0.12 = 12% more clicks per day) */
	change: number | null;
	/** the site's own drift before the update (the window before against the one before that) */
	trendBefore: number | null;
	/** the same two windows one year earlier, when stored */
	lastYear: number | null;
	positionBefore: number | null;
	positionAfter: number | null;
	verdict: UpdateVerdict;
	why: string;
}

function windowSum(siteId: number, start: string, end: string) {
	return db().prepare('SELECT COUNT(*) days, COALESCE(SUM(clicks), 0) clicks, COALESCE(SUM(impressions), 0) impressions, COALESCE(SUM(position * impressions), 0) pw FROM site_daily WHERE site_id = ? AND date BETWEEN ? AND ?').get(siteId, start, end) as { days: number; clicks: number; impressions: number; pw: number };
}

/** The pure judgement, separate so it can be tested on numbers. */
export function judge(o: { before: number; after: number; days: number; trend: number | null; lastYear: number | null }): { verdict: UpdateVerdict; why: string } {
	const change = o.before > 0 ? o.after / o.before - 1 : null;
	if (change == null || o.before < 20 * (o.days / 28)) return { verdict: 'none', why: 'Too few clicks before the update to judge a change.' };
	if (!countChangeReal(o.after, o.before) || Math.abs(change) < 0.1) return { verdict: 'none', why: 'Clicks after are within normal variation of clicks before.' };
	if (o.trend != null && Math.abs(change - o.trend) < 0.08) return { verdict: 'none', why: 'The site was already moving this way before the update.' };
	if (o.lastYear != null && Math.sign(o.lastYear) === Math.sign(change) && Math.abs(change - o.lastYear) < 0.1) return { verdict: 'none', why: 'The same dates a year earlier moved about as much, so this looks seasonal.' };
	return change > 0 ? { verdict: 'helped', why: 'Clicks rose beyond normal variation, the trend before, and last year’s pattern.' } : { verdict: 'hurt', why: 'Clicks fell beyond normal variation, the trend before, and last year’s pattern.' };
}

export function updateImpacts(site: Pick<SiteRow, 'id' | 'synced_through' | 'backfilled_to'>, window = 28): UpdateImpact[] {
	const end = siteEnd(site);
	const oldest = site.backfilled_to ?? end;
	const out: UpdateImpact[] = [];
	for (const u of listUpdates()) {
		if (u.begin > end || u.begin < addDays(oldest, window)) continue;
		const base = { id: u.id, name: u.name, kind: u.kind, begin: u.begin, end: u.end, window, beforePerDay: null, afterPerDay: null, change: null, trendBefore: null, lastYear: null, positionBefore: null, positionAfter: null } as const;
		const bStart = addDays(u.begin, -window), bEnd = addDays(u.begin, -1);
		const before = windowSum(site.id, bStart, bEnd);
		if (before.days < window * 0.9) {
			out.push({ ...base, verdict: 'no_data', why: 'Stored history does not cover the weeks before it.' });
			continue;
		}
		if (!u.end) {
			out.push({ ...base, beforePerDay: before.clicks / before.days, verdict: 'rolling', why: 'Wait until it has finished: a judgement mid-rollout is not reliable.' });
			continue;
		}
		const aStart = addDays(u.end, 1), aEnd = addDays(u.end, window);
		const after = windowSum(site.id, aStart, aEnd < end ? aEnd : end);
		if (after.days < 7) {
			out.push({ ...base, beforePerDay: before.clicks / before.days, verdict: 'too_soon', why: 'Less than a week of data since it finished.' });
			continue;
		}
		const pre = windowSum(site.id, addDays(bStart, -window), addDays(bStart, -1));
		const ly = { b: windowSum(site.id, addDays(bStart, -364), addDays(bEnd, -364)), a: windowSum(site.id, addDays(aStart, -364), addDays(aEnd, -364)) };
		const perDay = (w: { clicks: number; days: number }) => (w.days ? w.clicks / w.days : 0);
		const trend = pre.days >= window * 0.9 && perDay(pre) > 0 ? perDay(before) / perDay(pre) - 1 : null;
		const lastYear = ly.b.days >= window * 0.9 && ly.a.days >= 7 && perDay(ly.b) > 0 ? perDay(ly.a) / perDay(ly.b) - 1 : null;
		// clicks over equal lengths: the after window scaled to the before window's days, for the noise test
		const afterScaled = perDay(after) * before.days;
		const j = judge({ before: before.clicks, after: afterScaled, days: before.days, trend, lastYear });
		out.push({
			...base,
			beforePerDay: perDay(before),
			afterPerDay: perDay(after),
			change: perDay(before) > 0 ? perDay(after) / perDay(before) - 1 : null,
			trendBefore: trend,
			lastYear,
			positionBefore: before.impressions ? before.pw / before.impressions : null,
			positionAfter: after.impressions ? after.pw / after.impressions : null,
			...j,
			why: after.days < window ? `${j.why} Only ${after.days} of ${window} days after it are in so far.` : j.why
		});
	}
	return out.sort((a, b) => b.begin.localeCompare(a.begin));
}
