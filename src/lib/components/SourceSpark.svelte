<script lang="ts" module>
	export interface SparkSeries {
		key: string;
		label: string;
		/** a CSS colour (a theme token), the source's identity colour */
		color: string;
		/** one value per day on the shared calendar; null = no data for that day (drawn as a gap, never as zero) */
		values: (number | null)[];
		/** how many of the newest days to draw dashed because the source may still revise them */
		dashed?: number;
		/** the previous period: drawn thin and dashed under the others, with no fill */
		ghost?: boolean;
	}
</script>

<script lang="ts">
	/**
	 * Several daily lines on one card chart: Search Console clicks, GA4 sessions and Bing clicks. They share one y-axis on
	 * purpose, since all three count visits; a source that sends little traffic draws low. The first series is drawn on top.
	 */
	let { series, height = 84, class: className = '' }: { series: SparkSeries[]; height?: number; class?: string } = $props();
	const uid = $props.id();
	const W = 300;

	const geom = $derived.by(() => {
		const H = height;
		const n = Math.max(0, ...series.map((s) => s.values.length));
		const max = Math.max(1, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
		const x = (i: number) => (n < 2 ? W / 2 : (i / (n - 1)) * W);
		const y = (v: number) => H - 3 - (v / max) * (H - 12);
		const path = (vals: (number | null)[], from: number, to: number) => {
			let d = '';
			let pen = false;
			for (let i = from; i <= to; i++) {
				const v = vals[i];
				if (v == null) {
					pen = false;
					continue;
				}
				d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
				pen = true;
			}
			return d;
		};
		const lines = series.map((s) => {
			let last = -1;
			s.values.forEach((v, i) => v != null && (last = i));
			const first = s.values.findIndex((v) => v != null);
			const cut = Math.max(first, last - (s.dashed ?? 0));
			// Area only under a lone line: stacked translucent fills would muddy each other.
			const area = !s.ghost && series.filter((x) => !x.ghost).length === 1 && last > first ? `${path(s.values, first, last)}L${x(last).toFixed(1)},${H}L${x(first).toFixed(1)},${H}Z` : '';
			return { ...s, solid: last >= 0 ? path(s.values, first, cut) : '', tail: cut < last ? path(s.values, cut, last) : '', area, empty: last < 0 };
		});
		return { H, lines: lines.reverse(), path: (v: (number | null)[]) => path(v, 0, v.length - 1) };
	});
	const label = $derived(`Daily ${series.map((s) => s.label).join(', ')}`);
</script>

<svg viewBox="0 0 {W} {geom.H}" preserveAspectRatio="none" class="reveal-x block w-full overflow-visible {className}" style="height:{height}px" role="img" aria-label={label}>
	<defs>
		<linearGradient id="fill-{uid}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stop-color="currentColor" stop-opacity="0.28" />
			<stop offset="100%" stop-color="currentColor" stop-opacity="0" />
		</linearGradient>
	</defs>
	{#if geom.lines.every((l) => l.empty)}
		<line x1="0" x2={W} y1={geom.H - 3} y2={geom.H - 3} stroke="currentColor" stroke-opacity="0.35" vector-effect="non-scaling-stroke" />
	{/if}
	{#each geom.lines as l (l.key)}
		<g style="color:{l.color}">
			{#if l.ghost}<path d={geom.path(l.values)} fill="none" stroke="currentColor" stroke-width="1.25" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" opacity="0.45" />{:else}
			{#if l.area}<path d={l.area} fill="url(#fill-{uid})" />{/if}
			<path d={l.solid} fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" style="filter:drop-shadow(0 2px 5px color-mix(in oklab, currentColor 40%, transparent))" />
			{#if l.tail}<path d={l.tail} fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 4" stroke-linecap="round" vector-effect="non-scaling-stroke" opacity="0.75" />{/if}
			{/if}
		</g>
	{/each}
</svg>
