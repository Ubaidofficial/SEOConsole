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
import { hideCoveredDuplicates, hideableDuplicates, purgeRemovedSite } from '$lib/server/duplicates';
import { onboardingFor, setOnboardingHidden } from '$lib/server/onboarding';
import { enqueueIndexMonitor } from '$lib/server/jobs';
import { getSite } from '$lib/server/clients';
import { audit } from '$lib/server/db';
import { authorityMap } from '$lib/server/authority';
import { hasRole } from '$lib/server/roles';
import { cardTraffic, sumSource } from '$lib/server/traffic';
import { eachDay } from '$lib/server/dates';

export const load: PageServerLoad = ({ url, locals }) => {
	const showHidden = url.searchParams.get('hidden') === '1';
	// A team member limited to some sites sees only those, and the totals cover only those.
	const scope = locals?.user?.siteIds ?? null;
	// "Since a date" runs to the newest data among the sites shown.
	const latest = newestDataDay(allSites({ includeHidden: showHidden }).filter((s) => scope === null || scope.includes(s.id)));
	const days = daysParam(url, latest);
	const authBySite = authorityMap();
	const cards = siteCards(days, { includeHidden: showHidden }).filter((c) => scope === null || scope.includes(c.site.id));
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
		cards: cards.map((c) => ({
			id: c.site.id,
			name: displayName(c.site.site_url),
			authority: authBySite.get(c.site.id) ?? { dr: null, da: null },
			href: c.site.site_url.startsWith('sc-domain:') ? `https://${c.site.site_url.slice(10)}/` : c.site.site_url,
			label: c.site.label,
			tags: c.site.tags ? c.site.tags.split(',').filter(Boolean) : [],
			account: c.site.account_label ?? c.site.account_email,
			accountId: c.site.account_id,
			permission: c.site.permission,
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
			return { ok: 'Deleted the stored data for that removed property.' };
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
