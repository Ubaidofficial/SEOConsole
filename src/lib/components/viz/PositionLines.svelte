<script lang="ts">
	import ChartTip from '../ChartTip.svelte';
	/**
	 * Each competing page's position for one search, week by week. Position runs top-down (1 at the top), one line per page in the
	 * colour of its swatch in the table below, so the lines need no separate legend. Weeks where a page did not show leave a gap.
	 */
	let { weeks, pages, colors, height = 150 }: { weeks: string[]; pages: { page: string; positions: (number | null)[] }[]; colors: string[]; height?: number } = $props();
	let width = $state(560);
	const pad = { l: 30, r: 10, t: 10, b: 20 };
	const vals = $derived(pages.flatMap((p) => p.positions.filter((v): v is number => v != null)));
	const lo = $derived(Math.max(1, Math.floor(Math.min(...vals, 99))));
	const hi = $derived(Math.ceil(Math.max(...vals, lo + 2)));
	const X = (i: number) => pad.l + (i / Math.max(1, weeks.length - 1)) * (width - pad.l - pad.r);
	const Y = (v: number) => pad.t + ((v - lo) / Math.max(1, hi - lo)) * (height - pad.t - pad.b);
	const path = (ps: (number | null)[]) => { let d = '', pen = false; ps.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; }); return d; };
	const fmt = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
	let hover = $state<number | null>(null);
	function move(e: PointerEvent) {
		const r = (e.currentTarget as SVGElement).getBoundingClientRect();
		hover = Math.min(weeks.length - 1, Math.max(0, Math.round(((e.clientX - r.left - pad.l) / Math.max(1, width - pad.l - pad.r)) * (weeks.length - 1))));
	}
	const ticks = $derived([lo, Math.round((lo + hi) / 2), hi].filter((v, i, a) => a.indexOf(v) === i));
</script>

{#if vals.length}
	<div class="relative w-full" bind:clientWidth={width}>
		<svg {width} {height} onpointermove={move} onpointerdown={move} onpointerleave={() => (hover = null)} style="touch-action: pan-y" role="img" aria-label="Position by week for each competing page: {pages.map((p) => { const last = [...p.positions].reverse().find((v) => v != null); return `${p.page} latest ${last != null ? last.toFixed(1) : 'not shown'}`; }).join('; ')}">
			{#each ticks as t}
				<line x1={pad.l} x2={width - pad.r} y1={Y(t)} y2={Y(t)} stroke="var(--grid)" stroke-width="1" />
				<text x={pad.l - 6} y={Y(t) + 3} text-anchor="end" class="tnum fill-muted-foreground text-[10px]">{t}</text>
			{/each}
			{#each pages as p, i (p.page)}
				<path d={path(p.positions)} fill="none" stroke={colors[i] ?? 'var(--muted-foreground)'} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
				{#each p.positions as v, w}{#if v != null && (w === p.positions.length - 1 || p.positions[w + 1] == null)}<circle cx={X(w)} cy={Y(v)} r="4" fill={colors[i] ?? 'var(--muted-foreground)'} stroke="var(--card)" stroke-width="2"><title>{p.page}: position {v.toFixed(1)}, week of {fmt(weeks[w])}</title></circle>{/if}{/each}
			{/each}
			{#if hover != null}
				<line x1={X(hover)} x2={X(hover)} y1={pad.t} y2={height - pad.b} stroke="var(--muted-foreground)" stroke-opacity="0.45" />
				{#each pages as p, i (p.page)}{#if p.positions[hover] != null}<circle cx={X(hover)} cy={Y(p.positions[hover]!)} r="4" fill={colors[i] ?? 'var(--muted-foreground)'} stroke="var(--card)" stroke-width="2" />{/if}{/each}
			{/if}
			<text x={pad.l} y={height - 4} class="fill-muted-foreground text-[10px]">{fmt(weeks[0])}</text>
			<text x={width - pad.r} y={height - 4} text-anchor="end" class="fill-muted-foreground text-[10px]">{fmt(weeks[weeks.length - 1])}</text>
		</svg>
		{#if hover != null}
			<ChartTip x={X(hover)} {width} title="Week of {fmt(weeks[hover])}" rows={pages.map((p, i) => ({ label: p.page.replace(/^https?:\/\/[^/]+/, '') || '/', value: p.positions[hover!] == null ? 'not shown' : `#${p.positions[hover!]!.toFixed(1)}`, color: colors[i] ?? 'var(--muted-foreground)' }))} />
		{/if}
	</div>
{:else}<p class="text-xs text-muted-foreground">No weekly positions stored for these pages yet.</p>{/if}
