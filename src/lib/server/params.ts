import { MAX_DAYS, daysSince } from '../periods';

/**
 * The period a page is asked for, as a number of days ending at the newest data. `?days=` takes any whole number from 1 to MAX_DAYS (the
 * buttons offer 1, 3, 7, 28, 90, 180 and 480). `?from=YYYY-MM-DD` means "since that date" and is turned into days against `latest`, the
 * newest day of data for what is on the page: the end is always the newest data, so every report keeps one consistent window.
 */
export function daysParam(url: URL, latest?: string | null): number {
	const from = url.searchParams.get('from');
	if (from && latest) {
		const n = daysSince(from, latest);
		if (n) return n;
	}
	const n = Number(url.searchParams.get('days'));
	return Number.isInteger(n) && n >= 1 && n <= MAX_DAYS ? n : 28;
}

export function intParam(v: FormDataEntryValue | string | null | undefined): number {
	const n = Number(v);
	if (!Number.isInteger(n) || n <= 0) throw new Error('Invalid id');
	return n;
}
