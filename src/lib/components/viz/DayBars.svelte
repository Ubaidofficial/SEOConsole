<script lang="ts">
	import ChartTip from '../ChartTip.svelte';
	/**
	 * Bars by day, one per day, stacked when there is more than one series (bottom first). Hover a bar for its numbers; the first and
	 * last dates are printed under the bars.
	 */
	type S = { label: string; color: string; values: number[] };
	let { days, series, height = 90, unit = '', legend = true }: { days: string[]; series: S[]; height?: number; unit?: string; legend?: boolean } = $props();
	const totals = $derived(days.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0)));
	const max = $derived(Math.max(1, ...totals));
	let w = $state(300);
	let hover = $state<number | null>(null);
	const fmt = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
</script>

<div>
	<div class="relative flex items-end gap-[2px]" bind:clientWidth={w} style="height:{height}px" role="img" aria-label="{series.map((s) => s.label).join(' and ')} by day, {days.length ? fmt(days[0]) : ''} to {days.length ? fmt(days[days.length - 1]) : ''}">
		{#each days as d, i}
			<div class="flex h-full min-w-0 flex-1 flex-col-reverse gap-px transition-opacity" style="opacity:{hover == null || hover === i ? 1 : 0.55}" role="presentation" onpointerenter={() => (hover = i)} onpointerdown={() => (hover = i)} onpointerleave={() => (hover = null)}>
				{#each series as s}
					{#if (s.values[i] ?? 0) > 0}<div class="w-full first:rounded-b-[2px] last:rounded-t-[2px]" style="height:{((s.values[i] ?? 0) / max) * 100}%;background:{s.color}"></div>{/if}
				{/each}
			</div>
		{/each}
		{#if hover != null && days[hover]}
			<ChartTip x={((hover + 0.5) / days.length) * w} width={w} top={-8} title={fmt(days[hover])} rows={[...series].reverse().map((s) => ({ label: s.label, value: `${(s.values[hover!] ?? 0).toLocaleString('en-US')}${unit}`, color: s.color, square: true }))} note={series.length > 1 ? `Total ${totals[hover].toLocaleString('en-US')}${unit}` : ''} />
		{/if}
	</div>
	{#if days.length}<div class="mt-1 flex justify-between text-[10.5px] text-muted-foreground"><span>{fmt(days[0])}</span><span>{fmt(days[days.length - 1])}</span></div>{/if}
	{#if legend && series.length > 1}
		<div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">{#each series as s}<span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-sm" style="background:{s.color}"></span>{s.label}</span>{/each}</div>
	{/if}
</div>
