import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { daysParam, intParam } from '$lib/server/params';
import { allSites, newestDataDay, portfolioTotals, siteCards } from '$lib/server/queries';
import { enqueueSiteSync } from '$lib/server/jobs';
import { db } from '$lib/server/db';
import { listAccounts, syncAccountSites } from '$lib/server/accounts';
import { displayName } from '$lib/server/clients';
import { ctrOf, pctChangeMin, positionShift } from '$lib/analytics';
import { allLinks } from '$lib/server/links';
import { deleteRemovedNow, hideCoveredDuplicates, hideableDuplicates, purgeRemovedSite, recentlyRemoved, restoreSite, RESTORE_DAYS } from '$lib/server/duplicates';
import { onboardingFor, setOnboardingHidden } from '$lib/server/onboarding';
import { enqueueIndexMonitor } from '$lib/server/jobs';
import { getSite } from '$lib/server/clients';
import { audit } from '$lib/server/db';
import { authorityMap } from '$lib/server/authority';
import { hasRole } from '$lib/server/roles';
import { cardTraffic, sumSource } from '$lib/server/traffic';
import { eachDay } from '$lib/server/dates';
import { attentionOf, daysAhead, trendOf } from '$lib/alerts';
import { addDays } from '$lib/server/dates';
import { dailySeries } from '$lib/server/queries';
import { updatesBetween } from '$lib/server/gupdates';

