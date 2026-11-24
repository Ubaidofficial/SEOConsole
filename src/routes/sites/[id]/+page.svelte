<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { LoaderCircle, Plus, Trash2, TrendingDown, TrendingUp } from '@lucide/svelte';
	import Chart from '$lib/components/Chart.svelte';
	import SourceSpark, { type SparkSeries } from '$lib/components/SourceSpark.svelte';
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import { fmtInt, fmtPct, fmtPos, fmtSigned } from '$lib/format';
	import PlanList from '$lib/components/PlanList.svelte';
	import HourlyCard from '$lib/components/HourlyCard.svelte';
	import SectionTabs from '$lib/components/SectionTabs.svelte';
	import RankMix from '$lib/components/viz/RankMix.svelte';
	import SegBar from '$lib/components/viz/SegBar.svelte';
	import { POSITION_BUCKETS } from '$lib/plan';
	import MoverPanel from '$lib/components/viz/MoverPanel.svelte';
	import DayBars from '$lib/components/viz/DayBars.svelte';
	import Donut from '$lib/components/viz/Donut.svelte';
	import CountryMap from '$lib/components/viz/CountryMap.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import { isBranded } from '$lib/analytics';
	import { fmtCompact } from '$lib/format';

	import { Activity, Blocks, Bot, CalendarCheck, ChartLine, FolderTree, Globe, History, MousePointerClick, Smartphone, Sparkles, Tag, Target } from '@lucide/svelte';
	let { data, form } = $props();
	const markers = $derived([
		...data.annotations.map((a) => ({ date: a.date, label: `${a.title}`, color: a.kind === 'experiment' ? 'var(--c-impr)' : 'var(--warn)' }))
	]);
	// Google's ranking updates: a "G" on the date axis on the day each one started rolling out
	const updates = $derived(data.googleUpdates.map((u) => ({ date: u.begin, label: u.name })));
	const today = new Date().toISOString().slice(0, 10);
	let chartView = $state('');
	const hasAll = $derived(!!data.allTraffic && data.allTraffic.chart.dates.length > 1);
	/** Google clicks, GA4 sessions and Bing clicks on one calendar, when GA4 or Bing is linked. */
	const allSeries = $derived<SparkSeries[]>(
		data.allTraffic
			? [
					{ key: 'gsc', label: 'Google clicks', color: 'var(--src-gsc)', values: data.allTraffic.chart.gsc, dashed: 2 },
					...(data.allTraffic.chart.ga4 ? [{ key: 'ga4', label: 'GA4 sessions', color: 'var(--src-ga4)', values: data.allTraffic.chart.ga4, dashed: 1 }] : []),
					...(data.allTraffic.chart.bing ? [{ key: 'bing', label: 'Bing clicks', color: 'var(--src-bing)', values: data.allTraffic.chart.bing }] : [])
				]
			: []
	);

	// Controlled fields so the date survives a submit (a plain form reset would blank it).
	let date = $state(today);
	let kind = $state('change');
	let title = $state('');
	let prefix = $state('');
	let busy = $state(false);
	let logOpen = $state(false);
	const planMax = $derived(Math.max(0, ...[...data.plan.blocking, ...data.plan.quick, ...data.plan.bigger].map((a) => a.impact ?? 0)) || null);

	const addNote = () => {
		busy = true;
		return async ({ update, result }: { update: (o?: { reset?: boolean }) => Promise<void>; result: { type: string } }) => {
			await update({ reset: false });
			busy = false;
			if (result.type === 'success') {
				title = '';
				prefix = '';
			}
		};
	};
	const P = $derived(data.panels);
	const branded = (k: string) => isBranded(k, data.panels.brandTerms);
	const pathOf = (u: string) => {
		try {
			const x = new URL(u);
			return x.pathname + x.search;
		} catch {
			return u;
		}
	};
	const dot = (k: string) => (k === 'experiment' ? 'var(--c-impr)' : k === 'migration' ? 'var(--bad)' : k === 'other' || k === 'detected' ? 'var(--muted-foreground)' : 'var(--warn)');
</script>

