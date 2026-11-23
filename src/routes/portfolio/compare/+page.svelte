<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import LineChart from '$lib/components/LineChart.svelte';
	import PeriodPicker from '$lib/components/PeriodPicker.svelte';
	import Explainer from '$lib/components/Explainer.svelte';
	import { fmtInt, fmtSigned } from '$lib/format';
	let { data } = $props();
	const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--muted-foreground)'];
	function set(k: string, v: string | string[] | null) {
		const u = new URL(page.url);
		u.searchParams.delete(k);
		for (const x of Array.isArray(v) ? v : v ? [v] : []) u.searchParams.append(k, x);
		goto(u.pathname + u.search, { keepFocus: true, noScroll: true });
	}
	const toggle = (id: number) => {
		const have = data.chosen.map(String);
		set('s', have.includes(String(id)) ? have.filter((x) => x !== String(id)) : [...have, String(id)].slice(-4));
	};
</script>

<div class="mb-4 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold tracking-tight">Compare sites</h1>
	<PeriodPicker days={data.days} latest={data.latest} />
	<div class="ml-auto flex flex-wrap items-center gap-2">
		<select class="input" aria-label="Measure" value={data.metric} onchange={(e) => set('m', e.currentTarget.value)}><option value="clicks">Clicks</option><option value="impressions">Impressions</option></select>
		<select class="input" aria-label="Scale" value={data.mode} onchange={(e) => set('mode', e.currentTarget.value)}><option value="index">Indexed: first week = 100</option><option value="actual">Actual numbers</option></select>
		<label class="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={data.smooth} onchange={(e) => set('smooth', e.currentTarget.checked ? null : '0')} />7-day average</label>
	</div>
</div>

<div class="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Sites to compare">
	{#each data.options as o}
		{@const i = data.chosen.indexOf(o.id)}
		<button type="button" class="chip pii {i >= 0 ? 'chip-on' : ''}" aria-pressed={i >= 0} onclick={() => toggle(o.id)}>{#if i >= 0}<span class="mr-1 inline-block size-2 rounded-full" style="background:{COLORS[i]}" aria-hidden="true"></span>{/if}{o.name}</button>
	{/each}
</div>

{#if data.chart}
	<div class="card p-4">
		<LineChart xs={data.chart.xs} series={data.chart.series.map((s, i) => ({ label: s.name, color: COLORS[i], values: s.values, dashed: i === 3 }))} markers={data.chart.updates} baseline={data.mode === 'index' ? 100 : null} zero={data.mode === 'actual'} height={300} format={(n) => (data.mode === 'index' ? String(Math.round(n)) : fmtInt(n))} />
		<div class="tnum mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
			{#each data.chart.series as s, i}
				<span class="inline-flex min-w-0 flex-wrap items-center gap-x-1.5"><span class="h-0.5 w-4 rounded-full" style="background:{COLORS[i]}" aria-hidden="true"></span><span class="pii break-all">{s.name}</span><b>{fmtInt(s.total)}</b>{data.metric}{#if s.change != null}<span>{' · '}<span class={s.change < 0 ? 'text-bad' : 'text-good'}>{fmtSigned(s.change)}</span> start to end</span>{/if}{#if s.noBase}<span class="text-muted-foreground">{' · '}nothing in its first week to index from</span>{/if}</span>
			{/each}
		</div>
	</div>
	<Explainer lead="Indexed lines start at 100, so a big and a small site share one axis. Vertical lines are Google updates.">
		<p>Indexed: each site's first week in the period is 100, so 80 means 20% below where it started. Actual: the real daily numbers on one axis. The 7-day average smooths weekday swings. For a migration, pick the old and the new site and look for the hand-over: the old line falling as the new one rises.</p>
	</Explainer>
{:else}
	<p class="rounded-xl border bg-card px-4 py-6 text-center text-sm text-muted-foreground" style="border-color:var(--border)">Pick two to four sites above.</p>
{/if}