export const load: PageServerLoad = ({ url, locals }) => {
	const showHidden = url.searchParams.get('hidden') === '1';
	// A team member limited to some sites sees only those, and the totals cover only those.
	const scope = locals?.user?.siteIds ?? null;
	// "Since a date" runs to the newest data among the sites shown.
	const latest = newestDataDay(allSites({ includeHidden: showHidden }).filter((s) => scope === null || scope.includes(s.id)));
	const days = daysParam(url, latest);
	const authBySite = authorityMap();
	const cards = siteCards(days, { includeHidden: showHidden }).filter((c) => scope === null || scope.includes(c.site.id));
	const alertsBySite = new Map((db().prepare("SELECT site_id, COUNT(*) n FROM alert_events WHERE status = 'open' AND positive = 0 GROUP BY site_id").all() as { site_id: number; n: number }[]).map((r) => [r.site_id, r.n]));
	// The newest open problem alert of each site, for the "Needs attention" strip.
	const topAlert = new Map<number, string>();
	for (const r of db().prepare("SELECT site_id, title FROM alert_events WHERE status = 'open' AND positive = 0 ORDER BY opened_at DESC").all() as { site_id: number; title: string }[]) if (!topAlert.has(r.site_id)) topAlert.set(r.site_id, r.title);
	// Each site's previous period, day by day: the dashed line on its card and the "on X of N days" count.
	const prevDaily = new Map(cards.map((c) => [c.site.id, c.comparable && c.site.synced_through ? dailySeries(c.site.id, c.period.prevStart, c.period.prevEnd).map((r) => r.clicks) : null]));
	const totals = portfolioTotals(cards.filter((c) => !c.site.hidden && c.site.permission !== 'none'));
	const links = allLinks();
	const has = (id: number, k: string) => links.some((l) => l.site_id === id && l.kind === k);
	const link = (id: number, k: string) => links.find((l) => l.site_id === id && l.kind === k);
	// GA4 (every channel) and Bing beside Search Console, each over its own newest window, drawn on one shared calendar.
	const traffic = new Map(
		cards.map((c) => {
			const dates = eachDay(c.period.start, c.period.end);
			const daily = c.site.synced_through ? c.spark.map((clicks, i) => ({ date: dates[i], clicks })) : [];
			return [c.site.id, cardTraffic(c.site, { end: c.period.end, daily }, days, { ga4: link(c.site.id, 'ga4'), bing: link(c.site.id, 'bing') })];
		})
	);
	// Portfolio GA4 and Bing totals count the same sites as the Search Console totals (visible, not removed, not covered by a Domain property).
	const counted = cards.filter((c) => !c.site.hidden && c.site.permission !== 'none' && c.coveredBy === null);
	const ga4Total = sumSource(counted.map((c) => traffic.get(c.site.id)!.ga4));
	const bingTotal = sumSource(counted.map((c) => traffic.get(c.site.id)!.bing));
	const delta = (t: { value: number; prev: number; comparable: boolean } | null) => (t && t.comparable ? pctChangeMin(t.value, t.prev, 10) : null);
	return {
		days,
		latest,
		showHidden,
		// The get-started guide is for whoever sets the installation up: the owner and admins.
		onboarding: hasRole(locals?.user?.role, 'admin') ? onboardingFor() : null,
		totals: {
			clicks: totals.now.clicks,
			impressions: totals.now.impressions,
			position: totals.now.position,
			comparable: totals.comparable,
			loading: totals.loading,
			clicksDelta: totals.comparable ? pctChangeMin(totals.now.clicks, totals.prev.clicks, 10) : null,
			impressionsDelta: totals.comparable ? pctChangeMin(totals.now.impressions, totals.prev.impressions, 100) : null,
			ctr: ctrOf(totals.now),
			ctrDelta: totals.comparable && totals.prev.impressions >= 100 && totals.now.impressions >= 100 ? pctChangeMin(ctrOf(totals.now), ctrOf(totals.prev), 1e-9) : null,
			positionDelta: totals.comparable ? positionShift(totals.now, totals.prev) : null,
			sites: totals.sites,
			duplicates: totals.duplicates,
			ga4: ga4Total && { sessions: ga4Total.value, delta: delta(ga4Total), comparable: ga4Total.comparable, properties: ga4Total.properties },
			bing: bingTotal && { clicks: bingTotal.value, delta: delta(bingTotal), comparable: bingTotal.comparable, properties: bingTotal.properties }
		},
		duplicates: scope === null ? hideableDuplicates().map((d) => ({ id: d.id, name: displayName(d.url) })) : [],
		accounts: listAccounts()
			.filter((a) => scope === null || cards.some((c) => c.site.account_id === a.id))
			.map((a) => ({ id: a.id, label: a.label ?? a.email, status: a.status })),
		portfolio: portfolioSeries(counted.map((c) => c.site.id), latest, days, totals.comparable, url.searchParams.get('cmp') === 'year' && counted.every((c) => c.site.backfilled_to != null && c.site.backfilled_to <= addDays(c.period.start, -364)) ? 'year' : 'prev', counted.length > 0 && counted.every((c) => c.site.backfilled_to != null && c.site.backfilled_to <= addDays(c.period.start, -364))),
		removed: hasRole(locals?.user?.role, 'admin') ? recentlyRemoved(scope).map((r) => ({ ...r, name: displayName(r.siteUrl) })) : [],
		restoreDays: RESTORE_DAYS,
		tagList: [...new Set(cards.flatMap((c) => (c.site.tags ? c.site.tags.split(',').filter(Boolean) : [])))].sort(),
		cards: cards.map((c) => ({
			id: c.site.id,
			name: displayName(c.site.site_url),
			authority: authBySite.get(c.site.id) ?? { dr: null, da: null },
			href: c.site.site_url.startsWith('sc-domain:') ? `https://${c.site.site_url.slice(10)}/` : c.site.site_url,
			label: c.site.label,
			tags: c.site.tags ? c.site.tags.split(',').filter(Boolean) : [],
			pinned: !!c.site.pinned,
			alerts: alertsBySite.get(c.site.id) ?? 0,
			topAlert: topAlert.get(c.site.id) ?? null,
			trend: trendOf(c),
			// the previous period on the card chart's calendar: day i of this period beside day i of the one before
			prevSpark: (() => {
				const prev = prevDaily.get(c.site.id);
				if (!prev) return null;
				const own = new Map(eachDay(c.period.start, c.period.end).map((d, i) => [d, i]));
				return traffic.get(c.site.id)!.chart.dates.map((d) => (own.has(d) ? (prev[own.get(d)!] ?? null) : null));
			})(),
			daysUp: prevDaily.get(c.site.id) ? daysAhead(c.spark, prevDaily.get(c.site.id)!) : null,
			// Falling clicks put a site first under "Needs a look": a real drop (beyond day-to-day noise) of 20%+ is "look", 10%+ "watch".
			attention: attentionOf(c),
			account: c.site.account_label ?? c.site.account_email,
			accountId: c.site.account_id,
			permission: c.site.permission,
			// Its Google account lost access: the scheduler skips it, so the card must say so instead of a calm "synced 9 h ago".
			accountRevoked: c.site.account_status === 'revoked',
			hidden: !!c.site.hidden,
			removed: c.site.permission === 'none',
			coveredBy: c.coveredBy ? (cards.find((x) => x.site.id === c.coveredBy)?.site.site_url ?? null) : null,
			connected: { bing: has(c.site.id, 'bing'), ga4: has(c.site.id, 'ga4'), gtm: has(c.site.id, 'gtm'), clarity: has(c.site.id, 'clarity'), openseo: has(c.site.id, 'openseo') },
			syncStatus: c.site.sync_status,
			syncMessage: c.site.sync_message,
			lastSync: c.site.last_sync_at,
			backfillDone: !!c.site.backfill_done,
			hasData: !!c.site.synced_through,
			end: c.period.end,
			clicks: c.now.clicks,
			impressions: c.now.impressions,
			ctr: ctrOf(c.now),
			position: c.now.position,
			comparable: c.comparable,
			clicksDelta: c.comparable ? pctChangeMin(c.now.clicks, c.prev.clicks, 10) : null,
			impressionsDelta: c.comparable ? pctChangeMin(c.now.impressions, c.prev.impressions, 100) : null,
			ctrDelta: c.comparable && c.prev.impressions >= 100 && c.now.impressions >= 100 ? pctChangeMin(ctrOf(c.now), ctrOf(c.prev), 1e-9) : null,
			positionDelta: c.comparable ? positionShift(c.now, c.prev) : null,
			spark: c.spark,
			traffic: (() => {
				const t = traffic.get(c.site.id)!;
				return {
					ga4: t.ga4 && { sessions: t.ga4.value, delta: delta(t.ga4), comparable: t.ga4.comparable, window: t.ga4.window },
					bing: t.bing && { clicks: t.bing.value, delta: delta(t.bing), comparable: t.bing.comparable, window: t.bing.window },
					chart: t.chart
				};
			})()
		}))
	};
};

