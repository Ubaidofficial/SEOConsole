<script lang="ts" module>
	/** The map shapes (static/geo/world.json, built by scripts/build-world-map.mjs), loaded once per page visit. */
	type World = { w: number; h: number; c: Record<string, { n: string; a2: string; d: string }> };
	let cached: Promise<World> | null = null;
	export const loadWorld = () => (cached ??= fetch('/geo/world.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))));
	/** A country's flag as an emoji, from its two-letter code ("us" → 🇺🇸). */
	export const flagOf = (a2: string) => (/^[a-z]{2}$/.test(a2) ? String.fromCodePoint(...[...a2.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { fmtCompact, fmtInt, fmtSigned } from '$lib/format';
	/**
	 * Clicks by country on a world map (shaded by share, in five steps of one hue) beside a ranked list with flags and the change
	 * against the period before. Countries are Search Console's lowercase three-letter codes.
	 */
	type Row = { country: string; clicks: number; impressions: number; prev: number | null };
	let { rows, unit = 'clicks', limit = 8 }: { rows: Row[]; unit?: string; limit?: number } = $props();
	let world = $state<World | null>(null);
	let failed = $state(false);
	let hover = $state<string | null>(null);
	onMount(() => {
		loadWorld().then((w) => (world = w)).catch(() => (failed = true));
	});
	const total = $derived(rows.reduce((a, r) => a + r.clicks, 0));
	const by = $derived(new Map(rows.map((r) => [r.country.toLowerCase(), r])));
	const max = $derived(Math.max(1, ...rows.map((r) => r.clicks)));
	/** Five steps on a square-root scale, so one big country does not leave every other one blank. */
	const step = (v: number) => (v <= 0 ? 0 : Math.min(5, 1 + Math.floor(Math.sqrt(v / max) * 4.999)));
	const FILL = ['var(--muted)', 'var(--ord-4)', 'var(--ord-3)', 'var(--ord-2)', 'var(--ord-1)', 'var(--ord-1)'];
	const name = (c: string) => world?.c[c]?.n ?? c.toUpperCase();
	const flag = (c: string) => flagOf(world?.c[c]?.a2 ?? '');
	const top = $derived(rows.slice(0, limit));
	const hovered = $derived(hover ? by.get(hover) : null);
</script>

<div class="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
	<div class="relative min-w-0">
		{#if world}
			<svg viewBox="0 0 {world.w} {world.h}" class="block h-auto w-full overflow-hidden" role="img" aria-label="Map of {unit} by country; the list beside it has the numbers">
				{#each Object.entries(world.c) as [code, c] (code)}
					{#if c.d}
						{@const r = by.get(code)}
						<path d={c.d} fill={FILL[step(r?.clicks ?? 0)]} stroke="var(--card)" stroke-width="0.5" class="transition-opacity {hover && hover !== code ? 'opacity-70' : ''}" onpointerenter={() => (hover = code)} onpointerleave={() => (hover = null)} role="presentation"><title>{c.n}: {fmtInt(r?.clicks ?? 0)} {unit}</title></path>
					{/if}
				{/each}
			</svg>
			<div class="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">less{#each [1, 2, 3, 4, 5] as i}<span class="h-2 w-5 rounded-sm" style="background:{FILL[i]}"></span>{/each}more</div>
			{#if hovered}<div class="pointer-events-none absolute top-2 left-2 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-sm"><b>{flag(hover!)} {name(hover!)}</b> · {fmtInt(hovered.clicks)} {unit}</div>{/if}
		{:else if failed}
			<p class="text-xs text-muted-foreground">The map could not be loaded; the list has the numbers.</p>
		{:else}
			<div class="aspect-[1000/394] w-full animate-pulse rounded-lg bg-muted"></div>
		{/if}
	</div>
	<ol class="min-w-0 space-y-2 text-sm">
		{#each top as r, i (r.country)}
			<li class="grid grid-cols-[1.25rem_minmax(0,1fr)_auto_auto] items-center gap-x-2" onpointerenter={() => (hover = r.country.toLowerCase())} onpointerleave={() => (hover = null)}>
				<span class="tnum text-xs text-muted-foreground">{i + 1}</span>
				<span class="min-w-0"><span class="block truncate"><span aria-hidden="true">{flag(r.country.toLowerCase())}</span> {name(r.country.toLowerCase())}</span><span class="mt-1 block h-1 rounded-full bg-muted"><span class="block h-full rounded-full bg-[color:var(--ord-2)]" style="width:{Math.max(2, (r.clicks / max) * 100)}%"></span></span></span>
				<span class="tnum text-right font-medium">{fmtCompact(r.clicks)}<span class="block text-[10.5px] font-normal text-muted-foreground">{total ? Math.round((r.clicks / total) * 100) : 0}%</span></span>
				<span class="tnum w-12 text-right text-xs {r.prev == null || !r.prev ? 'text-muted-foreground' : r.clicks >= r.prev ? 'text-good' : 'text-bad'}">{r.prev ? fmtSigned(r.clicks / r.prev - 1, 0) : '–'}</span>
			</li>
		{/each}
	</ol>
</div>
