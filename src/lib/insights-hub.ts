/**
 * Headline numbers for the Insights page, from the site's open findings: each finding's `href` names the tab where it is fixed, so
 * counting them by tab gives every card a number without running each report again. The biggest single estimate is shown, not a
 * sum: findings overlap (one search can be in two of them), so adding them up would overstate.
 */
export interface TabCount {
	findings: number;
	blocking: number;
	/** the biggest estimated clicks per 28 days of any one finding on that tab, or null when none has an estimate */
	best: number | null;
}

/** The tab path a finding points to ('' is Overview), or null for a link outside this site. */
export function tabOfHref(href: string, siteId: number): string | null {
	const m = new RegExp(`^/sites/${siteId}(/[a-z0-9-]+)?(?:[/?#]|$)`).exec(href);
	return m ? (m[1] ?? '') : null;
}

/**
 * Findings by the tab they point to. Quick wins is the exception: its findings point at the tab where each is fixed (Internal links,
 * Opportunities…), so its card counts the low-effort ones that are not blocking, as the overview's plan does.
 */
export function insightCounts(open: { href: string; impact: number | null; blocking: boolean; effort?: string }[], siteId: number): Record<string, TabCount> {
	const out: Record<string, TabCount> = {};
	const add = (t: string, a: (typeof open)[number]) => {
		const c = (out[t] ??= { findings: 0, blocking: 0, best: null });
		c.findings++;
		if (a.blocking) c.blocking++;
		if (a.impact != null && a.impact > 0) c.best = Math.max(c.best ?? 0, Math.round(a.impact));
	};
	for (const a of open) {
		const t = tabOfHref(a.href, siteId);
		if (t != null) add(t, a);
		if (a.effort === 'low' && !a.blocking) add('/quickwins', a);
	}
	return out;
}
