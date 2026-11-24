<script lang="ts">
	import { privacy } from '$lib/privacy.svelte';
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { ChevronDown, House, RefreshCw, Settings, Sparkles } from '@lucide/svelte';
	import SiteSwitcher from '$lib/components/SiteSwitcher.svelte';
	import PeriodPicker from '$lib/components/PeriodPicker.svelte';
	import { SITE_PRIMARY_TABS, SITE_SOURCE_TABS, SITE_TABS, SITE_TAB_GROUPS, SOURCE_LINK } from '$lib/explain';
	const tabOf = (t: string) => SITE_TABS.find(([p]) => p === t)!;
	import Delta from '$lib/components/Delta.svelte';
	import SiteAvatar from '$lib/components/SiteAvatar.svelte';
	import AuthorityBadges from '$lib/components/AuthorityBadges.svelte';
	import AuthorityCredit from '$lib/components/AuthorityCredit.svelte';
	import { fmtInt, fmtPct, fmtPos, fmtStat, ago } from '$lib/format';
	import { TAB_ICON, TAB_TONE } from '$lib/icons';
	import InfoTip from '$lib/components/InfoTip.svelte';

	let { data, children } = $props();
	const syncing = $derived(data.site.syncStatus === 'running' || data.site.syncStatus === 'queued');
	const fresh = $derived(!!data.site.lastSync && Date.now() - data.site.lastSync < 7 * 3600_000);
	let wasSyncing = false;
	$effect(() => {
		if (syncing) {
			wasSyncing = true;
			const t = setInterval(() => invalidateAll(), 2500);
			return () => clearInterval(t);
		}
		if (wasSyncing) {
			wasSyncing = false;
			if (data.site.syncStatus === 'error') toast.error('Sync failed', { description: privacy.on ? undefined : (data.site.syncMessage ?? undefined) });
			else toast.success('Sync finished');
		}
	});
	const base = $derived(`/sites/${data.site.id}`);
	const isActive = (t: string) => (t === '' ? page.url.pathname === base : page.url.pathname.startsWith(base + t));
	/** A tab from under More that is open right now is shown in the row too, so you can always see where you are. */
	const sourceTabs = SITE_SOURCE_TABS as readonly string[];
	const inRow = [...(SITE_PRIMARY_TABS as readonly string[]), ...sourceTabs];
	const activeExtra = $derived(SITE_TABS.map(([t]) => t as string).find((t) => t !== '' && isActive(t) && !inRow.includes(t)) ?? null);
	/** A source tab whose source is not connected for this site: a hollow dot, and the tab opens on its Connect prompt. */
	const unlinked = (t: string) => !!SOURCE_LINK[t] && !data.linked[SOURCE_LINK[t]];
	/**
	 * Sync is a plain endpoint (POST, then a redirect back), not a form action, so `use:enhance` cannot read its answer (it expects a form
	 * action's JSON and got the HTML page: "Unexpected token '<'"). Post it directly and reload the data; the layout then shows the sync
	 * running and polls until it ends. Without JavaScript the form still posts normally and the redirect brings you back.
	 */
	async function startSync(e: SubmitEvent) {
		e.preventDefault();
		const res = await fetch(`${base}/sync`, { method: 'POST', body: new FormData(e.currentTarget as HTMLFormElement), redirect: 'manual' }).catch(() => null);
		// The endpoint answers 303; with redirect: 'manual' that arrives as an opaque redirect, which is success here.
		if (!res || (res.type !== 'opaqueredirect' && !res.ok)) {
			toast.error('Sync could not start', { description: res ? (res.status === 403 ? 'Your role cannot start a sync.' : `The server answered ${res.status}.`) : 'The server could not be reached.' });
			return;
		}
		await invalidateAll();
	}
	let moreOpen = $state(false);
	$effect(() => {
		void page.url.pathname;
		moreOpen = false; // close the menu after choosing a tab
		// on a phone the tab row scrolls sideways: bring the open tab into view
		queueMicrotask(() => document.querySelector('nav[aria-label="Site sections"] [aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
	});
	type Kpi = { l: string; v: string; exact?: string; d: number | null; inv: boolean; pos?: boolean; color?: string; sub?: string; title?: string; why?: string; prev?: string | null };
	const pk = $derived(data.kpis.prev);
	const kpis = $derived<Kpi[]>([
		{ l: data.kpis.ga4 || data.kpis.bing ? 'Google clicks' : 'Clicks', v: fmtStat(data.kpis.clicks), exact: fmtInt(data.kpis.clicks), d: data.kpis.clicksDelta, inv: false, color: 'var(--src-gsc)', prev: pk ? fmtStat(pk.clicks) : null },
		...(data.kpis.ga4
			? [{ l: 'Sessions · GA4', v: fmtStat(data.kpis.ga4.sessions), exact: fmtInt(data.kpis.ga4.sessions), d: data.kpis.ga4.delta, inv: false, color: 'var(--src-ga4)', prev: data.kpis.ga4.prev != null ? fmtStat(data.kpis.ga4.prev) : null, sub: data.kpis.ga4.users != null ? `${fmtInt(data.kpis.ga4.users)} users · ${fmtInt(data.kpis.ga4.newUsers ?? 0)} new` : undefined, title: `Every GA4 session, any channel, ${data.kpis.ga4.window.start} to ${data.kpis.ga4.window.end}. Users are GA4's unique active users over the period (shown for the preset periods). Organic Search sessions already include most Google clicks, so do not add the two.`, why: data.kpis.ga4.comparable ? 'Fewer than 10 sessions in the previous period' : 'Stored GA4 history does not reach the previous period' }]
			: []),
		...(data.kpis.bing ? [{ l: 'Bing clicks', v: fmtStat(data.kpis.bing.clicks), exact: fmtInt(data.kpis.bing.clicks), d: data.kpis.bing.delta, inv: false, color: 'var(--src-bing)', prev: data.kpis.bing.prev != null ? fmtStat(data.kpis.bing.prev) : null, title: `Bing clicks, ${data.kpis.bing.window.start} to ${data.kpis.bing.window.end}`, why: data.kpis.bing.comparable ? 'Fewer than 10 clicks in the previous period' : 'Stored Bing history does not reach the previous period' }] : []),
		{ l: 'Impressions', v: fmtStat(data.kpis.impressions), exact: fmtInt(data.kpis.impressions), d: data.kpis.impressionsDelta, inv: false, color: 'var(--c-impr)', prev: pk ? fmtStat(pk.impressions) : null },
		{ l: 'CTR', v: fmtPct(data.kpis.ctr), d: data.kpis.ctrDelta, inv: false, color: 'var(--c-pos)', prev: pk?.ctr != null ? fmtPct(pk.ctr) : null },
		{ l: 'Avg position', v: fmtPos(data.kpis.position), d: data.kpis.positionDelta, inv: true, pos: true, color: 'var(--muted-foreground)', prev: pk?.position ? fmtPos(pk.position) : null }
	]);
	/** The product each source tab reads from, shown by its own logo. */
	const SRC_LOGO: Record<string, string> = { '/bing': 'bing.svg', '/analytics': 'ga4.svg', '/tags': 'tag-manager.svg', '/clarity': 'clarity.png', '/vitals': 'chrome.svg' };
	/** The tab you are on, kept when the switcher opens another site. */
	const tabPath = $derived(page.url.pathname.slice(base.length));
	const sourceOn = $derived(sourceTabs.some((t) => isActive(t)));
	let srcOpen = $state(false);
	let srcBox = $state<HTMLDetailsElement>();
	$effect(() => {
		void page.url.pathname;
		srcOpen = false;
	});
	const linkedCount = $derived(sourceTabs.filter((t) => SOURCE_LINK[t] && !unlinked(t)).length);
</script>
<svelte:window onclick={(e) => srcOpen && srcBox && !srcBox.contains(e.target as Node) && (srcOpen = false)} onkeydown={(e) => srcOpen && e.key === 'Escape' && (srcOpen = false)} />

<!-- One line says where you are (as onsite.so's): home, the site (its name opens a switcher) and the tabs. -->
<div class="mb-3 flex flex-wrap items-end gap-x-5 border-b" style="border-color:var(--border)">
	<div class="flex min-w-0 max-w-full items-center gap-1.5 pb-2">
		<a href="/" class="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="All sites" title="All sites"><House class="size-4" /></a>
		<span class="text-muted-foreground" aria-hidden="true">/</span>
		<SiteSwitcher sites={data.switcher} current={data.site.id} name={data.site.label || data.site.name} hrefFor={(id) => `/sites/${id}${tabPath}?days=${data.days}`} />
		<AuthorityBadges authority={data.site.authority} />
	</div>
	<!-- the tabs scroll sideways on a phone; Sources and Settings stay put outside the scrolling part -->
	<nav class="relative -mb-px flex min-w-0 flex-1 basis-[28rem] items-end" aria-label="Site sections">
		<div class="flex min-w-0 flex-1 items-end overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
			{#each SITE_PRIMARY_TABS as t}{@render tab(t)}{#if t === '/insights' && activeExtra && !sourceTabs.includes(activeExtra) && activeExtra !== '/settings'}<span class="mb-2.5 text-muted-foreground" aria-hidden="true">›</span>{@render tab(activeExtra)}{/if}{/each}
		</div>
		<details class="shrink-0" bind:open={srcOpen} bind:this={srcBox}>
			<summary class="-mb-px flex cursor-pointer list-none items-center gap-1.5 border-b-2 bg-background px-3 py-2 text-[13px] select-none hover:text-foreground [&::-webkit-details-marker]:hidden {sourceOn ? 'border-[color:var(--link)] font-medium text-foreground' : 'border-transparent text-muted-foreground'}">
				<span class="flex -space-x-1" aria-hidden="true">{#each ['/analytics', '/bing', '/clarity'] as t}<img src="/logos/{SRC_LOGO[t]}" alt="" width="14" height="14" class="size-3.5 rounded-full bg-card object-contain ring-2 ring-background" />{/each}</span>
				{sourceOn ? (tabOf(sourceTabs.find((t) => isActive(t))!)[1]) : 'Sources'}<span class="text-[11px] text-muted-foreground tnum">{linkedCount}/{sourceTabs.length - 1}</span><ChevronDown class="size-3.5 transition-transform {srcOpen ? 'rotate-180' : ''}" />
			</summary>
			<div class="absolute top-full right-0 z-30 mt-2 w-[min(24rem,calc(100vw-2rem))] rounded-xl border bg-card p-1.5 shadow-lg" role="menu">
				{#each sourceTabs as t}
					{@const [, label, about] = tabOf(t)}
					<a href="{base}{t}?days={data.days}" role="menuitem" class="flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent {isActive(t) ? 'bg-accent' : ''}">
						<span class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border bg-card">{#if SRC_LOGO[t]}<img src="/logos/{SRC_LOGO[t]}" alt="" width="14" height="14" class="size-3.5 object-contain" />{:else if TAB_ICON[t]}{@const I = TAB_ICON[t]}<I class="size-3.5 text-muted-foreground" />{/if}</span>
						<span class="min-w-0 flex-1"><span class="flex items-center gap-1.5 text-[13px] font-medium">{label}{@render tabBadges(t)}</span><span class="line-clamp-2 block text-xs leading-snug text-muted-foreground">{about}</span></span>
					</a>
				{/each}
			</div>
		</details>
		<a href="{base}/settings?days={data.days}" aria-current={isActive('/settings') ? 'page' : undefined} class="-mb-px grid shrink-0 place-items-center border-b-2 px-2.5 py-2 {isActive('/settings') ? 'border-[color:var(--link)] text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}" aria-label="Settings" title="Settings"><Settings class="size-4" /></a>
	</nav>
</div>

<!-- The toolbar (as onsite.so's): the period on the left; whether the numbers are current, and the site's own actions, on the right. -->
<div class="card mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
	<span class="inline-flex items-center gap-1"><PeriodPicker days={data.days} latest={data.latest} /><InfoTip label="Data delay" text="Search Console reports whole days and runs about two days behind, so the newest day here is {data.latest ?? 'the newest it has'}. GA4 and Bing can be a day fresher." /></span>
	<span class="tnum text-xs text-muted-foreground">{data.period.start} → {data.period.end}{#if !data.site.backfillDone && data.site.syncedThrough} · backfilling history (back to {data.site.backfilledTo}){/if}</span>
	<span class="pii hidden truncate text-xs text-muted-foreground lg:inline" title="Property and account">{data.site.url} · {data.account.label ?? data.account.email}</span>
	<div class="ml-auto flex flex-wrap items-center gap-2">
		<!-- one glance at whether the numbers are current: synced in the last 7 hours, behind, syncing, or failed -->
		<span class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs {data.site.syncStatus === 'error' ? 'text-bad' : syncing ? 'text-muted-foreground' : fresh ? 'text-good' : 'text-warn'}" title={data.site.syncStatus === 'error' ? (privacy.on ? 'Sync failed' : `Sync failed: ${data.site.syncMessage}`) : data.site.lastSync ? `Last synced ${ago(data.site.lastSync)}. Data refreshes every 6 hours.` : 'Not synced yet.'} role="status">
			<span class="size-2 rounded-full {syncing ? 'animate-pulse' : ''}" style="background:currentColor" aria-hidden="true"></span>{data.site.syncStatus === 'error' ? 'Sync failed' : syncing ? 'Syncing' : fresh ? 'Up to date' : 'Behind'}<span class="hidden text-muted-foreground sm:inline">· {syncing ? data.site.syncStatus : data.site.lastSync ? ago(data.site.lastSync) : 'never'}</span>
		</span>
		{#if data.openseo?.url}<a class="btn btn-sm" href={data.openseo.url} target="_blank" rel="noreferrer noopener" title={privacy.on ? undefined : `OpenSEO project: ${data.openseo.name}`}>OpenSEO ↗</a>{/if}
		<a class="btn btn-sm" href="/chat?draft={encodeURIComponent(`About ${data.site.name}: `)}" title="Open the chat with this site named in the question"><Sparkles class="size-3.5" />Ask about this site</a>
		<form method="POST" action="{base}/sync" onsubmit={startSync}><button class="btn btn-sm" disabled={syncing}><RefreshCw class="size-3.5 {syncing ? 'animate-spin' : ''}" />{syncing ? 'Syncing…' : 'Sync'}</button></form>
	</div>
	{#if data.site.authority.dr || data.site.authority.da}<div class="w-full text-[11px] text-muted-foreground"><AuthorityCredit dr={!!data.site.authority.dr} da={!!data.site.authority.da} /></div>{/if}
</div>

<!-- The totals live on Overview only, as one bar split into cells (as onsite.so's), each with the previous period's own number. -->
{#if isActive('')}
<div class="card mb-4 overflow-hidden">
	<div class="stagger grid grid-cols-2 gap-px bg-[color:var(--border)] max-md:[&>*:last-child:nth-child(odd)]:col-span-2 {kpis.length === 6 ? 'md:grid-cols-3 xl:grid-cols-6' : kpis.length === 5 ? 'md:grid-cols-5' : 'md:grid-cols-4'}">
		{#each kpis as k}
			<div class="bg-card px-4 py-3" title={k.title}>
				<div class="flex items-center gap-1.5 text-xs text-muted-foreground">{#if k.color}<span class="size-2 shrink-0 rounded-[2px]" style="background:{k.color}" aria-hidden="true"></span>{/if}{k.l}</div>
				<div class="tnum mt-0.5 text-[26px] leading-tight font-semibold tracking-tight" title={k.exact}>{k.v}</div>
				<div class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
					<Delta pill value={k.d} invert={k.inv} mode={k.pos ? 'pos' : 'pct'} why={k.why ?? (data.kpis.comparable ? 'Too little data for a reliable comparison' : 'Previous period still downloading')} />{#if k.d != null && k.pos}<span class="text-muted-foreground">places</span>{/if}
					{#if k.prev}<span class="tnum text-muted-foreground">vs {k.prev}</span>{/if}
				</div>
				{#if k.sub}<div class="tnum mt-0.5 text-[11px] text-muted-foreground">{k.sub}</div>{/if}
			</div>
		{/each}
	</div>
</div>
{/if}

{#snippet tabLogo(t: string)}{#if SRC_LOGO[t]}<img src="/logos/{SRC_LOGO[t]}" alt="" width="14" height="14" class="mr-1.5 inline-block size-3.5 align-[-2px] object-contain" />{:else if TAB_ICON[t]}{@const I = TAB_ICON[t]}<I class="mr-1.5 inline-block size-3.5 align-[-2px] opacity-75" aria-hidden="true" />{/if}{/snippet}
{#snippet tabBadges(t: string)}{#if t === '/actions' && data.actionBadge.open}<span class="ml-1.5 inline-grid min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold {data.actionBadge.blocking ? 'bg-[color:var(--bad)] text-white' : 'bg-muted text-muted-foreground'}" title="{data.actionBadge.open} open{data.actionBadge.blocking ? ', ' + data.actionBadge.blocking + ' blocking' : ''}">{data.actionBadge.open}</span>{/if}{#if SOURCE_LINK[t]}{#if unlinked(t)}<span class="ml-1 text-muted-foreground" title="Not connected: open the tab to connect it">○</span>{:else}<span class="ml-1 text-good" title="connected">●</span>{/if}{/if}{/snippet}
{#snippet tab(t: string)}
	{@const [, label, about] = tabOf(t)}
	<a href="{base}{t}?days={data.days}" title={about} aria-current={isActive(t) ? 'page' : undefined} class="-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] transition-colors duration-150 {isActive(t) ? 'border-[color:var(--link)] font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}">{@render tabLogo(t)}{label}{@render tabBadges(t)}</a>
{/snippet}

{#key page.url.pathname + '|' + (page.url.searchParams.get('view') ?? '')}<div class="page-in">{@render children()}</div>{/key}
