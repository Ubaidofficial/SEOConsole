/**
 * Cross-source tracking audit: does the traffic Search Console sees show up in GA4, and is Tag Manager sending it there?
 * Pure functions, no I/O, so the rules are unit-tested.
 */
import { clarityInstall, type ClarityInstallInput } from './clarityinstall';

export type Severity = 'critical' | 'warning' | 'info';

export interface Finding {
	id: string;
	severity: Severity;
	title: string;
	detail: string;
}

export interface TrackingTag {
	/** Tag Manager's own ID for the tag; absent in callers that do not need it. */
	id?: string;
	name: string;
	type: string;
	paused: boolean;
	firing: string[];
	measurementId: string | null;
	badTagId?: string | null;
	suggestedId?: string | null;
}

export interface TrackingInput {
	/** null = no Tag Manager container linked / synced. */
	gtm: {
		publicId: string;
		/** false when the container has never been published. */
		published: boolean;
		tags: TrackingTag[];
	} | null;
	/** null = no GA4 property linked. measurementIds is empty when Google did not tell us. */
	ga4: { measurementIds: string[] } | null;
	/** Window totals; ga4OrganicSessions is null when GA4 is not linked or has not synced. */
	traffic: { days: number; gscClicks: number; ga4OrganicSessions: number | null };
	/** Is Clarity's script on the pages? Omitted or null = not checked. */
	clarity?: ClarityInstallInput | null;
}

const GA4_TYPES = new Set(['googtag', 'gaawc', 'gaawe', 'dest_ga']);
/** Tags that load GA4 for a measurement ID and send its page_view: a Google tag, a GA4 Configuration tag, a Google Analytics destination. (GA4 Event tags only send their event.) */
export const GOOGLE_TAG_TYPES = new Set(['googtag', 'gaawc', 'dest_ga']);

export interface DuplicateGroup {
	measurementId: string;
	keep: TrackingTag;
	pause: TrackingTag[];
}

/** Earliest first: a Google tag belongs on the Initialization trigger. Old snapshots name built-in triggers by ID only. */
const INIT = /^(consent )?initialization - all pages$|^trigger 214747957[23]$/i;
const rankOf = (t: TrackingTag) => [t.firing.some((f) => INIT.test(f)) ? 0 : 1, /added by seoconsole/i.test(t.name) ? 1 : 0, Number(t.id) || Number.MAX_SAFE_INTEGER] as const;

/**
 * Two or more unpaused tags that each load GA4 for the same measurement ID: the tag can load twice and page views can be counted twice.
 * Keeps one per ID (the one on an Initialization trigger, else one SEOConsole did not add, else the oldest) and lists the rest to pause.
 */
export function duplicateGoogleTags(tags: TrackingTag[]): DuplicateGroup[] {
	const by = new Map<string, TrackingTag[]>();
	for (const t of tags) if (GOOGLE_TAG_TYPES.has(t.type) && !t.paused && t.measurementId && t.firing.length) by.set(t.measurementId, [...(by.get(t.measurementId) ?? []), t]);
	const out: DuplicateGroup[] = [];
	for (const [measurementId, group] of by) {
		if (group.length < 2) continue;
		const sorted = [...group].sort((a, b) => {
			const x = rankOf(a), y = rankOf(b);
			return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
		});
		out.push({ measurementId, keep: sorted[0], pause: sorted.slice(1) });
	}
	return out;
}
const list = (xs: string[], n = 5) => xs.slice(0, n).join(', ') + (xs.length > n ? ` and ${xs.length - n} more` : '');

/**
 * GA4 sessions vs Search Console clicks. Sessions and clicks are different measurements, so a gap is a prompt to look,
 * not proof. The 0.4 threshold and the 100-click floor are my own heuristics, not Google figures.
 */
export const GAP_RATIO = 0.4;
export const GAP_MIN_CLICKS = 100;

