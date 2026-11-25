<script lang="ts">
	import ChartTip from './ChartTip.svelte';
	/**
	 * Daily positions, 1 at the top. Gaps are days with no impression; the dashed line marks position 10 (the end of page one).
	 * Hover or tap for the position on a day.
	 */
	let { values, width = 140, height = 30, dates = [] }: { values: (number | null)[]; width?: number; height?: number; dates?: string[] } = $props();
	const shown = $derived(values.filter((v): v is number => v != null));
	const worst = $derived(Math.max(10.5, ...shown));
	const y = (p: number) => 2 + ((p - 1) / Math.max(1, worst - 1)) * (height - 4);
	const x = (i: number) => (values.length < 2 ? width / 2 : 1 + (i / (values.length - 1)) * (width - 2));
	const d = $derived(values.map((v, i) => (v == null ? '' : `${i && values[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join(''));
	let hover = $state<{ i: number; cx: number; cy: number } | null>(null);
	function move(e: PointerEvent) {
		const r = (e.currentTarget as SVGElement).getBoundingClientRect();
		const i = Math.min(values.length - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * (values.length - 1))));
		hover = { i, cx: r.left + x(i), cy: r.top };
	}
	const day = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : s);
</script>

<svg {width} {height} class="overflow-visible" role="img" aria-label="Daily position{shown.length ? `, latest ${shown[shown.length - 1].toFixed(1)}` : ''}" onpointermove={move} onpointerdown={move} onpointerleave={() => (hover = null)}>
	<rect {width} {height} fill="transparent" />
	<line x1="0" x2={width} y1={y(10.5)} y2={y(10.5)} stroke="var(--border)" stroke-dasharray="2 2" />
	{#if d}<path {d} fill="none" stroke="var(--c-position, var(--link))" stroke-width="1.5" stroke-linejoin="round" />{/if}
	{#each values as v, i}{#if v != null && (i === 0 || values[i - 1] == null) && (i === values.length - 1 || values[i + 1] == null)}<circle cx={x(i)} cy={y(v)} r="1.5" fill="var(--c-position, var(--link))" />{/if}{/each}
	{#if hover}
		<line x1={x(hover.i)} x2={x(hover.i)} y1="0" y2={height} stroke="var(--muted-foreground)" stroke-opacity="0.4" />
		{#if values[hover.i] != null}<circle cx={x(hover.i)} cy={y(values[hover.i]!)} r="2.5" fill="var(--c-position, var(--link))" stroke="var(--card)" stroke-width="1" />{/if}
	{/if}
</svg>
{#if hover}<ChartTip fixed x={hover.cx} width={typeof window === 'undefined' ? 1200 : window.innerWidth} top={hover.cy - 52} title={dates[hover.i] ? day(dates[hover.i]) : `Day ${hover.i + 1} of ${values.length}`} rows={[{ label: 'position', value: values[hover.i] == null ? 'no impressions' : values[hover.i]!.toFixed(1), color: 'var(--c-position, var(--link))' }]} />{/if}