export const actions: Actions = {
	syncAll: async () => {
		// Re-read each account's property list from Google first, so properties you removed in Search Console
		// drop off the dashboard and newly added ones appear. Without this only data for known sites is refreshed.
		const noneBefore = (db().prepare("SELECT COUNT(*) n FROM sites WHERE permission = 'none'").get() as { n: number }).n;
		const accs = db().prepare("SELECT id FROM accounts WHERE status = 'active'").all() as { id: number }[];
		let listError: string | null = null;
		for (const a of accs) {
			try {
				await syncAccountSites(a.id);
			} catch (e) {
				listError = e instanceof Error ? e.message : 'Could not refresh the property list';
			}
		}
		// Newly found properties: link them to GA4, Tag Manager, Bing and OpenSEO in the background (it reads those APIs, so it is not awaited).
		void import('$lib/server/connect').then((m) => m.autoLinkNewSites()).catch(() => {});
		const removed = Math.max(0, (db().prepare("SELECT COUNT(*) n FROM sites WHERE permission = 'none'").get() as { n: number }).n - noneBefore);
		const sites = db()
			.prepare("SELECT s.id FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.hidden = 0 AND a.status = 'active' AND s.permission NOT IN ('siteUnverifiedUser','none')")
			.all() as { id: number }[];
		let n = 0;
		for (const s of sites) if (enqueueSiteSync(s.id, 'auto')) n++;
		return { queued: n, removed, listError };
	},
	hideDuplicates: async () => ({ hidden: hideCoveredDuplicates() }),
	hideOnboarding: async () => (setOnboardingHidden(true), { ok: 'Guide hidden. “Get-started guide” at the bottom of the dashboard brings it back.' }),
	showOnboarding: async () => (setOnboardingHidden(false), { ok: 'Guide shown.' }),
	/** From the guide: switch the indexing monitor on for a site (the same as the switch on its Indexing tab). */
	onboardIndexing: async ({ request }) => {
		const site = getSite(Number((await request.formData()).get('siteId')));
		if (!site || site.hidden) return fail(404, { error: 'Unknown site.' });
		db().prepare('UPDATE sites SET index_monitor = 1 WHERE id = ?').run(site.id);
		enqueueIndexMonitor(site.id);
		audit('indexmon.toggled', { siteId: site.id, detail: 'on, from the set-up guide' });
		return { ok: 'Indexing monitor on. The first check is running; changes show from the second day.' };
	},
	/** From the guide: confirm the brand term guessed from the domain. Never overwrites terms someone has set. */
	onboardBrand: async ({ request }) => {
		const f = await request.formData();
		const site = getSite(Number(f.get('siteId')));
		const terms = String(f.get('terms') ?? '').trim().slice(0, 200);
		if (!site || !terms) return fail(400, { error: 'Nothing to save.' });
		if (site.brand_terms.trim()) return fail(409, { error: 'This site already has brand terms; change them in its settings.' });
		db().prepare('UPDATE sites SET brand_terms = ? WHERE id = ?').run(terms, site.id);
		return { ok: `Brand term saved: ${terms}. Add more (product names, misspellings) in the site's settings.` };
	},
	purgeRemoved: async ({ request }) => {
		try {
			const id = intParam((await request.formData()).get('id'));
			if (!purgeRemovedSite(id)) return fail(400, { error: 'Only properties removed from Search Console can be deleted here.' });
			return { ok: `Moved to Recently removed: it can be restored for ${RESTORE_DAYS} days.` };
		} catch {
			return fail(400, { error: 'Invalid site' });
		}
	},
	/** Bring a removed site back, with its history. */
	restoreSite: async ({ request }) => {
		try {
			const id = intParam((await request.formData()).get('id'));
			return restoreSite(id) ? { ok: 'Restored, with its history.' } : fail(400, { error: 'That site is not in Recently removed.' });
		} catch {
			return fail(400, { error: 'Invalid site' });
		}
	},
	/** Delete a removed site and its history now, instead of waiting for its days of grace to pass. */
	deleteRemoved: async ({ request }) => {
		try {
			const id = intParam((await request.formData()).get('id'));
			return deleteRemovedNow(id) ? { ok: 'Deleted for good.' } : fail(400, { error: 'That site is not in Recently removed.' });
		} catch {
			return fail(400, { error: 'Invalid site' });
		}
	},
	/** Pin a site to the front of the dashboard (or unpin it). */
	pin: async ({ request }) => {
		try {
			const id = intParam((await request.formData()).get('id'));
			db().prepare('UPDATE sites SET pinned = 1 - pinned WHERE id = ?').run(id);
		} catch {
			return fail(400, { error: 'Invalid site' });
		}
	},
	toggleHidden: async ({ request }) => {
		try {
			const id = intParam((await request.formData()).get('id'));
			db().prepare('UPDATE sites SET hidden = 1 - hidden WHERE id = ?').run(id);
		} catch {
			return fail(400, { error: 'Invalid site' });
		}
	}
};