<!-- The plan comes first: what to do in the next two weeks, from the ranked findings. The chart and the log follow. -->
<section class="mb-8" aria-labelledby="plan-h">
	<div class="mb-3 flex flex-wrap items-end gap-x-4 gap-y-1">
		<div>
			<h2 id="plan-h" class="text-lg font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-blue mr-1.5 align-[-6px]" aria-hidden="true"><CalendarCheck class="size-3.5" /></span>Your next two weeks</h2>
			<p class="text-sm text-muted-foreground">The most valuable things to do on this site now, picked from {data.plan.total} open findings. Tick one off when it is done.</p>
		</div>
		<div class="ml-auto flex gap-2 text-sm">
			<a class="btn btn-sm" href="/sites/{page.params.id}/quickwins">All quick wins</a>
			<a class="btn btn-sm" href="/sites/{page.params.id}/actions">All {data.plan.total} findings →</a>
		</div>
	</div>
	{#if data.plan.blocking.length + data.plan.quick.length + data.plan.bigger.length === 0}
		<div class="rounded-xl border border-dashed p-6 text-center text-sm"><p class="font-medium text-good">Nothing to do right now.</p><p class="mt-1 text-muted-foreground">Either the site is in good shape or there is not enough data yet. Connecting GA4, Bing and Clarity widens what is looked at.{#if data.plan.done} {data.plan.done} done item(s) come back if the problem returns.{/if}</p></div>
	{:else}
		<div class="space-y-5">
			{#if data.plan.blocking.length}
				<div><div class="mb-1.5 flex flex-wrap items-baseline gap-x-2"><h3 class="text-sm font-semibold text-bad">Fix first</h3><span class="text-xs text-muted-foreground">These stop the site earning, or stop you measuring it.</span></div><PlanList items={data.plan.blocking} tone="bad" max={planMax} /></div>
			{/if}
			{#if data.plan.quick.length}
				<div><div class="mb-1.5 flex flex-wrap items-baseline gap-x-2"><h3 class="text-sm font-semibold">Quick wins</h3><span class="text-xs text-muted-foreground">Small edits, usually minutes each.</span></div><PlanList items={data.plan.quick} start={data.plan.blocking.length + 1} max={planMax} /></div>
			{/if}
			{#if data.plan.bigger.length}
				<div><div class="mb-1.5 flex flex-wrap items-baseline gap-x-2"><h3 class="text-sm font-semibold">Bigger opportunities</h3><span class="text-xs text-muted-foreground">More work each, for more clicks.</span></div><PlanList items={data.plan.bigger} start={data.plan.blocking.length + data.plan.quick.length + 1} max={planMax} /></div>
			{/if}
		</div>
		<p class="mt-2 text-xs text-muted-foreground">Click estimates come from this site's own click curve. They are model figures, not promises, and are not added up because findings overlap.</p>
	{/if}
</section>

<SectionTabs bind:value={chartView} param="chart" label="Charts" tabs={[
	...(hasAll ? [{ id: 'all', label: 'All traffic' }] : []),
	{ id: 'gsc', label: 'Search Console' },
	...(data.hourly ? [{ id: 'hourly', label: 'Last 24 hours' }] : [])
]} />
{#if chartView === 'all' && hasAll && data.allTraffic}
<section class="mb-5 rounded-2xl border bg-card p-5 shadow-xs">
	<div class="mb-3 flex flex-wrap items-baseline justify-between gap-3">
		<h2 class="text-base font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-violet mr-1.5 align-[-6px]" aria-hidden="true"><Blocks class="size-3.5" /></span>All traffic</h2>
		<p class="text-xs text-muted-foreground" title="Each source keeps its own newest days, so a line can stop a day early. GA4 sessions already include most Google clicks: the lines overlap, they do not add up.">One scale · {data.allTraffic.chart.dates[0]} → {data.allTraffic.chart.dates.at(-1)} · dashed = days still being revised</p>
	</div>
	<SourceSpark series={allSeries} height={150} />
	<div class="tnum mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
		{#each allSeries as s}<span class="inline-flex items-center gap-1.5"><span class="h-0.5 w-3 rounded-full" style="background:{s.color}" aria-hidden="true"></span>{s.label}</span>{/each}
	</div>
</section>
{:else if chartView === 'hourly' && data.hourly}
<HourlyCard data={data.hourly} pagesHref="/sites/{page.params.id}/pages?days=1" />
{:else}
<section class="mb-5 rounded-2xl border bg-card p-5 shadow-xs">
	<div class="mb-3 flex items-baseline justify-between gap-3">
		<h2 class="text-base font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-blue mr-1.5 align-[-6px]" aria-hidden="true"><ChartLine class="size-3.5" /></span>{data.allTraffic ? 'Search Console' : 'Traffic'}</h2>
		<p class="text-xs text-muted-foreground">Dashed line = {data.compare.mode === 'year' ? 'the same weekdays last year' : 'the period before'} · G = a Google update · dots = your change log · shaded = unusual days</p>
	</div>
	<nav class="seg mb-3" aria-label="Compare with">
		<a class="seg-item !py-0.5 !text-xs {data.compare.mode === 'prev' ? 'seg-on' : ''}" aria-current={data.compare.mode === 'prev' ? 'page' : undefined} href="?days={data.days}&cmp=prev" data-sveltekit-noscroll>vs previous period</a>
		{#if data.compare.yearOk}<a class="seg-item !py-0.5 !text-xs {data.compare.mode === 'year' ? 'seg-on' : ''}" aria-current={data.compare.mode === 'year' ? 'page' : undefined} href="?days={data.days}&cmp=year" data-sveltekit-noscroll>vs last year</a>{:else}<span class="seg-item !py-0.5 !text-xs opacity-50" title="Needs a year of stored history before this period">vs last year</span>{/if}
	</nav>
	<Chart data={data.series} prev={data.prevSeries} {updates} {markers} anomalies={data.anomalies} />
	</section>
{/if}

	<div class="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
	<section class="rounded-2xl border bg-card p-5 shadow-xs lg:col-span-2" aria-labelledby="rank-h">
		<div class="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
			<h2 id="rank-h" class="text-base font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-blue mr-1.5 align-[-6px]" aria-hidden="true"><Target class="size-3.5" /></span>Where your searches rank</h2>
			<p class="text-xs text-muted-foreground">Searches with at least a few impressions this period, by average position{data.positions.prev ? '; the change is against the previous period' : ''}.</p>
		</div>
		<RankMix now={data.positions.now} prev={data.positions.prev} weeks={data.positions.weeks} hrefFor={(i) => `/sites/${page.params.id}/queries?days=${data.days}&pos=${POSITION_BUCKETS[i].key}`} />
	</section>
	<section class="rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="brand-h">
		<h2 id="brand-h" class="mb-1 text-base font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-blue mr-1.5 align-[-6px]" aria-hidden="true"><Tag class="size-3.5" /></span>Brand vs non-brand</h2>
		{#if data.brand}
			{@const b = data.brand}
			{@const total = b.now.brand + b.now.other}
			{@const d = b.prev && b.prev.other ? b.now.other / b.prev.other - 1 : null}
			<p class="mb-3 text-xs text-muted-foreground">Non-brand clicks are the ones SEO work moves.</p>
			<div class="flex items-baseline gap-2"><span class="text-2xl font-semibold">{fmtInt(b.now.other)}</span><span class="text-xs text-muted-foreground">non-brand clicks</span>{#if d != null}<span class="tnum text-xs font-medium {d >= 0 ? 'text-good' : 'text-bad'}">{fmtSigned(d)}</span>{/if}</div>
			{#if total}<div class="mt-3"><SegBar title="Clicks from brand and non-brand searches" format={(v) => `${fmtInt(v)} clicks`} parts={[{ label: 'Non-brand', value: b.now.other, color: 'var(--chart-1)' }, { label: 'Brand', value: b.now.brand, color: 'var(--chart-2)' }]} /></div>{/if}
			{#if data.panels.brandDays && data.panels.brandDays.some((x) => x.brand + x.other > 0)}
				{@const hiddenSum = data.panels.brandDays.reduce((a, x) => a + x.hidden, 0)}
				<div class="mt-4"><DayBars days={data.panels.brandDays.map((x) => x.date)} series={[{ label: 'Non-brand', color: 'var(--chart-1)', values: data.panels.brandDays.map((x) => x.other) }, { label: 'Brand', color: 'var(--chart-2)', values: data.panels.brandDays.map((x) => x.brand) }, ...(hiddenSum ? [{ label: 'Hidden by Google', color: 'color-mix(in oklab, var(--muted-foreground) 35%, transparent)', values: data.panels.brandDays.map((x) => x.hidden) }] : [])]} height={70} unit=" clicks" legend={false} /></div>
				{#if hiddenSum}<p class="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground"><span class="size-2 rounded-sm" style="background:color-mix(in oklab, var(--muted-foreground) 35%, transparent)"></span>Hidden by Google: {fmtInt(hiddenSum)} clicks from searches Google does not list, so they cannot be classed.</p>{/if}
			{/if}
			<p class="mt-2 text-[11px] text-muted-foreground">Brand = contains <span class="pii">{b.terms.join(', ')}</span>. <a class="underline" href="/sites/{page.params.id}/settings">Change</a> · <a class="underline" href="/sites/{page.params.id}/queries?b=nonbrand">See non-brand searches</a></p>
		{:else}
			<p class="text-sm text-muted-foreground">Set your brand terms in <a class="underline" href="/sites/{page.params.id}/settings">Settings</a> to split brand from non-brand clicks.</p>
		{/if}
	</section>
</div>


<div class="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
	<MoverPanel title="Top searches" unit="searches" href="/sites/{page.params.id}/queries?days={data.days}" rows={P.queries} comparable={P.queries.comparable} pii={branded} />
	<MoverPanel title="Top pages" unit="pages" href="/sites/{page.params.id}/pages?days={data.days}" rows={P.pages} comparable={P.pages.comparable} label={pathOf} pii={() => true} />
</div>

{#if P.newLost}
	{@const nl = P.newLost}
	<div class="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
		<section class="rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="new-h">
			<div class="mb-2 flex flex-wrap items-baseline gap-x-3"><h2 id="new-h" class="text-base font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-green mr-1.5 align-[-6px]" aria-hidden="true"><Sparkles class="size-3.5" /></span>New searches</h2><span class="text-xs text-muted-foreground">shown this period, not in the one before</span></div>
			<div class="mb-3 flex items-baseline gap-4"><span class="tnum text-3xl font-semibold tracking-tight {nl.added.count ? 'text-good' : ''}">{fmtInt(nl.added.count)}</span><span class="tnum text-xs text-muted-foreground"><b class="text-foreground">{nl.added.top10}</b> of them in the top 10</span></div>
			{#if nl.added.count}<DayBars days={nl.added.byDay.days} series={[{ label: 'New searches', color: 'var(--good)', values: nl.added.byDay.counts }]} height={64} />{:else}<p class="text-sm text-muted-foreground">Every search shown this period was shown in the one before too.</p>{/if}
			{#if nl.added.top.length}<ul class="mt-3 space-y-1 text-[13px]">{#each nl.added.top as r}<li class="flex gap-3"><span class="min-w-0 flex-1 truncate {branded(r.query) ? 'pii' : ''}">{r.query}</span><span class="tnum text-xs text-muted-foreground">pos {fmtPos(r.position)} · {fmtCompact(r.impressions)} impr.</span></li>{/each}</ul>{/if}
		</section>
		<section class="rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="lost-h">
			<div class="mb-2 flex flex-wrap items-baseline gap-x-3"><h2 id="lost-h" class="text-base font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-red mr-1.5 align-[-6px]" aria-hidden="true"><TrendingDown class="size-3.5" /></span>Lost searches</h2><span class="text-xs text-muted-foreground">shown in the period before, not in this one</span></div>
			<div class="mb-3 flex items-baseline gap-4"><span class="tnum text-3xl font-semibold tracking-tight {nl.lost.count ? 'text-bad' : ''}">{fmtInt(nl.lost.count)}</span><span class="tnum text-xs text-muted-foreground"><b class="text-foreground">{nl.lost.top10}</b> had been in the top 10 · {fmtInt(nl.lost.clicks)} clicks before</span></div>
			{#if nl.lost.count}<DayBars days={nl.lost.byDay.days} series={[{ label: 'Last seen', color: 'var(--bad)', values: nl.lost.byDay.counts }]} height={64} />{:else}<p class="text-sm text-muted-foreground">No search from the period before has disappeared.</p>{/if}
			{#if nl.lost.top.length}<ul class="mt-3 space-y-1 text-[13px]">{#each nl.lost.top as r}<li class="flex gap-3"><span class="min-w-0 flex-1 truncate {branded(r.query) ? 'pii' : ''}">{r.query}</span><span class="tnum text-xs text-muted-foreground">was pos {fmtPos(r.position)} · {fmtInt(r.clicks)} clicks</span></li>{/each}</ul>{/if}
		</section>
	</div>
{/if}

<div class="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
	<section class="rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="dev-h">
		<h2 id="dev-h" class="mb-3 text-base font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-blue mr-1.5 align-[-6px]" aria-hidden="true"><Smartphone class="size-3.5" /></span>Devices</h2>
		{#if P.devices.length}
			{@const total = P.devices.reduce((a, d) => a + d.clicks, 0)}
			<Donut center={fmtCompact(total)} sub="clicks" parts={P.devices.map((d, i) => ({ label: d.device.toLowerCase(), value: d.clicks, color: ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'][i % 3], note: d.prev ? fmtSigned(d.clicks / d.prev - 1, 0) : undefined }))} />
		{:else}<p class="text-sm text-muted-foreground">No data in this period yet.</p>{/if}
	</section>
	<section class="rounded-2xl border bg-card p-5 shadow-xs lg:col-span-2" aria-labelledby="bkt-h">
		<div class="mb-3 flex flex-wrap items-baseline gap-x-3"><h2 id="bkt-h" class="text-base font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-blue mr-1.5 align-[-6px]" aria-hidden="true"><FolderTree class="size-3.5" /></span><a class="hover:underline" href="/sites/{page.params.id}/groups?view=buckets&days={data.days}">Keyword buckets</a></h2>{#if P.buckets.count}<span class="text-xs text-muted-foreground">{P.buckets.count} bucket{P.buckets.count === 1 ? '' : 's'}</span>{/if}</div>
		{#if P.buckets.rows.length}
			{@const bmax = Math.max(1, ...P.buckets.rows.map((r) => r.clicks))}
			<ul class="space-y-2.5">
				{#each P.buckets.rows as r (r.id)}
					<li class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3">
						<div class="min-w-0"><a class="block truncate text-[13px] hover:underline" href="/sites/{page.params.id}/queries?days={data.days}&bucket={r.id}">{r.name} <span class="text-muted-foreground">· {fmtInt(r.members)} searches</span></a><div class="mt-1 h-1.5 rounded-full bg-muted"><div class="h-full rounded-full bg-[color:var(--c-clicks)]" style="width:{Math.max(2, (r.clicks / bmax) * 100)}%"></div></div></div>
						<div class="tnum text-right text-[13px]"><div class="font-medium">{fmtCompact(r.clicks)}</div>{#if r.deltaPct != null}<div class="text-[11px] {r.deltaPct >= 0 ? 'text-good' : 'text-bad'}">{fmtSigned(r.deltaPct, 0)}</div>{/if}</div>
						<Sparkline values={r.spark} width={84} height={24} />
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-sm text-muted-foreground">Group searches into topics (everything with “shoe”, a pasted list, a pattern) to see each topic's clicks and trend here. <a class="underline" href="/sites/{page.params.id}/groups?view=buckets">Make a bucket</a></p>
		{/if}
	</section>
</div>


<section class="mb-5 rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="geo-h">
	<div class="mb-3 flex flex-wrap items-baseline gap-x-3"><h2 id="geo-h" class="text-base font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-blue mr-1.5 align-[-6px]" aria-hidden="true"><Globe class="size-3.5" /></span>Countries</h2><span class="text-xs text-muted-foreground">Google clicks by searcher's country, this period</span></div>
	{#if P.countries.length}<CountryMap rows={P.countries} />{:else}<p class="text-sm text-muted-foreground">No data in this period yet.</p>{/if}
</section>

{#if P.ga4.linked && P.ga4.synced}
	{@const g = P.ga4}
	{@const AI_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--ord-3)', 'var(--ord-4)']}
	<div class="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
		<section class="rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="ai-h">
			<div class="mb-2 flex flex-wrap items-baseline gap-x-2"><h2 id="ai-h" class="text-base font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-violet mr-1.5 align-[-6px]" aria-hidden="true"><Bot class="size-3.5" /></span>Visits from AI assistants</h2><img src="/logos/ga4.svg" alt="" width="14" height="14" class="size-3.5" /></div>
			{#if g.ai && g.ai.total}
				<div class="mb-3 flex items-baseline gap-2"><span class="tnum text-3xl font-semibold tracking-tight">{fmtInt(g.ai.total)}</span><span class="text-xs text-muted-foreground">sessions</span>{#if g.ai.prev}<span class="tnum text-xs font-medium {g.ai.total >= g.ai.prev ? 'text-good' : 'text-bad'}">{fmtSigned(g.ai.total / g.ai.prev - 1, 0)}</span>{/if}</div>
				<DayBars days={g.ai.days} series={g.ai.assistants.map((a, i) => ({ label: a.name, color: AI_COLORS[i % AI_COLORS.length], values: a.values }))} height={64} unit=" sessions" />
				{#if g.ai.pages.length}<ul class="mt-3 space-y-1 text-[13px]">{#each g.ai.pages.slice(0, 4) as pg}<li class="flex gap-2"><span class="pii min-w-0 flex-1 truncate">{pg.page}</span><span class="tnum text-xs text-muted-foreground">{pg.sessions} · {pg.assistants.join(', ')}</span></li>{/each}</ul>{/if}
			{:else}<p class="text-sm text-muted-foreground">GA4 recorded no sessions from ChatGPT, Perplexity, Gemini, Claude or Copilot in this period.</p>{/if}
		</section>
		<section class="rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="ch-h">
			<div class="mb-3 flex flex-wrap items-baseline gap-x-2"><h2 id="ch-h" class="text-base font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-violet mr-1.5 align-[-6px]" aria-hidden="true"><Blocks class="size-3.5" /></span><a class="hover:underline" href="/sites/{page.params.id}/dashboard?days={data.days}">Traffic by channel</a></h2><span class="tnum text-xs text-muted-foreground">{fmtCompact(g.sessions)} sessions</span></div>
			{#if g.channels.length}
				<SegBar title="Sessions by channel" format={(v) => `${fmtInt(v)} sessions`} legend={false} parts={g.channels.map((c, i) => ({ label: c.key, value: c.sessions, color: ['var(--ord-1)', 'var(--ord-2)', 'var(--ord-3)', 'var(--ord-4)', 'var(--chart-2)', 'var(--chart-3)'][i % 6] }))} />
				<ul class="mt-3 space-y-1.5 text-[13px]">{#each g.channels as c, i}<li class="flex items-center gap-2"><span class="size-2 shrink-0 rounded-sm" style="background:{['var(--ord-1)', 'var(--ord-2)', 'var(--ord-3)', 'var(--ord-4)', 'var(--chart-2)', 'var(--chart-3)'][i % 6]}"></span><span class="min-w-0 flex-1 truncate">{c.key}</span><span class="tnum text-xs text-muted-foreground">{Math.round(c.share * 100)}%</span><span class="tnum w-12 text-right text-xs {c.sessionsDelta == null ? 'text-muted-foreground' : c.sessionsDelta >= 0 ? 'text-good' : 'text-bad'}">{fmtSigned(c.sessionsDelta, 0)}</span></li>{/each}</ul>
			{:else}<p class="text-sm text-muted-foreground">No sessions in this period.</p>{/if}
		</section>
		<section class="rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="ke-h">
			<h2 id="ke-h" class="mb-3 text-base font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-violet mr-1.5 align-[-6px]" aria-hidden="true"><MousePointerClick class="size-3.5" /></span><a class="hover:underline" href="/sites/{page.params.id}/analytics?days={data.days}">Key events</a></h2>
			{#if g.keyEvents && g.keyEvents.status === 'ok' && g.keyEvents.events.length}
				{@const ke = g.keyEvents}
				{@const kmax = Math.max(1, ...ke.events.map((e) => e.keyEvents))}
				<div class="mb-3 flex items-baseline gap-2"><span class="tnum text-3xl font-semibold tracking-tight">{fmtCompact(ke.total)}</span><span class="text-xs text-muted-foreground">key events</span></div>
				<ul class="space-y-2 text-[13px]">{#each ke.events.slice(0, 5) as e}<li class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2"><span class="min-w-0"><span class="block truncate font-mono text-xs">{e.event}</span><span class="mt-1 block h-1.5 rounded-full bg-muted"><span class="block h-full rounded-full bg-[color:var(--c-clicks)]" style="width:{Math.max(2, (e.keyEvents / kmax) * 100)}%"></span></span></span><span class="tnum font-medium">{fmtCompact(e.keyEvents)}</span><span class="tnum w-12 text-right text-xs {e.keyEventsDelta == null ? 'text-muted-foreground' : e.keyEventsDelta >= 0 ? 'text-good' : 'text-bad'}">{fmtSigned(e.keyEventsDelta, 0)}</span></li>{/each}</ul>
			{:else}<p class="text-sm text-muted-foreground">No key events recorded in this period. Mark a GA4 event as a key event on the <a class="underline" href="/sites/{page.params.id}/tags">Tag Manager</a> tab.</p>{/if}
		</section>
	</div>
{:else if !P.ga4.linked}
	<p class="mb-5 rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">Link GA4 to see visits from AI assistants, traffic by channel and key events here. <a class="underline" href="/sites/{page.params.id}/analytics">Connect GA4</a></p>
{/if}

<div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
	<section>
		<h2 class="mb-2 text-base font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-amber mr-1.5 align-[-6px]" aria-hidden="true"><Activity class="size-3.5" /></span>Anomalies <span class="text-sm font-normal text-muted-foreground">in this period</span></h2>
		<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
			{#each data.anomalies as a}
				<div class="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
					<span class="grid size-8 place-items-center rounded-lg {a.direction === 'drop' ? 'bg-bad/10 text-bad' : 'bg-good/10 text-good'}">
						{#if a.direction === 'drop'}<TrendingDown class="size-4" />{:else}<TrendingUp class="size-4" />{/if}
					</span>
					<div>
						<div class="text-sm font-medium tnum">{a.date}</div>
						<div class="text-xs text-muted-foreground tnum">{fmtInt(a.value)} clicks vs ~{fmtInt(a.expected)} expected</div>
					</div>
					<span class="ml-auto text-sm font-semibold tnum {a.direction === 'drop' ? 'text-bad' : 'text-good'}">{fmtSigned(a.deltaPct, 0)}</span>
				</div>
			{:else}
				<div class="px-4 py-6 text-center text-sm text-muted-foreground">No unusual days. Traffic is within its normal weekly pattern.</div>
			{/each}
		</div>
		{#if data.anonShare !== null}
			<p class="mt-3 text-xs text-muted-foreground">{fmtPct(data.anonShare, 0)} of clicks come from anonymised queries Google does not list, so query tables will not sum to the totals above.</p>
		{/if}
	</section>

	<section>
		<div class="mb-2 flex items-center gap-2"><h2 class="text-base font-semibold tracking-tight"><span class="ibadge ibadge-sm tone-gray mr-1.5 align-[-6px]" aria-hidden="true"><History class="size-3.5" /></span>Change log</h2>
				<form method="POST" action="?/changelogAuto" use:enhance class="ml-auto"><input type="hidden" name="on" value={data.changelogAuto ? '0' : '1'} /><button class="btn btn-xs {data.changelogAuto ? '' : 'btn-ghost'}" aria-pressed={data.changelogAuto} title="robots.txt changes, new Tag Manager versions, and pages appearing in or leaving the sitemaps are logged here by the app ('detected'). Delete any you do not want: a deleted one does not come back.">Detected changes: {data.changelogAuto ? 'on' : 'off'}</button></form>
				<details class="group" bind:open={logOpen}><summary class="btn btn-sm cursor-pointer list-none [&::-webkit-details-marker]:hidden"><Plus class="size-3.5" />Log a change</summary></details></div>
				{#if logOpen}
				<form method="POST" action="?/addNote" use:enhance={addNote} class="mb-3 grid gap-3 rounded-xl border bg-card p-4 shadow-xs">
			<div class="grid grid-cols-2 gap-3">
				<label class="grid gap-1.5 text-xs font-medium text-muted-foreground">Date<input class="input w-full text-foreground" type="date" name="date" bind:value={date} required /></label>
				<label class="grid gap-1.5 text-xs font-medium text-muted-foreground">Type
					<select class="input w-full text-foreground" name="kind" bind:value={kind}>
						<option value="change">Change</option>
						<option value="experiment">Experiment</option>
						<option value="migration">Migration</option>
						<option value="other">Other</option>
					</select>
				</label>
			</div>
			<label class="grid gap-1.5 text-xs font-medium text-muted-foreground">What changed?<input class="input w-full text-foreground" name="title" bind:value={title} placeholder="e.g. Rewrote titles on /guides/*" required /></label>
			<label class="grid gap-1.5 text-xs font-medium text-muted-foreground">Measure only this URL prefix <span class="font-normal">(optional)</span><input class="input w-full text-foreground" name="prefix" bind:value={prefix} placeholder="https://example.com/guides/" /></label>
			<div class="flex items-center gap-3">
				<button class="btn btn-primary" disabled={busy || !title.trim()}>{#if busy}<LoaderCircle class="size-4 animate-spin" />Saving…{:else}<Plus class="size-4" />Add to log{/if}</button>
						{#if form?.error}<p class="text-sm text-bad">{form.error}</p>{/if}
					</div>
				</form>
				{/if}

		<div class="space-y-2.5">
			{#each data.annotations as a (a.id)}
				{@const lt = data.annotationTests[a.id]}
				<article class="rounded-xl border bg-card p-4 text-sm shadow-xs">
					<div class="flex items-center gap-2">
						<span class="size-2 rounded-full" style="background:{dot(a.kind)}"></span>
						<span class="text-xs font-medium capitalize" title={a.kind === 'detected' ? 'Logged by the app from a change it noticed (robots.txt, Tag Manager or sitemaps)' : undefined}>{a.kind}</span>
						<span class="text-xs text-muted-foreground tnum">· {a.date}</span>
						<form method="POST" action="?/deleteNote" use:enhance class="ml-auto">
							<input type="hidden" name="id" value={a.id} />
							<ConfirmButton class="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive" title="Delete this note?" description="It disappears from the chart and the change log. Traffic data is not affected." confirmLabel="Delete note"><Trash2 class="size-3.5" /><span class="sr-only">Delete note</span></ConfirmButton>
						</form>
					</div>
					<div class="mt-1 font-medium">{a.title}</div>
					{#if a.page_prefix}<div class="pii truncate text-xs text-muted-foreground">scope: {a.page_prefix}</div>{/if}
					{#if lt}
						<div class="mt-2 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs">
							<span class="font-medium">Tested:</span>
							<span class="{lt.verdict === 'positive' ? 'text-good' : lt.verdict === 'negative' ? 'text-bad' : 'text-muted-foreground'}">{lt.verdict === 'positive' ? 'likely a real gain' : lt.verdict === 'negative' ? 'likely a real loss' : lt.verdict === 'inconclusive' ? 'no clear effect' : lt.verdict === 'estimate-only' ? 'estimate only' : 'not enough data yet'}{lt.lift != null ? ` (${fmtSigned(lt.lift)} vs control)` : ''}</span>
							{#if lt.verdict === 'inconclusive' && lt.detectable != null && lt.detectable > 0.25}<span class="text-warn">weak evidence: could not detect a change under ±{Math.round(lt.detectable * 100)}%</span>{/if}
							<a class="ml-auto underline" href="/sites/{page.params.id}/tests">details</a>
						</div>
					{:else if a.page_prefix}
						<form method="POST" action="?/makeTest" use:enhance class="mt-2"><input type="hidden" name="id" value={a.id} /><button class="btn btn-xs">Test this change properly</button></form>
					{/if}
					{#if a.result.tooEarly}
						<div class="mt-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">Too early to judge: {a.result.afterDays} day(s) of data since the change (7+ needed).</div>
					{:else}
						<div class="mt-2 grid grid-cols-3 gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs tnum">
							<div><div class="text-muted-foreground">Clicks/day</div><div class="font-medium">{fmtInt(a.result.clicksBefore)} → {fmtInt(a.result.clicksAfter)}</div></div>
							<div><div class="text-muted-foreground">vs site trend</div><div class="font-semibold {(a.result.lift ?? 0) >= 0 ? 'text-good' : 'text-bad'}">{fmtSigned(a.result.lift)}</div><div class="text-muted-foreground">{fmtSigned(a.result.rawChange)} raw</div></div>
							<div><div class="text-muted-foreground">Position</div><div class="font-medium">{fmtPos(a.result.posBefore)} → {fmtPos(a.result.posAfter)}</div></div>
						</div>
						<div class="mt-1.5 text-[11px] text-muted-foreground">{a.result.afterDays}d after vs 28d before. A rough readout with no significance test{lt ? '; see the verdict above' : a.page_prefix ? '; use “Test this change properly” for a verdict' : ''}.</div>
					{/if}
				</article>
			{:else}
				<p class="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">Log title rewrites, redirects or launches here. After 7+ days you get a before/after readout adjusted for the site's overall trend.</p>
			{/each}
		</div>
	</section>
</div>
