<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Bell, Eye, EyeOff, ExternalLink, GitCompare, Layers, Pin, RefreshCw, Search, Trash2, Sparkles, TriangleAlert } from '@lucide/svelte';
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import PeriodPicker from '$lib/components/PeriodPicker.svelte';
	import SourceSpark, { type SparkSeries } from '$lib/components/SourceSpark.svelte';
	import SiteAvatar from '$lib/components/SiteAvatar.svelte';
	import AuthorityBadges from '$lib/components/AuthorityBadges.svelte';
	import AuthorityCredit from '$lib/components/AuthorityCredit.svelte';
	import { BANDS_TEXT } from '$lib/authority';
	import Delta from '$lib/components/Delta.svelte';
	import GetStarted from '$lib/components/GetStarted.svelte';
	import Chart from '$lib/components/Chart.svelte';
	import SectionTabs from '$lib/components/SectionTabs.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import { privacy } from '$lib/privacy.svelte';
	import { fmtCompact, fmtInt, fmtPct, fmtPos, fmtStat, ago } from '$lib/format';

	let { data, form } = $props();
	let q = $state('');
	let account = $state('all');
	let sort = $state<'clicks' | 'impressions' | 'clicksDelta' | 'attention' | 'name'>('clicks');
	let group = $state('');
	const ATT = { look: 2, watch: 1 } as const;
	const attentionRank = (c: (typeof data.cards)[number]) => (c.attention ? ATT[c.attention] : 0) * 1000 + Math.min(999, c.alerts);

	// empty until the switches read the address (?trend=…&view=…), so a link opens the same filter and layout
	let trend = $state('');
	let layout = $state('');
	const TREND_LABEL = { growing: 'Growing', steady: 'Steady', declining: 'Declining' } as const;
	/** The cards the search, account and group filters leave, before the Growing / Steady / Declining switch, so its counts stay put. */
	const pool = $derived(data.cards.filter((c) => (account === 'all' || String(c.accountId) === account) && (!group || c.tags.includes(group)) && (!q || `${c.name} ${c.label ?? ''} ${c.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()))));
	const trendTabs = $derived([
		{ id: 'all', label: 'All', count: pool.length },
		...(['growing', 'steady', 'declining'] as const).map((t) => ({ id: t, label: TREND_LABEL[t], count: pool.filter((c) => c.trend === t).length }))
	]);
	/** Sites with a real fall in clicks or an open problem alert, worst first, for the strip above the cards. */
	const attention = $derived(data.cards.filter((c) => !c.hidden && !c.removed && (c.attention === 'look' || c.alerts > 0)).sort((a, b) => attentionRank(b) - attentionRank(a)));
	const cards = $derived(
		pool
			.filter((c) => !trend || trend === 'all' || c.trend === trend)
			.sort((a, b) =>
				Number(b.pinned) - Number(a.pinned) ||
				(sort === 'name' ? a.name.localeCompare(b.name)
				: sort === 'attention' ? attentionRank(b) - attentionRank(a) || (a.clicksDelta ?? 0) - (b.clicksDelta ?? 0)
				: (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity))
			)
	);
	/** The totals of the group (tag) picked, for its own line above the cards. Overlapping URL-prefix properties are counted once. */
	const groupTotals = $derived.by(() => {
		if (!group) return null;
		const xs = cards.filter((c) => !c.hidden && !c.removed && !c.coveredBy);
		const clicks = xs.reduce((a, c) => a + c.clicks, 0);
		const impressions = xs.reduce((a, c) => a + c.impressions, 0);
		return { sites: xs.length, clicks, impressions, look: xs.filter((c) => c.attention === 'look').length };
	});
	type Kpi = { label: string; v: string; exact?: string; d: number | null; inv: boolean; pos?: boolean; color?: string; title?: string; pending?: boolean };
	const kpis = $derived<Kpi[]>([
		{ label: data.totals.ga4 || data.totals.bing ? 'Google clicks' : 'Clicks', v: fmtStat(data.totals.clicks), exact: fmtInt(data.totals.clicks), d: data.totals.clicksDelta, inv: false, color: 'var(--src-gsc)', title: 'Clicks from Google Search, from Search Console' },
		...(data.totals.ga4
			? [{ label: 'Sessions · GA4', v: fmtStat(data.totals.ga4.sessions), exact: fmtInt(data.totals.ga4.sessions), d: data.totals.ga4.delta, inv: false, color: 'var(--src-ga4)', pending: !data.totals.ga4.comparable, title: `Every GA4 session, from every channel (search, direct, social, referral, AI assistants…), over ${data.totals.ga4.properties} GA4 propert${data.totals.ga4.properties === 1 ? 'y' : 'ies'}. Organic Search sessions already include most Google clicks, so do not add the two together.` }]
			: []),
		...(data.totals.bing
			? [{ label: 'Bing clicks', v: fmtStat(data.totals.bing.clicks), exact: fmtInt(data.totals.bing.clicks), d: data.totals.bing.delta, inv: false, color: 'var(--src-bing)', pending: !data.totals.bing.comparable, title: `Clicks from Bing (and the engines that use its results), from Bing Webmaster Tools, over ${data.totals.bing.properties} site${data.totals.bing.properties === 1 ? '' : 's'}` }]
			: []),
		{ label: 'Impressions', v: fmtStat(data.totals.impressions), exact: fmtInt(data.totals.impressions), d: data.totals.impressionsDelta, inv: false },
		{ label: 'CTR', v: fmtPct(data.totals.ctr), d: data.totals.ctrDelta, inv: false },
		{ label: 'Avg position', v: fmtPos(data.totals.position), d: data.totals.positionDelta, inv: true, pos: true }
	]);

	/** The lines for one card: Search Console always, GA4 and Bing when linked and synced. */
	const seriesOf = (c: (typeof data.cards)[number]): SparkSeries[] => [
		{ key: 'gsc', label: 'Google clicks', color: 'var(--src-gsc)', values: c.traffic.chart.gsc, dashed: 2 },
		...(c.traffic.chart.ga4 ? [{ key: 'ga4', label: 'GA4 sessions', color: 'var(--src-ga4)', values: c.traffic.chart.ga4, dashed: 1 }] : []),
		...(c.traffic.chart.bing ? [{ key: 'bing', label: 'Bing clicks', color: 'var(--src-bing)', values: c.traffic.chart.bing }] : []),
		// last, so it is drawn underneath: Google clicks in the period before, day for day
		...(c.prevSpark ? [{ key: 'prev', label: 'Google clicks, previous period', color: 'var(--src-gsc)', values: c.prevSpark, ghost: true }] : [])
	];
	const TREND_TONE = { growing: 'text-good', steady: 'text-muted-foreground', declining: 'text-bad' } as const;
	const why = $derived(data.totals.comparable ? 'Previous period had too little data for a reliable comparison' : `Comparison shown once the history finishes loading (${data.totals.loading} site${data.totals.loading === 1 ? '' : 's'} still downloading)`);

	// A real sync takes minutes (one Google request per day of history), so follow it live instead of
	// showing a stale "synced 3 h ago" until the page is reloaded.
	const syncing = $derived(data.cards.filter((c) => !c.hidden && (c.syncStatus === 'running' || c.syncStatus === 'queued')).length);
	let wasSyncing = false;
	$effect(() => {
		if (syncing > 0) {
			wasSyncing = true;
			const t = setInterval(() => invalidateAll(), 2500);
			return () => clearInterval(t);
		}
		if (wasSyncing) {
			wasSyncing = false;
			const failed = data.cards.filter((c) => !c.hidden && c.syncStatus === 'error');
			if (failed.length) toast.error(`Sync finished: ${failed.length} site${failed.length === 1 ? '' : 's'} failed`, { description: privacy.on ? undefined : `${failed[0].syncMessage ?? 'Unknown error'}. Hover “⚠ sync error” on a card for details.` });
			else toast.success('Sync finished');
		}
	});

	const title = (c: (typeof data.cards)[number]) => (c.label || c.name).replace(' (URL prefix)', '');
	const isPrefix = (c: (typeof data.cards)[number]) => (c.label || c.name).endsWith('(URL prefix)');

	/** Reverse a hide/show without a page-level form: post the same action again, then refresh. */
	async function toggleAgain(id: number) {
		const fd = new FormData();
		fd.set('id', String(id));
		await fetch('?/toggleHidden', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		await invalidateAll();
	}

	const hideEnhance = (c: (typeof data.cards)[number]) => () => async ({ update }: { update: () => Promise<void> }) => {
		const wasHidden = c.hidden;
		const label = privacy.on ? 'Site' : title(c);
		await update();
		toast(wasHidden ? `${label} is back on the dashboard` : `${label} hidden`, {
			description: wasHidden ? 'It will sync again.' : 'It leaves the totals and stops syncing. “Show hidden sites” at the bottom brings it back.',
			action: { label: 'Undo', onClick: () => toggleAgain(c.id) }
		});
	};
</script>

<div class="mb-6 flex flex-wrap items-end gap-x-4 gap-y-3">
	<div class="flex items-center gap-3">
		<h1 class="text-2xl font-semibold tracking-tight">All sites</h1>
		<span class="rounded-full bg-muted px-2.5 py-0.5 text-sm font-medium text-muted-foreground tnum">{data.totals.sites}</span>
		{#if data.totals.duplicates}<span class="text-xs text-muted-foreground">{data.totals.duplicates} overlapping</span>{/if}
	</div>
	<PeriodPicker days={data.days} latest={data.latest} />
	<div class="ml-auto flex flex-wrap items-center gap-2">
		<div class="relative">
			<Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
			<input class="input w-52 pl-8" placeholder="Search sites or tags" aria-label="Search sites or tags" bind:value={q} />
		</div>
		<select class="input" bind:value={account} aria-label="Account">
			<option value="all">All accounts</option>
			{#each data.accounts as a}<option value={String(a.id)}>{a.label}</option>{/each}
		</select>
		{#if data.tagList.length}
			<select class="input" bind:value={group} aria-label="Group of sites (tag)" title="Sites are grouped by the tags set on each site's Settings tab">
				<option value="">All groups</option>
				{#each data.tagList as t}<option value={t}>Group: {t}</option>{/each}
			</select>
		{/if}
		<select class="input" bind:value={sort} aria-label="Sort">
			<option value="attention">Sort: needs a look</option>
			<option value="clicks">Sort: clicks</option>
			<option value="impressions">Sort: impressions</option>
			<option value="clicksDelta">Sort: Δ clicks</option>
			<option value="name">Sort: name</option>
		</select>
		{#if data.cards.length > 1 && !data.user?.scoped}<a class="btn" href="/portfolio/compare?days={data.days}" title="Two to four sites on one chart, for a migration or a side-by-side"><GitCompare class="size-3.5" />Compare</a>{/if}
		<form method="POST" action="?/syncAll" use:enhance><button class="btn" disabled={syncing > 0}><RefreshCw class="size-3.5 {syncing > 0 ? 'animate-spin' : ''}" />{syncing > 0 ? `Syncing ${syncing}…` : 'Sync all'}</button></form>
	</div>
</div>

<form method="GET" action="/chat" class="group mb-6 flex items-center gap-2 rounded-2xl border bg-card py-1.5 pr-1.5 pl-4 shadow-xs transition-shadow focus-within:shadow-sm focus-within:ring-2 focus-within:ring-ring/30">
	<Sparkles class="size-4 shrink-0 text-muted-foreground" />
	<label for="ask-data" class="sr-only">Ask your data</label>
	<input id="ask-data" name="q" maxlength="2000" autocomplete="off" class="h-9 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground" placeholder="Ask your data: “Why did clicks drop last week?” or “What should I fix first?”" />
	<button class="btn btn-primary h-8 rounded-xl">Ask</button>
</form>

{#if data.onboarding && !data.onboarding.hidden}<GetStarted steps={data.onboarding.steps} progress={data.onboarding.progress} running={data.onboarding.running} />{/if}

{#if data.cards.length === 0}
	{#if !data.onboarding || data.onboarding.hidden}
	<div class="card p-10 text-center">
		<p class="mb-2 text-lg font-semibold">No sites yet</p>
		<p class="mb-5 text-muted-foreground">Connect a Google account to import every Search Console property it can see.</p>
		<a class="btn btn-primary" href="/accounts">Connect an account</a>
	</div>
	{/if}
{:else}
	<div class="stagger mb-5 grid grid-cols-2 gap-4 {kpis.length === 6 ? 'md:grid-cols-3 xl:grid-cols-6' : kpis.length === 5 ? 'md:grid-cols-3 xl:grid-cols-5' : 'md:grid-cols-4'}">
		{#each kpis as k}
			<div class="rounded-2xl border bg-card p-4 shadow-xs" title={k.title}>
				<div class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">{#if k.color}<span class="size-2 shrink-0 rounded-full" style="background:{k.color}" aria-hidden="true"></span>{/if}{k.label}</div>
				<div class="tnum mt-1.5 text-3xl font-semibold tracking-tight" title={k.exact}>{k.v}</div>
				<div class="mt-1 h-4">
					{#if k.d == null}
						<span class="text-xs text-muted-foreground" title={k.pending ? 'Stored history does not reach the previous period yet for every linked property' : why}>{k.pending ?? !data.totals.comparable ? 'comparison pending' : 'no reliable comparison'}</span>
					{:else}
						<Delta value={k.d} invert={k.inv} mode={k.pos ? 'pos' : 'pct'} {why} /> <span class="text-xs text-muted-foreground">{k.pos ? 'places ' : ''}vs previous {data.days}d</span>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	{#if data.portfolio && data.portfolio.now.length > 1}
		<section class="mb-5 rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="all-h">
			<div class="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<h2 id="all-h" class="text-base font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-blue mr-1.5 align-[-6px]" aria-hidden="true"><Layers class="size-3.5" /></span>All {data.totals.sites - data.totals.duplicates} sites</h2>
				<span class="tnum text-2xl font-semibold tracking-tight">{fmtCompact(data.totals.clicks)}</span><span class="text-xs text-muted-foreground">clicks</span>
				{#if data.totals.clicksDelta != null}<Delta value={data.totals.clicksDelta} {why} /><span class="text-xs text-muted-foreground">vs previous {data.days} days</span>{/if}
			</div>
			<nav class="seg mb-2" aria-label="Compare with">
				<a class="seg-item !py-0.5 !text-xs {data.portfolio.mode === 'prev' ? 'seg-on' : ''}" aria-current={data.portfolio.mode === 'prev' ? 'page' : undefined} href="?days={data.days}&cmp=prev" data-sveltekit-noscroll>vs previous period</a>
				{#if data.portfolio.yearOk}<a class="seg-item !py-0.5 !text-xs {data.portfolio.mode === 'year' ? 'seg-on' : ''}" aria-current={data.portfolio.mode === 'year' ? 'page' : undefined} href="?days={data.days}&cmp=year" data-sveltekit-noscroll>vs last year</a>{:else}<span class="seg-item !py-0.5 !text-xs opacity-50" title="Needs a year of stored history for every site">vs last year</span>{/if}
			</nav>
			<Chart data={data.portfolio.now} prev={data.portfolio.prev} updates={data.portfolio.updates} defaultMetrics={['clicks']} height={200} dashed={2} />
		</section>
	{/if}

	{#if attention.length}
		<section class="mb-5" aria-labelledby="att-h">
			<div class="mb-2 flex items-baseline gap-2"><h2 id="att-h" class="text-base font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-red mr-1.5 align-[-6px]" aria-hidden="true"><TriangleAlert class="size-3.5" /></span>Needs attention</h2><span class="text-xs text-muted-foreground">{attention.length} site{attention.length === 1 ? '' : 's'} with a real fall in clicks or an open alert</span><a class="ml-auto text-xs underline underline-offset-2" href="/alerts">All alerts</a></div>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
				{#each attention.slice(0, 4) as c (c.id)}
					<a href={c.alerts ? `/sites/${c.id}/alerts` : `/sites/${c.id}?days=${data.days}`} class="group flex flex-col rounded-xl border bg-card p-3.5 shadow-xs transition-colors hover:border-foreground/30">
						<span class="flex items-center gap-2"><SiteAvatar name={title(c)} siteId={c.id} class="pii !size-6 !rounded-md !text-[11px]" /><span class="pii min-w-0 flex-1 truncate text-sm font-medium">{title(c)}</span><span class="chip shrink-0 !px-1.5 !py-0 text-[10px] {c.attention === 'look' || c.alerts ? 'text-bad' : 'text-warn'}">{c.attention === 'look' ? 'Needs a look' : c.attention === 'watch' ? 'Watch' : 'Alert'}</span></span>
						<span class="pii mt-2 text-sm font-semibold leading-snug">{c.topAlert ?? (c.clicksDelta != null ? `Clicks fell ${Math.round(Math.abs(c.clicksDelta) * 100)}%` : 'Clicks are falling')}</span>
						<span class="mt-0.5 text-xs text-muted-foreground">{c.alerts ? `${c.alerts} open alert${c.alerts === 1 ? '' : 's'}` : `vs previous ${data.days} days`}</span>
						<span class="mt-2 text-xs font-medium text-foreground/80 group-hover:underline">Open →</span>
					</a>
				{/each}
			</div>
		</section>
	{/if}

	{#if data.duplicates.length}
		<div class="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border bg-card p-4 text-sm shadow-xs">
			<span><b>{data.duplicates.length}</b> URL-prefix {data.duplicates.length === 1 ? 'property is' : 'properties are'} already covered by a Domain property (<span class="pii">{data.duplicates.map((d) => d.name.replace(' (URL prefix)', '')).join(', ')}</span>). Totals count each site once, but both are still syncing.</span>
			<form method="POST" action="?/hideDuplicates" use:enhance class="ml-auto"><button class="btn">Hide duplicates</button></form>
		</div>
	{/if}
	{#if !data.totals.comparable}
		<p class="mb-4 text-xs text-muted-foreground">Comparisons with the previous period appear once each site has finished downloading its history ({data.totals.loading} still loading). Totals for the selected period are already correct for the days downloaded so far.</p>
	{/if}

	{#if groupTotals}
		<p class="tnum mb-3 text-sm text-muted-foreground">Group <b class="text-foreground">{group}</b>: {groupTotals.sites} site{groupTotals.sites === 1 ? '' : 's'}, <b class="text-foreground">{fmtInt(groupTotals.clicks)}</b> clicks, {fmtInt(groupTotals.impressions)} impressions{#if groupTotals.look} · {groupTotals.look} need a look{/if}</p>
	{/if}
	<div class="mb-3 flex flex-wrap items-center gap-x-3">
		<SectionTabs bind:value={trend} param="trend" label="Sites by direction" tabs={trendTabs} />
		<div class="ml-auto"><SectionTabs bind:value={layout} param="view" label="Layout" tabs={[{ id: 'cards', label: 'Cards' }, { id: 'table', label: 'Table' }]} /></div>
	</div>
	{#if layout === 'table'}
		<div class="overflow-x-auto rounded-2xl border bg-card shadow-xs">
			<table class="w-full text-sm">
				<thead class="text-left text-xs text-muted-foreground"><tr class="border-b">
					<th class="px-4 py-2.5 font-medium">Site</th><th class="px-3 py-2.5 font-medium">Direction</th><th class="px-3 py-2.5 text-right font-medium">Clicks</th><th class="px-3 py-2.5 text-right font-medium">Δ</th><th class="px-3 py-2.5 font-medium">Daily clicks</th><th class="px-3 py-2.5 text-right font-medium">Impr.</th><th class="px-3 py-2.5 text-right font-medium">CTR</th><th class="px-3 py-2.5 text-right font-medium">Position</th><th class="px-3 py-2.5 text-right font-medium">Alerts</th>
				</tr></thead>
				<tbody>
					{#each cards as c (c.id)}
						<tr class="border-b last:border-0 hover:bg-muted/40 {c.hidden ? 'opacity-55' : ''}">
							<td class="max-w-64 px-4 py-2.5"><a class="pii flex items-center gap-2 font-medium hover:underline" href="/sites/{c.id}?days={data.days}">{#if c.pinned}<Pin class="size-3 shrink-0 fill-current text-muted-foreground" />{/if}<span class="truncate">{title(c)}</span></a></td>
							<td class="px-3 py-2.5 text-xs {c.trend ? TREND_TONE[c.trend] : 'text-muted-foreground'}">{c.trend ? TREND_LABEL[c.trend] : '–'}</td>
							<td class="tnum px-3 py-2.5 text-right font-medium">{fmtInt(c.clicks)}</td>
							<td class="px-3 py-2.5 text-right"><Delta value={c.clicksDelta} why={c.comparable ? 'Too little data in the previous period' : 'Previous period still loading'} /></td>
							<td class="px-3 py-1"><Sparkline values={c.spark} width={110} height={26} /></td>
							<td class="tnum px-3 py-2.5 text-right">{fmtCompact(c.impressions)}</td>
							<td class="tnum px-3 py-2.5 text-right">{fmtPct(c.ctr)}</td>
							<td class="tnum px-3 py-2.5 text-right">{fmtPos(c.position)}</td>
							<td class="tnum px-3 py-2.5 text-right">{#if c.alerts}<a class="text-bad hover:underline" href="/sites/{c.id}/alerts">{c.alerts}</a>{:else}<span class="text-muted-foreground">–</span>{/if}</td>
						</tr>
					{:else}
						<tr><td colspan="9" class="px-4 py-6 text-center text-muted-foreground">No site matches these filters.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
	<div class="stagger grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-3">
		{#each cards as c (c.id)}
			<article class="group relative rounded-2xl border bg-card p-5 shadow-xs transition-all hover:-translate-y-px hover:shadow-md {c.hidden ? 'opacity-55' : ''}">
				<div class="flex items-start gap-3">
					<SiteAvatar name={title(c)} siteId={c.id} class="pii" />
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2">
							<a href="/sites/{c.id}?days={data.days}" class="pii truncate text-lg leading-tight font-semibold tracking-tight after:absolute after:inset-0 after:rounded-2xl">{title(c)}</a>
							<AuthorityBadges authority={c.authority} class="ml-1" />
							{#if c.removed}<span class="chip shrink-0 !px-1.5 !py-0 text-[10px]" title="Google no longer lists this property for the account">removed in Search Console</span>{/if}
							{#if isPrefix(c)}<span class="chip shrink-0 !px-1.5 !py-0 text-[10px]">URL prefix</span>{/if}
							{#if c.trend && !c.attention}<span class="chip shrink-0 !px-1.5 !py-0 text-[10px] {TREND_TONE[c.trend]}" title="Clicks against the previous {data.days} days: a real change of 5% or more either way, beyond day-to-day noise">{TREND_LABEL[c.trend]}</span>{/if}
							{#if c.attention}<span class="chip shrink-0 !px-1.5 !py-0 text-[10px] {c.attention === 'look' ? 'text-bad' : 'text-warn'}" title="Clicks fell {c.attention === 'look' ? '20%' : '10%'} or more against the previous period, beyond day-to-day noise">{c.attention === 'look' ? 'Needs a look' : 'Watch'}</span>{/if}
							{#if c.alerts}<a href="/sites/{c.id}/alerts" class="chip relative z-10 inline-flex shrink-0 items-center gap-0.5 !px-1.5 !py-0 text-[10px] text-bad" title="{c.alerts} open alert{c.alerts === 1 ? '' : 's'}"><Bell class="size-2.5" />{c.alerts}</a>{/if}
							<a href={c.href} target="_blank" rel="noreferrer noopener" class="tap relative z-10 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100" aria-label="Open the site in a new tab" title="Open site"><ExternalLink class="size-3.5" /></a>
						</div>
						<div class="pii truncate text-sm text-muted-foreground">{c.label ? c.name + ' · ' : ''}{c.account}</div>
						{#if c.coveredBy}<div class="pii truncate text-xs text-warn" title={privacy.on ? undefined : `This property's data is already included in ${c.coveredBy}`}>↳ included in {c.coveredBy.replace('sc-domain:', '')}</div>{/if}
					</div>
					<div class="flex shrink-0 items-start gap-2">
						{#if c.hasData}
							<div class="flex flex-col items-end gap-1">
								<span class="tnum rounded-full bg-muted px-3 py-1 text-sm font-medium">{fmtInt(c.clicks)} clicks</span>
								<Delta value={c.clicksDelta} why={c.comparable ? 'Too little data in the previous period' : 'Previous period still loading'} />
							</div>
						{/if}
						{#if !c.removed}
							<form method="POST" action="?/pin" use:enhance class="relative z-10">
								<input type="hidden" name="id" value={c.id} />
								<button class="grid size-8 place-items-center rounded-full border bg-background shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground {c.pinned ? 'text-foreground' : 'text-muted-foreground'}" aria-label={c.pinned ? 'Unpin' : 'Pin to the front'} aria-pressed={c.pinned} title={c.pinned ? 'Pinned: shown first whatever the sort. Click to unpin.' : 'Pin to the front of the dashboard'}>
									<Pin class="size-4 {c.pinned ? 'fill-current' : ''}" />
								</button>
							</form>
						{/if}
						{#if c.removed}
							<form method="POST" action="?/purgeRemoved" use:enhance class="relative z-10">
								<input type="hidden" name="id" value={c.id} />
								<ConfirmButton
									title="Remove this property from SEOConsole?"
									description="Search Console no longer lists it. It moves to Recently removed at the bottom of the dashboard, where you can restore it with its history for {data.restoreDays} days; after that its stored history is deleted. Your Search Console data is not touched."
									confirmLabel="Remove"
									class="grid size-8 place-items-center rounded-full border bg-background text-muted-foreground shadow-xs transition-colors hover:bg-destructive/10 hover:text-destructive"
								><Trash2 class="size-4" /></ConfirmButton>
							</form>
						{:else}
						<form method="POST" action="?/toggleHidden" use:enhance={hideEnhance(c)} class="relative z-10">
								<input type="hidden" name="id" value={c.id} />
								<button class="grid size-8 place-items-center rounded-full border bg-background text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground" aria-label={c.hidden ? 'Show on dashboard' : 'Hide from dashboard'} title={c.hidden ? 'Show on dashboard again' : 'Hide from dashboard (leaves the totals and stops syncing)'}>
									{#if c.hidden}<Eye class="size-4" />{:else}<EyeOff class="size-4" />{/if}
								</button>
							</form>
						{/if}
					</div>
				</div>

				{#if !c.hasData}
					<div class="mt-6 mb-2 text-sm text-muted-foreground">
						{#if c.permission === 'siteUnverifiedUser'}Unverified property — no data available
						{:else if c.syncStatus === 'error'}<span class="text-bad">Sync failed: {c.syncMessage}</span>
						{:else}Waiting for first sync…{/if}
					</div>
				{:else}
					{#if c.spark.length > 1}
						<SourceSpark series={seriesOf(c)} class="mt-5" />
						{#if c.daysUp}<p class="tnum mt-1.5 text-xs text-muted-foreground">More clicks than the period before on <b class="font-medium text-foreground">{c.daysUp.up}</b> of {c.daysUp.of} days <span class="opacity-70">· dashed line</span></p>{/if}
						{#if c.traffic.ga4 || c.traffic.bing}
							<!-- Legend: names, totals and changes in text ink beside a colour swatch, so a line is never told apart by colour alone. -->
							<div class="tnum mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
								<span class="inline-flex items-center gap-1.5"><span class="h-0.5 w-3 rounded-full" style="background:var(--src-gsc)" aria-hidden="true"></span>Google <b class="font-medium text-foreground">{fmtInt(c.clicks)}</b> clicks</span>
								{#if c.traffic.ga4}<span class="inline-flex items-center gap-1.5" title="Every GA4 session, any channel, {c.traffic.ga4.window.start} to {c.traffic.ga4.window.end}"><span class="h-0.5 w-3 rounded-full" style="background:var(--src-ga4)" aria-hidden="true"></span>GA4 <b class="font-medium text-foreground">{fmtInt(c.traffic.ga4.sessions)}</b> sessions<Delta value={c.traffic.ga4.delta} why={c.traffic.ga4.comparable ? 'Fewer than 10 sessions in the previous period' : 'Stored GA4 history does not reach the previous period'} /></span>{/if}
								{#if c.traffic.bing}<span class="inline-flex items-center gap-1.5" title="Bing clicks, {c.traffic.bing.window.start} to {c.traffic.bing.window.end}"><span class="h-0.5 w-3 rounded-full" style="background:var(--src-bing)" aria-hidden="true"></span>Bing <b class="font-medium text-foreground">{fmtInt(c.traffic.bing.clicks)}</b> clicks<Delta value={c.traffic.bing.delta} why={c.traffic.bing.comparable ? 'Fewer than 10 clicks in the previous period' : 'Stored Bing history does not reach the previous period'} /></span>{/if}
							</div>
						{/if}
					{:else}
						<p class="mt-5 text-xs text-muted-foreground">One day of data, so there is no trend line to draw.</p>
					{/if}
					<div class="tnum mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm whitespace-nowrap text-muted-foreground lg:flex-nowrap lg:justify-between 2xl:justify-start 2xl:gap-x-5">
						<span class="inline-flex items-center gap-1.5">Impr. <b class="font-medium text-foreground">{fmtInt(c.impressions)}</b><Delta value={c.impressionsDelta} why={c.comparable ? 'Too little data in the previous period' : 'Previous period still loading'} /></span>
						<span class="inline-flex items-center gap-1.5">CTR <b class="font-medium text-foreground">{fmtPct(c.ctr)}</b><Delta value={c.ctrDelta} why="Needs 100+ impressions in both periods" /></span>
						<span class="inline-flex items-center gap-1.5">Pos. <b class="font-medium text-foreground">{fmtPos(c.position)}</b><Delta value={c.positionDelta} mode="pos" why="Needs 20+ impressions in both periods" /></span>
					</div>
				{/if}

				<div class="mt-4 flex items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
					<!-- Each connected source shows its own logo (the files in static/logos); OpenSEO has no logo file, so it stays a text chip. -->
					{#each [['bing', 'Bing', 'bing.svg'], ['ga4', 'Google Analytics 4', 'ga4.svg'], ['gtm', 'Google Tag Manager', 'tag-manager.svg'], ['clarity', 'Microsoft Clarity', 'clarity.png']] as [k, l, file]}
						{#if c.connected[k as 'bing']}<img src="/logos/{file}" alt="{l} connected" title="{l} connected" width="16" height="16" class="size-4 shrink-0 object-contain" />{/if}
					{/each}
					{#if c.connected.openseo}<span class="chip !py-0 text-[10px]" title="OpenSEO connected">OpenSEO</span>{/if}
					{#each c.tags as t}<span class="chip !py-0 text-[10px]">{t}</span>{/each}
					<span class="ml-auto truncate">
						{#if c.removed}removed · no longer synced{:else if c.accountRevoked}<a href="/accounts" class="relative z-10 font-medium text-bad underline underline-offset-2" title="Google withdrew this account's access, so this site has stopped updating. Reconnect the account on the Accounts page.">⚠ Google access lost · reconnect</a>{:else if c.syncStatus === 'running' || c.syncStatus === 'queued'}<RefreshCw class="mr-1 inline size-3 animate-spin" />{c.syncStatus}{:else if c.syncStatus === 'error'}<span class="text-bad" title={privacy.on ? undefined : (c.syncMessage ?? 'Sync failed')}>⚠ sync error</span>{:else}synced {ago(c.lastSync)}{/if} {#if !c.backfillDone && c.hasData}· loading history{/if}
					</span>
				</div>
			</article>
		{:else}
			<p class="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground lg:col-span-2 2xl:col-span-3">No site matches these filters.</p>
		{/each}
	</div>
	{/if}
	<p class="mt-6 text-xs text-muted-foreground">
		<span title="Each source keeps its own newest days (Search Console lags about 2 days, Pacific time), so a line can stop a day early. GA4 sessions already include most Google clicks: the lines overlap, they do not add up.">Lines on one scale: <span class="font-medium" style="color:var(--src-gsc)">green</span> Google clicks, <span class="font-medium" style="color:var(--src-ga4)">orange</span> GA4 sessions (every channel), <span class="font-medium" style="color:var(--src-bing)">blue</span> Bing clicks. GA4 already includes most Google clicks, so they overlap, not add up. Dashed = days still being revised.</span>
		<a class="underline underline-offset-2" href="?days={data.days}&hidden={data.showHidden ? 0 : 1}">{data.showHidden ? 'Hide' : 'Show'} hidden sites</a>
	</p>
	{#if data.cards.some((c) => c.authority.dr || c.authority.da)}<p class="mt-1 text-xs text-muted-foreground"><AuthorityCredit dr={data.cards.some((c) => c.authority.dr)} da={data.cards.some((c) => c.authority.da)} /> Circles show DR and DA out of 100: {BANDS_TEXT} (this app's own bands, not Ahrefs' or Moz's).</p>{/if}
{/if}
{#if data.removed.length}
	<details class="mt-4 text-sm">
		<summary class="cursor-pointer text-xs text-muted-foreground select-none">Recently removed ({data.removed.length})</summary>
		<ul class="mt-2 divide-y rounded-xl border bg-card" style="border-color:var(--border)">
			{#each data.removed as r (r.id)}
				<li class="flex flex-wrap items-center gap-3 px-4 py-2.5">
					<span class="pii min-w-0 flex-1 truncate">{r.label || r.name}</span>
					<span class="text-xs text-muted-foreground">removed {ago(r.deletedAt)} · deleted for good {new Date(r.until).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
					<form method="POST" action="?/restoreSite" use:enhance><input type="hidden" name="id" value={r.id} /><button class="btn btn-sm">Restore</button></form>
					<form method="POST" action="?/deleteRemoved" use:enhance><input type="hidden" name="id" value={r.id} /><ConfirmButton class="btn btn-sm text-muted-foreground" title="Delete it for good now?" description="Its stored history is deleted now instead of on the date shown. Your Search Console data is not touched. This cannot be undone." confirmLabel="Delete now">Delete now</ConfirmButton></form>
				</li>
			{/each}
		</ul>
	</details>
{/if}
{#if data.onboarding?.hidden}
	<form method="POST" action="?/showOnboarding" use:enhance class="mt-2 text-xs text-muted-foreground"><button class="underline underline-offset-2">Set-up guide{data.onboarding.progress.complete ? '' : ` (${data.onboarding.progress.done} of ${data.onboarding.progress.total} done)`}</button></form>
{/if}
