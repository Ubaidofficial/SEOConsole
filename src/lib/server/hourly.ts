import { db } from './db';

export interface HourRow { hour: string; label: string; clicks: number; impressions: number }

/** "2026-11-20T14:00:00-08:00" → "14:00": the hour on Google's clock (Pacific time), as Search Console shows it. */
export const hourLabel = (hour: string) => (/T(\d{2}:\d{2})/.exec(hour)?.[1] ?? hour);
/** Hours since the epoch for a key with an offset, so hours compare correctly across a daylight-saving change. */
const hourIndex = (hour: string) => Math.round(Date.parse(hour) / 3_600_000);

/**
 * Search Console's last 24 hours: the 24 hours ending at the newest hour Google has data for (hourly data trails by a few hours and may
 * still grow), the 24 before them for comparison, and the pages with the most clicks in the newer 24 when Google answered per page.
 * Null until the first sync after this feature, or when the property has no hourly data.
 */
export function hourlyReport(siteId: number, o: { pages?: number } = {}) {
	const d = db();
	const meta = d.prepare('SELECT hourly_at at, hourly_pages pages FROM sites WHERE id = ?').get(siteId) as { at: number | null; pages: number } | undefined;
	if (!meta?.at) return null;
	const rows = (d.prepare("SELECT hour, clicks, impressions, position FROM sa_hourly WHERE site_id = ? AND page = ''").all(siteId) as { hour: string; clicks: number; impressions: number; position: number }[])
		.map((r) => ({ ...r, i: hourIndex(r.hour) }))
		.filter((r) => Number.isFinite(r.i))
		.sort((a, b) => a.i - b.i);
	if (!rows.length) return { fetchedAt: meta.at, empty: true as const };
	const newest = rows[rows.length - 1].i;
	const inWin = (i: number, from: number, to: number) => i > from && i <= to;
	const sum = (from: number, to: number) => {
		const w = rows.filter((r) => inWin(r.i, from, to));
		const impressions = w.reduce((a, r) => a + r.impressions, 0);
		return { clicks: w.reduce((a, r) => a + r.clicks, 0), impressions, position: impressions ? w.reduce((a, r) => a + r.position * r.impressions, 0) / impressions : null, hours: w.length };
	};
	const last24 = sum(newest - 24, newest);
	const prev24 = sum(newest - 48, newest - 24);
	// Every hour of the last 48, zero where Google sent nothing, so the bars keep their spacing.
	const byIndex = new Map(rows.map((r) => [r.i, r]));
	const newestRow = rows[rows.length - 1];
	const offsetOf = (h: string) => /([+-]\d{2}:\d{2}|Z)$/.exec(h)?.[1] ?? 'Z';
	const hours: (HourRow & { recent: boolean })[] = [];
	for (let i = newest - 47; i <= newest; i++) {
		const r = byIndex.get(i);
		// A missing hour is labelled from the newest row's clock (good enough across one daylight-saving change for a bar label).
		const local = r ? hourLabel(r.hour) : hourLabel(new Date((i + offsetHours(offsetOf(newestRow.hour))) * 3_600_000).toISOString());
		hours.push({ hour: r?.hour ?? '', label: local, clicks: r?.clicks ?? 0, impressions: r?.impressions ?? 0, recent: i > newest - 24 });
	}
	let pages: { page: string; clicks: number; impressions: number }[] | null = null;
	if (meta.pages) {
		const by = new Map<string, { page: string; clicks: number; impressions: number }>();
		for (const r of d.prepare("SELECT hour, page, clicks, impressions FROM sa_hourly WHERE site_id = ? AND page != ''").all(siteId) as { hour: string; page: string; clicks: number; impressions: number }[]) {
			if (!inWin(hourIndex(r.hour), newest - 24, newest)) continue;
			const cur = by.get(r.page) ?? { page: r.page, clicks: 0, impressions: 0 };
			cur.clicks += r.clicks;
			cur.impressions += r.impressions;
			by.set(r.page, cur);
		}
		pages = [...by.values()].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, o.pages ?? 10);
	}
	return {
		fetchedAt: meta.at,
		empty: false as const,
		/** The newest hour with data, as Google sent it. */
		through: newestRow.hour,
		last24,
		prev24: prev24.hours ? prev24 : null,
		hours,
		/** Null when Google did not answer the per-page hourly request. */
		pages
	};
}

function offsetHours(off: string): number {
	if (off === 'Z') return 0;
	const m = /([+-])(\d{2}):(\d{2})/.exec(off);
	return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) + Number(m[3]) / 60) : 0;
}
