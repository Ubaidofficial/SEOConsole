/** A Clarity live-insights metric: one list per metric, each row naming the dimension value under a key named after the dimension. */
export type ClarityMetricRows = { metricName: string; information: Record<string, string | number>[] };

export interface ClarityDimRow {
	value: string;
	sessions: number;
	botSessions: number;
	/** Shares of sessions with the behaviour, 0–1; null where Clarity sent nothing for this value. */
	rageClicks: number | null;
	deadClicks: number | null;
	quickBacks: number | null;
	scriptErrors: number | null;
	/** Average scroll depth, 0–1. */
	scrollDepth: number | null;
	/** Average active time, seconds. */
	activeTime: number | null;
}

const num = (v: unknown) => {
	const n = Number(v);
	return v === undefined || v === null || v === '' || !Number.isFinite(n) ? null : n;
};

/**
 * One row per dimension value (channel, device…) out of a Clarity snapshot taken with that dimension. The field names (totalSessionCount,
 * sessionsWithMetricPercentage as a 0–100 percentage, averageScrollDepth, activeTime) are the ones the rest of the app reads from Clarity;
 * a field Clarity does not send leaves null rather than a guessed zero. The dimension key is matched without regard to case.
 */
export function clarityByDimension(metrics: ClarityMetricRows[], dimension: string): ClarityDimRow[] {
	const out = new Map<string, ClarityDimRow>();
	const want = dimension.toLowerCase();
	const pct: Record<string, 'rageClicks' | 'deadClicks' | 'quickBacks' | 'scriptErrors'> = { RageClickCount: 'rageClicks', DeadClickCount: 'deadClicks', QuickbackClick: 'quickBacks', ScriptErrorCount: 'scriptErrors' };
	for (const m of metrics ?? []) {
		for (const row of m.information ?? []) {
			const key = Object.keys(row).find((k) => k.toLowerCase() === want);
			if (!key) continue;
			const value = String(row[key] ?? '') || '(not set)';
			const cur = out.get(value) ?? { value, sessions: 0, botSessions: 0, rageClicks: null, deadClicks: null, quickBacks: null, scriptErrors: null, scrollDepth: null, activeTime: null };
			if (m.metricName === 'Traffic') {
				cur.sessions += num(row.totalSessionCount) ?? 0;
				cur.botSessions += num(row.totalBotSessionCount) ?? 0;
			} else if (pct[m.metricName]) {
				const p = num(row.sessionsWithMetricPercentage);
				if (p != null) cur[pct[m.metricName]] = p / 100;
			} else if (m.metricName === 'ScrollDepth') {
				const p = num(row.averageScrollDepth);
				if (p != null) cur.scrollDepth = p / 100;
			} else if (m.metricName === 'EngagementTime') {
				cur.activeTime = num(row.activeTime);
			}
			out.set(value, cur);
		}
	}
	return [...out.values()].sort((a, b) => b.sessions - a.sessions);
}

/** Clarity project IDs are short lowercase letters and digits (the id in the script's address). */
export const isClarityId = (id: string) => /^[a-z0-9]{6,16}$/.test(id);
/**
 * The project's dashboard on clarity.microsoft.com. This address is the one Clarity's own pages link to (seen, not documented), so only
 * the project is put in it: recordings and heatmaps are filtered by page inside Clarity, not through the address.
 */
export const clarityDashboardUrl = (projectId: string | null | undefined) => (projectId && isClarityId(projectId) ? `https://clarity.microsoft.com/projects/view/${projectId}/dashboard` : 'https://clarity.microsoft.com/projects');
