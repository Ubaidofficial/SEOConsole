<script lang="ts">
	import type { Trend } from '$lib/trend';
	import ChartTip from './ChartTip.svelte';
	/**
	 * Filled area chart for a card, coloured by trend (green = growing, red = falling, grey = flat).
	 * The last `dashed` points are drawn dashed: Search Console revises the most recent days.
	 */
	let { values, trend = 'flat', dashed = 2, height = 84, class: className = '', dates = [], label = 'Clicks' }: { values: number[]; trend?: Trend; dashed?: number; height?: number; class?: string; dates?: string[]; label?: string } = $props();
	let w = $state(300);
	let hover = $state<number | null>(null);
	function move(e: PointerEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		if (values.length < 1 || !r.width) return;
		hover = Math.min(values.length - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * (values.length - 1))));
	}
	const day = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : s);
	const uid = $props.id();
	const W = 300;
	const geom = $derived.by(() => {
		const n = values.length;
		const H = height;
		const max = Math.max(1, ...values);
		const pts = values.map((v, i) => [n < 2 ? W / 2 : (i / (n - 1)) * W, H - 3 - (v / max) * (H - 12)] as const);
		const d = (a: readonly (readonly [number, number])[]) => a.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
		const cut = Math.max(1, n - dashed);
		return {
			H,
			line: d(pts.slice(0, cut + 1)),
			tail: n > 1 ? d(pts.slice(cut)) : '',
			area: n > 1 ? `${d(pts)}L${W},${H}L0,${H}Z` : ''
		};
	});
	const color = $derived(trend === 'up' ? 'var(--trend-up)' : trend === 'down' ? 'var(--trend-down)' : 'color-mix(in oklab, var(--foreground) 55%, transparent)');
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="relative {className}" bind:clientWidth={w} onpointermove={move} onpointerdown={move} onpointerleave={() => (hover = null)} style="touch-action: pan-y">
<svg
	viewBox="0 0 {W} {geom.H}"
	preserveAspectRatio="none"
	class="reveal-x block w-full overflow-visible"
	style="height:{height}px;color:{color}"
	role="img"
	aria-label={trend === 'up' ? 'Daily clicks, growing' : trend === 'down' ? 'Daily clicks, falling' : 'Daily clicks'}
>
	<defs>
		<linearGradient id="fill-{uid}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stop-color="currentColor" stop-opacity="0.28" />
			<stop offset="100%" stop-color="currentColor" stop-opacity="0" />
		</linearGradient>
	</defs>
	{#if geom.area}
		<path d={geom.area} fill="url(#fill-{uid})" />
		<path d={geom.line} fill="none" stroke="currentColor" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" style="filter:drop-shadow(0 2px 5px color-mix(in oklab, currentColor 45%, transparent))" />
		<path d={geom.tail} fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 4" stroke-linecap="round" vector-effect="non-scaling-stroke" opacity="0.75" />
	{:else}
		<line x1="0" x2={W} y1={geom.H - 3} y2={geom.H - 3} stroke="currentColor" stroke-opacity="0.35" vector-effect="non-scaling-stroke" />
	{/if}
	{#if hover != null}<line x1={values.length < 2 ? W / 2 : (hover / (values.length - 1)) * W} x2={values.length < 2 ? W / 2 : (hover / (values.length - 1)) * W} y1="0" y2={geom.H} stroke="var(--muted-foreground)" stroke-opacity="0.45" vector-effect="non-scaling-stroke" />{/if}
</svg>
{#if hover != null}
	{@const px = values.length < 2 ? w / 2 : (hover / (values.length - 1)) * w}
	<span class="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[var(--card)]" style="left:{px}px; top:{geom.H - 3 - (values[hover] / Math.max(1, ...values)) * (geom.H - 12)}px; background:{color}"></span>
	<ChartTip x={px} width={w} top={-4} title={dates[hover] ? day(dates[hover]) : `Day ${hover + 1} of ${values.length}`} rows={[{ label, value: Math.round(values[hover]).toLocaleString('en-US'), color }]} note={hover >= values.length - dashed ? 'Still being revised by Google' : ''} />
{/if}
</div>
