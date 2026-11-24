import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getSite, displayName } from '$lib/server/clients';
import { daysParam } from '$lib/server/params';
import { allSites, historyCoversPrevious, periodFor, siteEnd, summary } from '$lib/server/queries';
import { db } from '$lib/server/db';
import { ctrOf, pctChangeMin, positionShift } from '$lib/analytics';
import { config } from '$lib/server/config';
import { linksFor } from '$lib/server/links';
import { enabledEngines } from '$lib/server/aiengines';
import { openSeoProjectUrl } from '$lib/server/connect';
import { queueFor } from '$lib/server/actions';
import { authorityOf } from '$lib/server/authority';
import { cardTraffic, ga4UsersFor } from '$lib/server/traffic';

export const load: LayoutServerLoad = ({ params, url, locals }) => {
	const site = getSite(Number(params.id));
	if (!site) error(404, 'Unknown site');
	const acc = db().prepare('SELECT email, label, status FROM accounts WHERE id = ?').get(site.account_id) as { email: string; label: string | null; status: string };
	const latest = siteEnd(site);
	const days = daysParam(url, latest);
	const period = periodFor(site, days);
	const now = summary(site.id, period.start, period.end);
	const prev = summary(site.id, period.prevStart, period.prevEnd);
	const comparable = historyCoversPrevious(site, period.prevStart);
	const solid = comparable && prev.impressions >= 100 && now.impressions >= 100;
	const links = linksFor(site.id);
	// GA4 (every channel) and Bing beside the Search Console totals, each over its own newest window, as on the dashboard cards.
	const traffic = cardTraffic(site, { end: period.end, daily: [] }, days, { ga4: links.ga4, bing: links.bing });
	const delta = (t: { value: number; prev: number; comparable: boolean } | null) => (t && t.comparable ? pctChangeMin(t.value, t.prev, 10) : null);
	const users = links.ga4 ? ga4UsersFor(site.id, days) : null;
	// The count on the Actions tab; it is cached, so this is a lookup after the first computation following a sync.
	let actionBadge = { open: 0, blocking: 0 };
	try {
		const open = queueFor(site).open;
		actionBadge = { open: open.length, blocking: open.filter((a) => a.blocking).length };
	} catch {
		/* the tab still works; only the badge is missing */
	}
	// The site switcher: every site this person may open, by name (hidden and removed sites are left out, as on the dashboard).
	const scope = locals?.user?.siteIds ?? null;
	const switcher = allSites()
		.filter((s) => !scope || scope.includes(s.id))
		.map((s) => ({ id: s.id, name: s.label || displayName(s.site_url), account: s.account_label ?? s.account_email }))
		.sort((a, b) => a.name.localeCompare(b.name));
	return {
		actionBadge,
		switcher,
		linked: { bing: !!links.bing, ga4: !!links.ga4, gtm: !!links.gtm, clarity: !!links.clarity, ai: enabledEngines().length > 0 },
		openseo: links.openseo ? { name: links.openseo.label, url: openSeoProjectUrl(links.openseo.integration_id, links.openseo.external_id) } : null,
		site: {
			id: site.id,
			url: site.site_url,
			name: displayName(site.site_url),
			authority: authorityOf(site.id),
			label: site.label,
			tags: site.tags,
			brandTerms: site.brand_terms,
			hidden: !!site.hidden,
			permission: site.permission,
			syncStatus: site.sync_status,
			syncMessage: site.sync_message,
			lastSync: site.last_sync_at,
			syncedThrough: site.synced_through,
			backfilledTo: site.backfilled_to,
			backfillDone: !!site.backfill_done
		},
		account: acc,
		days,
		latest,
		period,
		readOnly: config.readOnly,
		kpis: {
			clicks: now.clicks,
			impressions: now.impressions,
			ctr: ctrOf(now),
			position: now.position,
			comparable,
			// the previous period's own numbers, shown as "vs 12.3K" beside each change (only when that period is fully stored)
			prev: comparable ? { clicks: prev.clicks, impressions: prev.impressions, ctr: solid ? ctrOf(prev) : null, position: prev.position } : null,
			clicksDelta: comparable ? pctChangeMin(now.clicks, prev.clicks, 10) : null,
			impressionsDelta: comparable ? pctChangeMin(now.impressions, prev.impressions, 100) : null,
			ctrDelta: solid ? pctChangeMin(ctrOf(now), ctrOf(prev), 1e-9) : null,
			positionDelta: comparable ? positionShift(now, prev) : null,
			ga4: traffic.ga4 && { sessions: traffic.ga4.value, prev: traffic.ga4.comparable ? traffic.ga4.prev : null, delta: delta(traffic.ga4), comparable: traffic.ga4.comparable, window: traffic.ga4.window, users: users?.activeUsers ?? null, newUsers: users?.newUsers ?? null },
			bing: traffic.bing && { clicks: traffic.bing.value, prev: traffic.bing.comparable ? traffic.bing.prev : null, delta: delta(traffic.bing), comparable: traffic.bing.comparable, window: traffic.bing.window }
		}
	};
};