/**
 * Every counted site's clicks and impressions added up by day, on one calendar ending at the newest data day, and the same for the
 * period before (when every counted site has it stored), for the chart above the site cards.
 */
function portfolioSeries(ids: number[], latest: string | null, days: number, comparable: boolean, mode: 'prev' | 'year' = 'prev', yearOk = false) {
	if (!ids.length || !latest) return null;
	const end = latest;
	const start = addDays(end, -(days - 1));
	const sum = (from: string, to: string) => {
		const by = new Map<string, { clicks: number; impressions: number; pw: number }>();
		for (const id of ids) for (const r of dailySeries(id, from, to)) {
			const a = by.get(r.date) ?? { clicks: 0, impressions: 0, pw: 0 };
			a.clicks += r.clicks;
			a.impressions += r.impressions;
			a.pw += r.position * r.impressions;
			by.set(r.date, a);
		}
		return eachDay(from, to).map((date) => {
			const a = by.get(date) ?? { clicks: 0, impressions: 0, pw: 0 };
			return { date, clicks: a.clicks, impressions: a.impressions, position: a.impressions ? a.pw / a.impressions : 0 };
		});
	};
	const prev = mode === 'year' ? sum(addDays(start, -364), addDays(end, -364)) : comparable ? sum(addDays(start, -days), addDays(start, -1)) : null;
	return { now: sum(start, end), prev, mode, yearOk, updates: updatesBetween(start, end).map((u) => ({ date: u.begin, label: u.name })) };
}
