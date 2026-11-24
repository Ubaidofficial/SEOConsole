<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import StatusPill from '$lib/components/StatusPill.svelte';
	import { CircleCheck, CircleX, Info, TriangleAlert, MousePointerClick, Eye, Percent, Target, ListChecks, Search, FileText, CalendarClock } from '@lucide/svelte';
	import type { Icon } from '$lib/icons';
	import { CAUSE_ADVICE, CAUSE_LABEL } from '$lib/diagnose';
	import { fmtInt, fmtSigned } from '$lib/format';
	let { data } = $props();
	const d = $derived(data.d);
	const tone: Record<string, string> = { ok: 'tone-green', check: 'tone-red', wait: 'tone-amber', info: 'tone-blue' };
	const mark: Record<string, string> = { ok: 'OK', check: 'Look here', wait: 'Wait', info: 'Note' };
	const glyph: Record<string, Icon> = { ok: CircleCheck, check: CircleX, wait: TriangleAlert, info: Info };
	const maxLost = $derived(Math.max(1, ...d.concentration.pages.map((p) => p.lost)));
	const sign = (n: number) => (n > 0 ? '+' : '') + fmtInt(Math.round(n));
</script>

<PageHeader tab="/diagnose" title="Diagnose" lead="Why did clicks change? The checks to run, in order, before you touch a page.">
	<p>After a drop the usual mistake is to delete, redirect or rewrite pages straight away. This page checks, from the data already stored, whether the change is bigger than noise, whether it is fewer impressions or fewer clicks per impression, which searches lost the most and whether that looks like ranking, demand, click rate or a page that vanished, whether it is a few pages or the whole site, whether pages left the index, whether a Google update is still rolling out, and what the same weeks did last year.</p>
	<p>The split into impressions and click rate is exact (clicks = impressions × click rate). The cause labels on searches are rules of thumb with fixed thresholds (position worse by 2 or more places, impressions down 20% or more, click rate down 25% or more): they say where to look, not why Google did it. Nothing here calls Google.</p>
</PageHeader>

