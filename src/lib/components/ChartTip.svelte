<script lang="ts" module>
	export interface TipRow {
		/** the series name: secondary text */
		label: string;
		/** the number, already formatted: the strong part */
		value: string;
		/** the series colour, shown as a short line key (never as the text colour) */
		color?: string;
		/** a dashed key, for the previous period or a projection */
		dashed?: boolean;
		/** a bar or area series is keyed by a small square instead of a line */
		square?: boolean;
	}
</script>

<script lang="ts">
	/**
	 * The one hover readout every chart uses: a heading (the date or the item) and a row per series, value first and strong, the
	 * series name after it, keyed by a short stroke of the series colour. Positioned inside a `relative` chart container at `x`
	 * (px from its left), kept inside it, and flipped to the left of the pointer near the right edge. Text goes in as text, never
	 * as markup, since labels can be search queries or page titles.
	 */
	let { x, width, title, rows, top = 0, note = '', fixed = false }: { x: number; width: number; title: string; rows: TipRow[]; top?: number; note?: string; /** x and top are viewport coordinates (for charts inside scrolling tables, which would clip it) */ fixed?: boolean } = $props();
	const W = 250;
	const left = $derived(x + 14 + W > width ? Math.max(0, x - 14 - W) : x + 14);
</script>

<div class="chart-tip pointer-events-none {fixed ? 'fixed' : 'absolute'} z-50 rounded-lg border bg-popover px-2.5 py-2 text-xs shadow-lg" style="left:{left}px; top:{top}px; width:max-content; max-width:{W}px" role="status" aria-live="polite">
	<div class="mb-1 font-medium text-foreground">{title}</div>
	{#each rows as r}
		<div class="flex items-center gap-2 leading-5">
			{#if r.color}<span class="inline-block shrink-0 {r.square ? 'size-2 rounded-[2px]' : 'h-0.5 w-3 rounded-full'}" style={r.dashed ? `background:repeating-linear-gradient(90deg, ${r.color} 0 3px, transparent 3px 5px)` : `background:${r.color}`} aria-hidden="true"></span>{/if}
			<b class="tnum font-semibold text-foreground">{r.value}</b>
			<span class="truncate text-muted-foreground">{r.label}</span>
		</div>
	{/each}
	{#if note}<div class="mt-1 text-[10.5px] text-muted-foreground">{note}</div>{/if}
</div>