export function auditTracking(input: TrackingInput): Finding[] {
	const out: Finding[] = [];
	const { gtm, ga4, traffic } = input;

	if (gtm && !gtm.published) {
		out.push({ id: 'gtm-unpublished', severity: 'critical', title: 'The container has no published version', detail: `${gtm.publicId} has never been published, so none of its tags run on the site.` });
	}

	if (gtm?.published) {
		const gaTags = gtm.tags.filter((t) => GA4_TYPES.has(t.type));
		const ids = [...new Set(gaTags.map((t) => t.measurementId).filter((m): m is string => !!m))];
		const malformed = gaTags.filter((t) => t.badTagId);
		for (const t of malformed) {
			const fix = t.suggestedId ? `only ${t.suggestedId}` : 'only the measurement ID (G-…)';
			out.push({
				id: 'gtm-tag-id-malformed', severity: 'critical', title: 'A Google tag has something other than an ID in its Tag ID field',
				detail: `The tag “${t.name}” has this where its Tag ID should be: “${t.badTagId}${(t.badTagId ?? '').length >= 120 ? '…' : ''}”. Tag Manager passes that text to Google as the ID, so the tag cannot send anything and GA4 records no visits from this container (a pasted gtag.js snippet is the usual cause). In Tag Manager open the tag, set the Tag ID to ${fix}, then Save, Submit and Publish.${t.suggestedId && ga4 && ga4.measurementIds.length && !ga4.measurementIds.includes(t.suggestedId) ? ` Note: ${t.suggestedId} is not the linked property's measurement ID (${list(ga4.measurementIds)}).` : ''}`
			});
		}
		if (!gaTags.length) {
			out.push({ id: 'gtm-no-ga4-tag', severity: 'warning', title: 'No Google tag or GA4 tag in the live container', detail: 'GA4 may be installed on the site some other way (a gtag.js snippet or a plugin). If it is meant to load through Tag Manager, nothing is sending data.' });
		} else if (ga4 && ga4.measurementIds.length && ids.length) {
			if (!ids.some((m) => ga4.measurementIds.includes(m))) {
				out.push({ id: 'ga4-id-mismatch', severity: 'critical', title: 'Tag Manager sends to a different GA4 property', detail: `The container's GA4 tags use ${list(ids)}, but the linked GA4 property's web stream is ${list(ga4.measurementIds)}. Data may be going to another property.` });
			}
		} else if (ga4 && ids.length && !ga4.measurementIds.length) {
			out.push({ id: 'ga4-id-unknown', severity: 'info', title: 'Could not compare measurement IDs', detail: `The container sends to ${list(ids)}; Google did not return the linked property's measurement ID, so the match could not be checked.` });
		} else if (ga4 && !ids.length && !malformed.length) {
			out.push({ id: 'ga4-id-hidden', severity: 'info', title: 'GA4 tag IDs could not be read', detail: 'The container has GA4 tags, but their measurement IDs are not literal values or constant variables, so the match could not be checked.' });
		}

		for (const g of duplicateGoogleTags(gtm.tags)) {
			const fires = (t: TrackingTag) => `“${t.name}” (on ${t.firing.join(', ')})`;
			out.push({
				id: 'gtm-duplicate-google-tag', severity: 'warning', title: `${g.pause.length + 1} tags load GA4 for ${g.measurementId}`,
				detail: `${list([g.keep, ...g.pause].map(fires))} all send to ${g.measurementId}, so the tag can load twice and page views may be counted twice. Keep ${fires(g.keep)} and pause the other${g.pause.length > 1 ? 's' : ''}, then publish.`
			});
		}

		const ua = gtm.tags.filter((t) => t.type === 'ua');
		if (ua.length) out.push({ id: 'gtm-ua', severity: 'warning', title: 'Universal Analytics tags are still in the container', detail: `${list(ua.map((t) => t.name))}. Universal Analytics no longer processes data; these tags do nothing useful.` });

		// A paused Google tag whose ID an active Google tag still loads is a duplicate put to rest (the duplicate fix does exactly this): a note, not a warning.
		const loaded = new Set(gtm.tags.filter((t) => GOOGLE_TAG_TYPES.has(t.type) && !t.paused && t.firing.length && t.measurementId).map((t) => t.measurementId));
		const restingDup = (t: TrackingTag) => t.paused && GOOGLE_TAG_TYPES.has(t.type) && !!t.measurementId && loaded.has(t.measurementId);
		const paused = gtm.tags.filter((t) => t.paused && !restingDup(t));
		if (paused.length) out.push({ id: 'gtm-paused', severity: 'warning', title: `${paused.length} paused tag${paused.length > 1 ? 's' : ''}`, detail: `${list(paused.map((t) => t.name))}. Paused tags are published but never fire.` });
		const resting = gtm.tags.filter(restingDup);
		if (resting.length) out.push({ id: 'gtm-paused-duplicate', severity: 'info', title: `${resting.length} duplicate Google tag${resting.length > 1 ? 's' : ''} paused`, detail: `${list(resting.map((t) => t.name))}: another active tag already loads ${list([...new Set(resting.map((t) => t.measurementId!))])}. Delete it in Tag Manager whenever you like, or leave it paused.` });

		const idle = gtm.tags.filter((t) => !t.paused && !t.firing.length);
		if (idle.length) out.push({ id: 'gtm-no-trigger', severity: 'info', title: `${idle.length} tag${idle.length > 1 ? 's' : ''} with no firing trigger`, detail: `${list(idle.map((t) => t.name))}. They never fire on their own; that is fine only if they run through tag sequencing.` });
	}

	if (!ga4) {
		if (gtm) out.push({ id: 'ga4-not-linked', severity: 'info', title: 'No GA4 property is linked to this site', detail: 'Link one on the Connect page to cross-check the container and the traffic.' });
	} else if (traffic.ga4OrganicSessions != null && traffic.gscClicks >= GAP_MIN_CLICKS) {
		if (traffic.ga4OrganicSessions === 0) {
			out.push({ id: 'ga4-no-organic', severity: 'critical', title: 'GA4 recorded no organic sessions', detail: `Search Console shows ${traffic.gscClicks.toLocaleString('en-US')} Google clicks in the last ${traffic.days} days, but GA4 has no Organic Search sessions. Tracking is probably broken or pointed at the wrong property.` });
		} else if (traffic.ga4OrganicSessions < traffic.gscClicks * GAP_RATIO) {
			out.push({ id: 'ga4-gap', severity: 'warning', title: 'GA4 sees far fewer organic sessions than Google sent', detail: `${traffic.ga4OrganicSessions.toLocaleString('en-US')} GA4 organic sessions against ${traffic.gscClicks.toLocaleString('en-US')} Search Console clicks in ${traffic.days} days. Consent banners, blockers and tags that do not fire on every page all cause a gap; this is a prompt to check, not proof.` });
		}
	}

	if (input.clarity) out.push(...clarityInstall(input.clarity).findings);

	const rank = { critical: 0, warning: 1, info: 2 } as const;
	return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
