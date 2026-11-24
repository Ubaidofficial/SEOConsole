/**
 * The windows whose Google-side data is fetched ahead of time on every sync (GA4 unique users, search appearance). Adding to this list
 * adds API calls to every sync, so it is NOT the list the picker offers: see QUICK_PERIODS.
 */
export const PERIODS = [7, 28, 90, 180, 480] as const;

/** The picker's buttons, and its menu. Any whole number of days from 1 to MAX_DAYS is accepted in the address: a chosen start date becomes one. */
export const QUICK_PERIODS = [1, 3, 7, 28] as const;
export const MENU_PERIODS = [90, 180, 480] as const;
export const MAX_DAYS = 1100;

/** "24h" is the newest day of data, not the last 24 hours: Search Console reports whole days and runs about two days behind. */
export const periodLabel = (d: number) => (d === 1 ? '24h' : d === 480 ? '16m' : d === 180 ? '6m' : d === 90 ? '3m' : `${d}d`);

/** One-key shortcuts for the period picker (as Plausible's date menu): pressed anywhere outside a text field, with no modifier. */
export const PERIOD_KEYS: Record<string, number> = { d: 1, t: 3, w: 7, m: 28, q: 90, h: 180, y: 480 };
export const periodKey = (d: number) => Object.entries(PERIOD_KEYS).find(([, n]) => n === d)?.[0]?.toUpperCase() ?? '';

const DAY = 86_400_000;
const utc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
export const isIsoDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(utc(s)).toISOString().slice(0, 10) === s;
export const shiftDay = (iso: string, n: number) => new Date(utc(iso) + n * DAY).toISOString().slice(0, 10);

/** How many days run from `from` to `latest`, both included: the window "since a date". Null for a date after the newest data or too far back. */
export function daysSince(from: string, latest: string): number | null {
	if (!isIsoDay(from) || !isIsoDay(latest)) return null;
	const n = Math.round((utc(latest) - utc(from)) / DAY) + 1;
	return n >= 1 && n <= MAX_DAYS ? n : null;
}
