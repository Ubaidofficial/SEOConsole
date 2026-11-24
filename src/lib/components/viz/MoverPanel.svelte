<script lang="ts">
	import Sparkline from '$lib/components/Sparkline.svelte';
	import { fmtCompact, fmtInt } from '$lib/format';
	/**
	 * The biggest searches or pages of the period, each with a bar for its size, its change against the period before and its daily
	 * line, with a switch between the biggest, the ones gaining most and the ones losing most.
	 */
	type Row = { key: string; clicks: number; prev: number | null; change: number | null; impressions: number; position: number; spark: number[] };
	let { title, rows, unit, href, comparable, pii = () => false, label = (k: string) => k }: { title: string; rows: { all: Row[]; rising: Row[]; falling: Row[] }; unit: string; href: string; comparable: boolean; pii?: (k: string) => boolean; label?: (k: string) => string } = $props();
	let mode = $state<'all' | 'rising' | 'falling'>('all');
	const shown = $derived(rows[mode]);
	const max = $derived(Math.max(1, ...shown.map((r) => (mode === 'all' ? r.clicks : Math.abs(r.change ?? 0)))));
	const tabs = $derived([['all', 'All'], ...(comparable ? [['rising', 'Rising'], ['falling', 'Falling']] : [])] as [typeof mode, string][]);
</script>

<section class="rounded-2xl border bg-card p-5 shadow-xs">
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<h2 class="text-base font-semibold tracking-tight"><a class="hover:underline" {href}>{title}</a></h2>
		<div class="seg ml-auto" role="group" aria-label="{title}: which to show">
			{#each tabs as [id, l]}<button type="button" aria-pressed={mode === id} class="seg-item !py-0.5 !text-xs {mode === id ? 'seg-on' : ''}" onclick={() => (mode = id)}>{l}</button>{/each}
		</div>
	</div>
	{#if shown.length}
		<ul class="space-y-2.5">
			{#each shown as r (r.key)}
				{@const size = mode === 'all' ? r.clicks : Math.abs(r.change ?? 0)}
				<li class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3">
					<div class="min-w-0">
						<div class="truncate text-[13px] {pii(r.key) ? 'pii' : ''}" title={label(r.key)}>{label(r.key)}</div>
						<div class="mt-1 h-1.5 rounded-full bg-muted"><div class="h-full rounded-full {mode === 'falling' ? 'bg-[color:var(--bad)]' : 'bg-[color:var(--c-clicks)]'}" style="width:{Math.max(2, (size / max) * 100)}%"></div></div>
					</div>
					<div class="tnum text-right text-[13px]">
						<div class="font-medium">{fmtCompact(r.clicks)}</div>
						{#if r.change != null}<div class="text-[11px] {r.change > 0 ? 'text-good' : r.change < 0 ? 'text-bad' : 'text-muted-foreground'}">{r.change > 0 ? '+' : r.change < 0 ? '−' : ''}{fmtInt(Math.abs(r.change))}</div>{/if}
					</div>
					<Sparkline values={r.spark} width={72} height={24} color={mode === 'falling' ? 'var(--bad)' : 'var(--c-clicks)'} />
				</li>
			{/each}
		</ul>
		<p class="mt-3 text-[11px] text-muted-foreground">Clicks in the period{comparable ? ', the change against the period before,' : ''} and the daily line. <a class="underline" {href}>All {unit}</a></p>
	{:else}
		<p class="text-sm text-muted-foreground">{mode === 'all' ? 'No data in this period yet.' : mode === 'rising' ? 'Nothing gained clicks against the period before.' : 'Nothing lost clicks against the period before.'}</p>
	{/if}
</section>
