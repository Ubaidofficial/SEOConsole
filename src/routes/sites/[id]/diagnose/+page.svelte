<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import { CAUSE_ADVICE, CAUSE_LABEL } from '$lib/diagnose';
	import { fmtInt } from '$lib/format';
	let { data } = $props();
	const d = $derived(data.d);
	const tone: Record<string, string> = { ok: 'text-good', check: 'text-bad', wait: 'text-warn', info: 'text-muted-foreground' };
	const mark: Record<string, string> = { ok: 'OK', check: 'Look here', wait: 'Wait', info: 'Note' };
	const sign = (n: number) => (n > 0 ? '+' : '') + fmtInt(Math.round(n));
</script>

<Explainer lead="Why did clicks change? The checks to run, in order, before you touch a page.">
	<p>After a drop the usual mistake is to delete, redirect or rewrite pages straight away. This page checks, from the data already stored, whether the change is bigger than noise, whether it is fewer impressions or fewer clicks per impression, which searches lost the most and whether that looks like ranking, demand, click rate or a page that vanished, whether it is a few pages or the whole site, whether pages left the index, whether a Google update is still rolling out, and what the same weeks did last year.</p>
	<p>The split into impressions and click rate is exact (clicks = impressions × click rate). The cause labels on searches are rules of thumb with fixed thresholds (position worse by 2 or more places, impressions down 20% or more, click rate down 25% or more): they say where to look, not why Google did it. Nothing here calls Google.</p>
</Explainer>

<section class="card mb-4 p-4">
	<div class="flex flex-wrap items-center gap-2">
		<h2 class="pii font-medium">{d.headline}</h2>
		{#if d.hold}<span class="chip text-warn">wait before changing anything</span>{/if}
	</div>
	<p class="mt-1 text-xs text-muted-foreground">{d.period.start} to {d.period.end}, against {d.period.prevStart} to {d.period.prevEnd}.</p>
	{#if d.note}<p class="mt-2 text-sm text-warn">{d.note}</p>{/if}
	{#if d.comparable}
		<div class="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
			<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Clicks</div><div class="tnum text-lg font-semibold">{fmtInt(d.clicks.now)}</div><div class="text-xs text-muted-foreground">was {fmtInt(d.clicks.prev)} ({sign(d.clicks.change)})</div></div>
			<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">From impressions</div><div class="tnum text-lg font-semibold">{sign(d.split.demand)}</div><div class="text-xs text-muted-foreground">{d.split.impressionsPct == null ? 'n/a' : `impressions ${d.split.impressionsPct > 0 ? '+' : ''}${Math.round(d.split.impressionsPct * 100)}%`}</div></div>
			<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">From click rate</div><div class="tnum text-lg font-semibold">{sign(d.split.clickRate)}</div><div class="text-xs text-muted-foreground">{d.split.ctrPct == null ? 'n/a' : `click rate ${d.split.ctrPct > 0 ? '+' : ''}${Math.round(d.split.ctrPct * 100)}%`}</div></div>
			<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Average position</div><div class="tnum text-lg font-semibold">{d.split.positionNow.toFixed(1)}</div><div class="text-xs text-muted-foreground">was {d.split.positionPrev.toFixed(1)}</div></div>
		</div>
	{/if}
</section>

<section class="card mb-4 p-4">
	<h2 class="mb-2 font-medium">The checks, in order</h2>
	<ol class="space-y-2 text-sm">
		{#each d.steps as s (s.n)}
			<li class="flex gap-3"><span class="w-20 shrink-0 text-xs font-medium {tone[s.status]}">{mark[s.status]}</span><div><div class="font-medium">{s.question}</div><div class="pii text-muted-foreground">{s.detail}</div></div></li>
		{/each}
	</ol>
</section>

{#if d.causes.length}
	<section class="card mb-4 p-4">
		<h2 class="mb-1 font-medium">Where the lost clicks went</h2>
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
		<h2 class="mb-1 font-medium">The pages that lost the most</h2>
		<p class="mb-2 text-xs text-muted-foreground">{d.concentration.concentrated ? 'A few pages account for most of it.' : 'The loss is spread over many pages.'}</p>
		<table class="w-full text-sm"><thead><tr><th class="th">Page</th><th class="th text-right">Clicks lost</th></tr></thead><tbody>
			{#each d.concentration.pages as p}<tr><td class="td pii max-w-96 truncate" title={p.key}>{p.key}</td><td class="td tnum text-right">{fmtInt(p.lost)}</td></tr>{/each}
		</tbody></table>
	</section>
{/if}