<section class="card mb-4 p-4">
	<div class="flex flex-wrap items-center gap-2">
		<h3 class="pii font-medium">{d.headline}</h3>
		{#if d.hold}<StatusPill tone="warn">wait before changing anything</StatusPill>{/if}
	</div>
	<p class="mt-1 text-xs text-muted-foreground">{d.period.start} to {d.period.end}, against {d.period.prevStart} to {d.period.prevEnd}.</p>
	{#if d.note}<p class="mt-2 text-sm text-warn">{d.note}</p>{/if}
	{#if d.comparable}
		<div class="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
			<div class="card px-3 py-2"><div class="flex items-center gap-1.5 text-xs text-muted-foreground"><span class="ibadge ibadge-sm tone-blue" aria-hidden="true"><MousePointerClick class="size-3.5" /></span>Clicks</div><div class="tnum text-lg font-semibold">{fmtInt(d.clicks.now)}</div><div class="text-xs text-muted-foreground">was {fmtInt(d.clicks.prev)} ({sign(d.clicks.change)})</div></div>
			<div class="card px-3 py-2"><div class="flex items-center gap-1.5 text-xs text-muted-foreground"><span class="ibadge ibadge-sm tone-blue" aria-hidden="true"><Eye class="size-3.5" /></span>From impressions</div><div class="tnum text-lg font-semibold">{sign(d.split.demand)}</div><div class="text-xs text-muted-foreground">{d.split.impressionsPct == null ? 'n/a' : `impressions ${d.split.impressionsPct > 0 ? '+' : ''}${Math.round(d.split.impressionsPct * 100)}%`}</div></div>
			<div class="card px-3 py-2"><div class="flex items-center gap-1.5 text-xs text-muted-foreground"><span class="ibadge ibadge-sm tone-blue" aria-hidden="true"><Percent class="size-3.5" /></span>From click rate</div><div class="tnum text-lg font-semibold">{sign(d.split.clickRate)}</div><div class="text-xs text-muted-foreground">{d.split.ctrPct == null ? 'n/a' : `click rate ${d.split.ctrPct > 0 ? '+' : ''}${Math.round(d.split.ctrPct * 100)}%`}</div></div>
			<div class="card px-3 py-2"><div class="flex items-center gap-1.5 text-xs text-muted-foreground"><span class="ibadge ibadge-sm tone-blue" aria-hidden="true"><Target class="size-3.5" /></span>Average position</div><div class="tnum text-lg font-semibold">{d.split.positionNow.toFixed(1)}</div><div class="text-xs text-muted-foreground">was {d.split.positionPrev.toFixed(1)}</div></div>
		</div>
	{/if}
</section>

<section class="card mb-4 p-4">
	<h3 class="mb-2 flex items-center gap-2 font-medium"><span class="ibadge ibadge-sm tone-amber" aria-hidden="true"><ListChecks class="size-3.5" /></span>The checks, in order</h3>
	<ol class="space-y-2 text-sm">
		{#each d.steps as s (s.n)}
			{@const G = glyph[s.status] ?? Info}
			<li class="flex gap-3"><span class="ibadge ibadge-sm relative mt-0.5 shrink-0 {tone[s.status] ?? 'tone-gray'}" title={mark[s.status]}><G class="size-3.5" aria-hidden="true" /><span class="sr-only">{mark[s.status]}</span></span><div><div class="font-medium">{s.question}</div><div class="pii text-muted-foreground">{s.detail}</div></div></li>
		{/each}
	</ol>
</section>

{#if d.causes.length}
	<section class="card mb-4 p-4">
		<h3 class="mb-1 flex items-center gap-2 font-medium"><span class="ibadge ibadge-sm tone-amber" aria-hidden="true"><Search class="size-3.5" /></span>Where the lost clicks went</h3>
		<p class="mb-2 text-xs text-muted-foreground">Searches that lost clicks, by what most plausibly explains each one.</p>
		<div class="space-y-4">
			{#each d.causes as c (c.cause)}
				<div>
					<div class="flex flex-wrap items-baseline gap-2"><b>{CAUSE_LABEL[c.cause]}</b><span class="chip">{fmtInt(c.rows)} searches</span><span class="chip">{fmtInt(c.clicks)} clicks lost</span></div>
					<p class="text-xs text-muted-foreground">{CAUSE_ADVICE[c.cause]}</p>
					<div class="mt-1 overflow-x-auto"><table class="w-full text-sm"><thead><tr><th class="th">Search</th><th class="th text-right">Clicks lost</th><th class="th text-right">Impressions now</th><th class="th text-right">Position</th></tr></thead><tbody>
						{#each c.examples as e}
							<tr><td class="td pii max-w-80 truncate" title={e.key}>{e.key}</td><td class="td tnum text-right">{fmtInt(e.clicks)}</td><td class="td tnum text-right">{fmtInt(e.impressions)}</td><td class="td tnum text-right">{e.position.prev || '–'} → {e.position.now || '–'}</td></tr>
						{/each}
					</tbody></table></div>
				</div>
			{/each}
		</div>
	</section>
{/if}

{#if d.concentration.pages.length}
	<section class="card mb-4 p-4">
		<h3 class="mb-1 flex items-center gap-2 font-medium"><span class="ibadge ibadge-sm tone-amber" aria-hidden="true"><FileText class="size-3.5" /></span>The pages that lost the most</h3>
		<p class="mb-2 text-xs text-muted-foreground">{d.concentration.concentrated ? 'A few pages account for most of it.' : 'The loss is spread over many pages.'}</p>
		<table class="w-full text-sm"><thead><tr><th class="th">Page</th><th class="th text-right">Clicks lost</th></tr></thead><tbody>
			{#each d.concentration.pages as p}<tr><td class="td pii max-w-96 truncate" title={p.key}>{p.key}</td><td class="td tnum cellbar text-right" style="--w:{p.lost / maxLost}">{fmtInt(p.lost)}</td></tr>{/each}
		</tbody></table>
	</section>
{/if}

{#if data.updates.length}
	<section class="card mb-4 p-4" id="updates">
		<h3 class="mb-1 flex items-center gap-2 font-medium"><span class="ibadge ibadge-sm tone-amber" aria-hidden="true"><CalendarClock class="size-3.5" /></span>Google updates and this site</h3>
		<p class="mb-2 text-xs text-muted-foreground">Clicks per day in the 28 days after each update finished against the 28 days before it began, checked against the trend before and the same dates last year.</p>
		<div class="overflow-x-auto"><table class="w-full text-sm">
			<thead><tr><th class="th">Update</th><th class="th">Dates</th><th class="th text-right" title="Clicks per day, 28 days before it began">Before</th><th class="th text-right" title="Clicks per day, 28 days after it finished">After</th><th class="th text-right">Change</th><th class="th text-right" title="What the site was already doing: the 28 days before against the 28 before those">Trend before</th><th class="th text-right" title="The same two windows a year earlier">Last year</th><th class="th">Verdict</th></tr></thead>
			<tbody>
				{#each data.updates as u (u.id)}
					<tr>
						<td class="td">{u.name}</td>
						<td class="td tnum text-xs text-muted-foreground whitespace-nowrap">{u.begin} → {u.end ?? 'ongoing'}</td>
						<td class="td tnum text-right">{u.beforePerDay == null ? '–' : u.beforePerDay.toFixed(u.beforePerDay < 10 ? 1 : 0)}</td>
						<td class="td tnum text-right">{u.afterPerDay == null ? '–' : u.afterPerDay.toFixed(u.afterPerDay < 10 ? 1 : 0)}</td>
						<td class="td tnum text-right">{fmtSigned(u.change)}</td>
						<td class="td tnum text-right text-muted-foreground">{fmtSigned(u.trendBefore)}</td>
						<td class="td tnum text-right text-muted-foreground">{fmtSigned(u.lastYear)}</td>
						<td class="td" title={u.why}><StatusPill tone={u.verdict === 'hurt' ? 'bad' : u.verdict === 'helped' ? 'good' : 'muted'}>{data.verdictText[u.verdict]}</StatusPill></td>
					</tr>
				{/each}
			</tbody>
		</table></div>
		<p class="mt-2 text-xs text-muted-foreground">A verdict is a coincidence in time, not proof: a launch, migration or seasonal peak in the same weeks moves the same numbers. Hover a verdict for the reason.</p>
	</section>
{/if}
