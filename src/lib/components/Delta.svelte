<script lang="ts">
	import { fmtSigned } from '$lib/format';
	import { Tip } from '$lib/components/ui/tooltip';
	import { ArrowDownRight, ArrowUpRight } from '@lucide/svelte';
	/**
	 * pct: value is a fraction (0.12 = +12%).
	 * pos: value is a change in search positions (negative = better, shown green).
	 * A null value renders an en dash; `why` explains it in a tooltip.
	 * The arrow shows the direction of the number (up or down); the colour shows whether that is good. `pill` puts it on a tinted
	 * capsule, for headline numbers.
	 */
	let { value, invert = false, mode = 'pct', why = '', pill = false }: { value: number | null; invert?: boolean; mode?: 'pct' | 'pos'; why?: string; pill?: boolean } = $props();
	const up = $derived(value != null && value > 0);
	const flat = $derived(value == null || Math.abs(value) < (mode === 'pos' ? 0.05 : 0.005));
	const good = $derived(flat ? null : mode === 'pos' || invert ? (value as number) < 0 : (value as number) > 0);
	// "flat" changes read as a plain zero, never as a signed "−0.0" or "+0.0%".
	const text = $derived(value == null ? '–' : flat ? (mode === 'pos' ? '0.0' : '0.0%') : mode === 'pos' ? `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}` : fmtSigned(value));
</script>

<Tip text={value == null ? why : ''}>
	<span class="tnum inline-flex items-center gap-0.5 text-xs {pill ? 'pill' : ''} {pill && good === true ? 'pill-good' : pill && good === false ? 'pill-bad' : pill ? 'pill-muted' : ''}" class:text-good={good === true} class:text-bad={good === false} class:text-muted-foreground={good === null}>{#if good !== null}{#if up}<ArrowUpRight class="size-3" aria-hidden="true" />{:else}<ArrowDownRight class="size-3" aria-hidden="true" />{/if}{/if}{text}</span>
</Tip>
