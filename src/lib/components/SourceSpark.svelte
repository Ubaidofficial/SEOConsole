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
		/** the previous period: drawn thin and dashed under the first series, in its row, with no fill */
		ghost?: boolean;
	}
</script>

<script lang="ts">
	import ChartTip, { type TipRow } from './ChartTip.svelte';

	/**
	 * Daily lines for one site: Search Console clicks, GA4 sessions and Bing clicks, plus the previous period as a ghost.
	 *
	 * The sources differ by an order of magnitude (a site with 3,000 GA4 sessions and 70 Google clicks drew Google as a flat line),
	 * so when they do, each source gets its own row with its own scale (small multiples), its name and its peak printed on the row,
	 * instead of one shared axis or two y-axes. `layout="shared"` keeps one scale when the comparison itself is the point.
	 *
	 * Hover (or tap) anywhere: a hairline snaps to the nearest day and one readout lists every source on that day, so nobody has
	 * to aim at a 2px line. Values come from `values`; days from `dates` when given.
	 */
	let {
		series,
		dates = [],
		height = 84,
		layout = 'auto',
		format = (v: number) => Math.round(v).toLocaleString('en-US'),
		class: className = ''
	}: { series: SparkSeries[]; dates?: string[]; height?: number; layout?: 'auto' | 'shared' | 'rows'; format?: (v: number) => string; class?: string } = $props();

	const W = 300;
	const uid = $props.id();
	const main = $derived(series.filter((s) => !s.ghost));
	const ghosts = $derived(series.filter((s) => s.ghost));
	const peak = (s: SparkSeries) => Math.max(0, ...s.values.map((v) => v ?? 0));
	// Rows when the busiest source is more than 4x the quietest one that has any data: on one scale the quiet one is unreadable.
	const rows = $derived.by(() => {
		if (layout === 'shared' || main.length < 2) return false;
		if (layout === 'rows') return true;
		const peaks = main.map(peak).filter((p) => p > 0);
		return peaks.length >= 2 && Math.max(...peaks) > 4 * Math.min(...peaks);
	});
	const n = $derived(Math.max(0, ...series.map((s) => s.values.length)));
	const x = (i: number) => (n < 2 ? W / 2 : (i / (n - 1)) * W);

	interface Band { top: number; h: number; max: number; members: SparkSeries[]; label: string | null }
	// A row needs room for its name and a readable line: rows add height rather than squeeze.
	const H = $derived(rows ? Math.max(height, main.length * 40) : height);
	const bands = $derived.by((): Band[] => {
		if (!rows) return [{ top: 0, h: H, max: Math.max(1, ...series.map(peak)), members: [...ghosts, ...main], label: null }];
		const gap = 6;
		const each = (H - gap * (main.length - 1)) / main.length;
		return main.map((s, k) => {
			const members = k === 0 ? [...ghosts, s] : [s];
			return { top: k * (each + gap), h: each, max: Math.max(1, ...members.map(peak)), members, label: s.label };
		});
	});
	const yIn = (b: Band, v: number) => b.top + b.h - 2 - (v / b.max) * (b.h - (b.label ? 14 : 10));

	const pathOf = (b: Band, vals: (number | null)[], from: number, to: number) => {
		let d = '';
		let pen = false;
		for (let i = from; i <= to; i++) {
			const v = vals[i];
			if (v == null) {
				pen = false;
				continue;
			}
			d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${yIn(b, v).toFixed(1)}`;
			pen = true;
		}
		return d;
	};
	const drawn = $derived(
		bands.flatMap((b) =>
			// ghosts first so the current period is drawn on top
			[...b.members].sort((a, c) => Number(!!c.ghost) - Number(!!a.ghost)).map((s) => {
				let last = -1;
				s.values.forEach((v, i) => v != null && (last = i));
				const first = s.values.findIndex((v) => v != null);
				const cut = Math.max(first, last - (s.dashed ?? 0));
				const lone = rows || main.length === 1;
				const area = !s.ghost && lone && last > first ? `${pathOf(b, s.values, first, last)}L${x(last).toFixed(1)},${(b.top + b.h).toFixed(1)}L${x(first).toFixed(1)},${(b.top + b.h).toFixed(1)}Z` : '';
				return { s, b, area, all: pathOf(b, s.values, 0, s.values.length - 1), solid: last >= 0 ? pathOf(b, s.values, first, cut) : '', tail: cut < last ? pathOf(b, s.values, cut, last) : '', empty: last < 0 };
			})
		)
	);
	const label = $derived(`Daily ${main.map((s) => s.label).join(', ')}${rows ? ', each on its own scale' : ''}`);

	let w = $state(300);
	let hover = $state<number | null>(null);
	function move(e: PointerEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		if (n < 1 || !r.width) return;
		hover = Math.min(n - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
	}
	const fmtDay = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : d);
	const tip = $derived.by(() => {
		if (hover == null) return null;
		const i = hover;
		const out: TipRow[] = [];
		for (const s of [...main, ...ghosts]) {
			const v = s.values[i];
			out.push({ label: s.label, value: v == null ? 'no data' : format(v), color: s.color, dashed: !!s.ghost });
		}
		const revised = main.some((s) => s.dashed && i > (s.values.length - 1 - (s.dashed ?? 0)) && s.values[i] != null);
		return { title: dates[i] ? fmtDay(dates[i]) : `Day ${i + 1} of ${n}`, rows: out, note: revised ? 'Still being revised by the source' : '' };
	});
	const px = (i: number) => (n < 2 ? w / 2 : (i / (n - 1)) * w);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="relative {className}" bind:clientWidth={w} onpointermove={move} onpointerdown={move} onpointerleave={() => (hover = null)} style="touch-action: pan-y">
	<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="reveal-x block w-full overflow-visible" style="height:{H}px" role="img" aria-label={label}>
		<defs>
			{#each main as s (s.key)}
				<linearGradient id="fill-{s.key}-{uid}" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stop-color={s.color} stop-opacity="0.22" />
					<stop offset="100%" stop-color={s.color} stop-opacity="0" />
				</linearGradient>
			{/each}
		</defs>
		{#if rows}{#each bands.slice(1) as b}<line x1="0" x2={W} y1={b.top - 3} y2={b.top - 3} stroke="var(--grid, var(--border))" vector-effect="non-scaling-stroke" />{/each}{/if}
		{#if drawn.every((l) => l.empty)}
			<line x1="0" x2={W} y1={H - 3} y2={H - 3} stroke="currentColor" stroke-opacity="0.35" vector-effect="non-scaling-stroke" />
		{/if}
		{#each drawn as l (l.s.key)}
			{#if l.s.ghost}<path d={l.all} fill="none" stroke={l.s.color} stroke-width="1.25" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" opacity="0.45" />{:else}
				{#if l.area}<path d={l.area} fill="url(#fill-{l.s.key}-{uid})" />{/if}
				<path d={l.solid} fill="none" stroke={l.s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
				{#if l.tail}<path d={l.tail} fill="none" stroke={l.s.color} stroke-width="2" stroke-dasharray="3 4" stroke-linecap="round" vector-effect="non-scaling-stroke" opacity="0.75" />{/if}
			{/if}
		{/each}
		{#if hover != null}<line x1={x(hover)} x2={x(hover)} y1="0" y2={H} stroke="var(--muted-foreground)" stroke-opacity="0.45" vector-effect="non-scaling-stroke" />{/if}
	</svg>
	{#if rows}
		<!-- Each row is on its own scale, so it says whose row it is and how high it goes: never compare row heights. -->
		{#each bands as b}
			<div class="tnum pointer-events-none absolute left-0 text-[10px] leading-none text-muted-foreground" style="top:{b.top}px">{b.label} · {Math.max(0, ...b.members.filter((m) => !m.ghost).map(peak)) > 0 ? `peak ${format(Math.max(...b.members.filter((m) => !m.ghost).map(peak)))}` : 'none'}</div>
		{/each}
	{/if}
	{#if hover != null}
		{#each drawn as l (l.s.key)}
			{@const v = l.s.values[hover]}
			{#if v != null && !l.s.ghost}<span class="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[var(--card)]" style="left:{px(hover)}px; top:{yIn(l.b, v)}px; background:{l.s.color}"></span>{/if}
		{/each}
		{#if tip}<ChartTip x={px(hover)} width={w} title={tip.title} rows={tip.rows} note={tip.note} top={-4} />{/if}
	{/if}
</div>
