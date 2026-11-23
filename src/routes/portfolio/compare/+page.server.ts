import type { PageServerLoad } from './$types';
import { daysParam } from '$lib/server/params';
import { allSites, dailySeries, newestDataDay, periodFor } from '$lib/server/queries';
import { displayName } from '$lib/server/clients';
import { updatesBetween } from '$lib/server/gupdates';
import { eachDay } from '$lib/server/dates';

const MAX_COMPARE = 4;

/**
 * Two to four sites on one chart: for a migration (old domain against new), or to see whether a change hit one site or all of them.
 * Each site's daily clicks or impressions, either as they are or indexed (each site's first week = 100), so a big and a small site
 * can be read on one axis. Days run to the newest day among the chosen sites; a site with no data yet on a day leaves a gap.
 */
export const load: PageServerLoad = ({ url }) => {
	const sites = allSites().filter((s) => !['siteUnverifiedUser', 'none'].includes(s.permission) && s.synced_through);
	const chosen = [...new Set(url.searchParams.getAll('s').map(Number))].map((id) => sites.find((s) => s.id === id)).filter((s): s is (typeof sites)[number] => !!s).slice(0, MAX_COMPARE);
	const metric = url.searchParams.get('m') === 'impressions' ? 'impressions' : 'clicks';
	const mode = url.searchParams.get('mode') === 'actual' ? 'actual' : 'index';
	const smooth = url.searchParams.get('smooth') !== '0';
	const latest = newestDataDay(chosen.length ? chosen : sites);
	const days = daysParam(url, latest);
	const options = sites.map((s) => ({ id: s.id, name: s.label || displayName(s.site_url) })).sort((a, b) => a.name.localeCompare(b.name));
	if (chosen.length < 2) return { options, chosen: chosen.map((s) => s.id), metric, mode, smooth, days, latest, chart: null };
	const end = chosen.map((s) => periodFor(s, days).end).sort().at(-1)!;
	const start = chosen.map((s) => periodFor(s, days).start).sort()[0];
	const xs = eachDay(start, end);
	const series = chosen.map((s) => {
		const byDay = new Map(dailySeries(s.id, start, end, false).map((r) => [r.date, r[metric]]));
		let values: (number | null)[] = xs.map((d) => (d <= (s.synced_through ?? '') ? (byDay.get(d) ?? 0) : null));
		const total = values.reduce<number>((a, v) => a + (v ?? 0), 0);
		if (smooth) values = values.map((_, i) => {
			const w = values.slice(Math.max(0, i - 6), i + 1).filter((v): v is number => v != null);
			return values[i] == null || w.length < 7 ? null : w.reduce((a, b) => a + b, 0) / w.length;
		});
		let base: number | null = null;
		if (mode === 'index') {
			const first = values.filter((v): v is number => v != null).slice(0, 7);
			base = first.length && first.reduce((a, b) => a + b, 0) > 0 ? first.reduce((a, b) => a + b, 0) / first.length : null;
			values = values.map((v) => (v == null || !base ? null : (v / base) * 100));
		}
		const shown = values.filter((v): v is number => v != null);
		return { id: s.id, name: s.label || displayName(s.site_url), values, total, noBase: mode === 'index' && !base, change: shown.length >= 2 && shown[0] ? shown.at(-1)! / shown[0] - 1 : null };
	});
	return { options, chosen: chosen.map((s) => s.id), metric, mode, smooth, days, latest, chart: { xs, series, updates: updatesBetween(start, end).map((u) => ({ x: u.begin < start ? start : u.begin, label: u.name })) } };
};
