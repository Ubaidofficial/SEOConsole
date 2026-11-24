<script lang="ts">
	/** A ring split into parts, with the total in the middle and each part's share beside it. */
	type Part = { label: string; value: number; color: string; note?: string };
	let { parts, center, sub = '', size = 128 }: { parts: Part[]; center: string; sub?: string; size?: number } = $props();
	const total = $derived(parts.reduce((a, p) => a + Math.max(0, p.value), 0));
	const R = 15.915; // circumference 100, so dash lengths are percentages
	const arcs = $derived.by(() => {
		let at = 0;
		return parts.filter((p) => p.value > 0).map((p) => {
			const pct = total ? (p.value / total) * 100 : 0;
			const a = { ...p, pct, offset: 25 - at };
			at += pct;
			return a;
		});
	});
</script>

<div class="flex flex-wrap items-center gap-5">
	<svg width={size} height={size} viewBox="0 0 42 42" role="img" aria-label="{parts.map((p) => `${p.label} ${total ? Math.round((p.value / total) * 100) : 0}%`).join(', ')}">
		<circle cx="21" cy="21" r={R} fill="none" stroke="var(--muted)" stroke-width="6" />
		{#each arcs as a}<circle cx="21" cy="21" r={R} fill="none" stroke={a.color} stroke-width="6" stroke-dasharray="{Math.max(0, a.pct - 0.6)} {100 - Math.max(0, a.pct - 0.6)}" stroke-dashoffset={a.offset} />{/each}
		<text x="21" y="21" text-anchor="middle" font-size="6.5" font-weight="600" fill="var(--foreground)">{center}</text>
		{#if sub}<text x="21" y="27" text-anchor="middle" font-size="3.6" fill="var(--muted-foreground)">{sub}</text>{/if}
	</svg>
	<ul class="min-w-0 flex-1 space-y-2 text-sm">
		{#each parts as p}
			<li class="flex items-baseline gap-2"><span class="size-2.5 shrink-0 rounded-sm" style="background:{p.color}"></span><span class="capitalize">{p.label}</span><span class="tnum ml-auto font-semibold">{total ? Math.round((p.value / total) * 100) : 0}%</span>{#if p.note}<span class="tnum text-xs text-muted-foreground">{p.note}</span>{/if}</li>
		{/each}
	</ul>
</div>
