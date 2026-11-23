<script lang="ts">
	/** Daily positions, 1 at the top. Gaps are days with no impression; the dashed line marks position 10 (the end of page one). */
	let { values, width = 140, height = 30 }: { values: (number | null)[]; width?: number; height?: number } = $props();
	const shown = $derived(values.filter((v): v is number => v != null));
	const worst = $derived(Math.max(10.5, ...shown));
	const y = (p: number) => 2 + ((p - 1) / Math.max(1, worst - 1)) * (height - 4);
	const x = (i: number) => (values.length < 2 ? width / 2 : 1 + (i / (values.length - 1)) * (width - 2));
	const d = $derived(values.map((v, i) => (v == null ? '' : `${i && values[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join(''));
</script>

<svg {width} {height} aria-hidden="true" class="overflow-visible">
	<line x1="0" x2={width} y1={y(10.5)} y2={y(10.5)} stroke="var(--border)" stroke-dasharray="2 2" />
	{#if d}<path {d} fill="none" stroke="var(--c-position, var(--link))" stroke-width="1.5" stroke-linejoin="round" />{/if}
	{#each values as v, i}{#if v != null && (i === 0 || values[i - 1] == null) && (i === values.length - 1 || values[i + 1] == null)}<circle cx={x(i)} cy={y(v)} r="1.5" fill="var(--c-position, var(--link))" />{/if}{/each}
</svg>
