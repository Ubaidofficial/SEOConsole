/** A key event SEOConsole marked in GA4 (from its audit log): the event name and when. */
export interface MarkedKeyEvent { event: string; at: number }

const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * What to say when GA4 has recorded no key events at all. The stored data cannot tell "none marked" from "marked, but nobody has
 * done it yet", so it never claims the first. Events SEOConsole marked itself are named, since its audit log knows those.
 */
export function noKeyEventsText(marked: MarkedKeyEvent[]): string {
	if (marked.length) {
		const list = marked.map((m) => `${m.event} (marked ${day(m.at)})`).join(', ');
		return `GA4 has not recorded any key events yet. Marked by SEOConsole: ${list}. They appear here once someone triggers them; GA4 Realtime shows them within minutes.`;
	}
	return 'GA4 has not recorded any key events for this site yet. If none are marked, mark the events that matter (a sign-up, an application, a purchase) in GA4 (Admin → Events), or use Track an event as a key event on the Tag Manager tab. If some are marked already, nobody has triggered them in the stored period.';
}
