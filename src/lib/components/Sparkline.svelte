<script lang="ts">
	import ChartTip from './ChartTip.svelte';
	/**
	 * A tiny trend line for a table row. Hover or tap it for the value at each point (with its date when `dates` is given); the
	 * readout floats above the page, so a scrolling table cannot clip it.
	 */
	let {
		values,
		width = 120,
		height = 32,
		color = 'var(--c-clicks)',
		dates = [],
		label = 'Clicks',
		format = (v: number) => Math.round(v).toLocaleString('en-US')
	}: { values: number[]; width?: number; height?: number; color?: string; dates?: string[]; label?: string; format?: (v: number) => string } = $props();
	const max = $derived(Math.max(1, ...values));
	const x = (i: number) => (i / Math.max(1, values.length - 1)) * (width - 2) + 1;
	const y = (v: number) => height - 2 - (v / max) * (height - 4);
	const d = $derived(values.length < 2 ? '' : values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(''));
	let hover = $state<{ i: number; cx: number; cy: number } | null>(null);
	function move(e: PointerEvent) {
		const r = (e.currentTarget as SVGElement).getBoundingClientRect();
		const i = Math.min(values.length - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * (values.length - 1))));
		hover = { i, cx: r.left + x(i), cy: r.top };
	}
	const day = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : s);
</script>

<svg {width} {height} class="reveal-x overflow-visible" role="img" aria-label="{label}: {values.length ? `${format(values[0])} to ${format(values[values.length - 1])}` : 'no data'}" onpointermove={move} onpointerdown={move} onpointerleave={() => (hover = null)}>
	<rect {width} {height} fill="transparent" />
	{#if d}<path {d} fill="none" stroke={color} stroke-width="1.5" stroke-linejoin="round" />{/if}
	{#if hover}
		<line x1={x(hover.i)} x2={x(hover.i)} y1="0" y2={height} stroke="var(--muted-foreground)" stroke-opacity="0.4" />
		<circle cx={x(hover.i)} cy={y(values[hover.i])} r="2.5" fill={color} stroke="var(--card)" stroke-width="1" />
	{/if}
</svg>
{#if hover}<ChartTip fixed x={hover.cx} width={typeof window === 'undefined' ? 1200 : window.innerWidth} top={hover.cy - 52} title={dates[hover.i] ? day(dates[hover.i]) : `Point ${hover.i + 1} of ${values.length}`} rows={[{ label, value: format(values[hover.i]), color }]} />{/if}
