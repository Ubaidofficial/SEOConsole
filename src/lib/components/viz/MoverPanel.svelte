<script lang="ts">
	import Sparkline from '$lib/components/Sparkline.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import { Check, Copy, ExternalLink } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { fmtCompact, fmtInt } from '$lib/format';
	import type { Icon } from '$lib/icons';
	/**
	 * The biggest searches or pages of the period, each with a bar for its size, its change against the period before and its daily
	 * line, with a switch between the biggest, the ones gaining most and the ones losing most.
	 */
	type Row = { key: string; clicks: number; prev: number | null; change: number | null; impressions: number; position: number; spark: number[] };
	let { title, rows, unit, href, comparable, pii = () => false, label = (k: string) => k, icon = undefined, info = '', open = undefined }: { title: string; rows: { all: Row[]; rising: Row[]; falling: Row[] }; unit: string; href: string; comparable: boolean; pii?: (k: string) => boolean; label?: (k: string) => string; icon?: Icon; info?: string; /** Rows that are pages: the address to open in a new tab, and the copy button copies it. */ open?: (k: string) => string | null } = $props();
	let copied = $state<string | null>(null);
	async function copy(k: string) {
		try {
			await navigator.clipboard.writeText(open?.(k) ?? k);
			copied = k;
			setTimeout(() => (copied = null), 1400);
		} catch {
			toast.error('Could not copy');
		}
	}
	let mode = $state<'all' | 'rising' | 'falling'>('all');
	const shown = $derived(rows[mode]);
	const max = $derived(Math.max(1, ...shown.map((r) => (mode === 'all' ? r.clicks : Math.abs(r.change ?? 0)))));
	const tabs = $derived([['all', 'All'], ...(comparable ? [['rising', 'Rising'], ['falling', 'Falling']] : [])] as [typeof mode, string][]);
</script>

<Panel {title} {href} {icon} {info}>
	{#snippet controls()}
		<div class="seg" role="group" aria-label="{title}: which to show">
			{#each tabs as [id, l]}<button type="button" aria-pressed={mode === id} class="seg-item !py-0.5 !text-xs {mode === id ? 'seg-on' : ''}" onclick={() => (mode = id)}>{l}</button>{/each}
		</div>
	{/snippet}
	{#if shown.length}
		<ul class="space-y-2.5">
			{#each shown as r (r.key)}
				{@const size = mode === 'all' ? r.clicks : Math.abs(r.change ?? 0)}
				{@const url = open?.(r.key) ?? null}
				<li class="group grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3">
					<div class="min-w-0">
						<div class="flex min-w-0 items-center gap-1">
							<span class="truncate text-[13px] {pii(r.key) ? 'pii' : ''}" title={label(r.key)}>{label(r.key)}</span>
							{#if url}
								<span class="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100" data-noexport>
									<a class="tap grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" href={url} target="_blank" rel="noreferrer noopener" aria-label="Open {label(r.key)} in a new tab" title="Open the page"><ExternalLink class="size-3" /></a>
									<button type="button" class="tap grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" onclick={() => copy(r.key)} aria-label="Copy the address of {label(r.key)}" title="Copy the address">{#if copied === r.key}<Check class="size-3 text-good" />{:else}<Copy class="size-3" />{/if}</button>
								</span>
							{/if}
						</div>
						<div class="mt-1 h-1.5 rounded-full bg-muted"><div class="h-full rounded-full {mode === 'falling' ? 'bg-[color:var(--bad)]' : 'bg-[color:var(--c-clicks)]'}" style="width:{Math.max(2, (size / max) * 100)}%"></div></div>
					</div>
					<div class="tnum text-right text-[13px]">
						<div class="font-medium">{fmtCompact(r.clicks)}</div>
						{#if r.change != null}<div class="text-[11px] {r.change > 0 ? 'text-good' : r.change < 0 ? 'text-bad' : 'text-muted-foreground'}">{r.change > 0 ? '+' : r.change < 0 ? '−' : ''}{fmtInt(Math.abs(r.change))}</div>{/if}
					</div>
					<Sparkline values={r.spark} width={72} height={24} color={mode === 'falling' ? 'var(--bad)' : 'var(--c-clicks)'} />
				</li>
			{/each}
		</ul>
		<p class="mt-3 text-[11px] text-muted-foreground">Clicks in the period{comparable ? ', the change against the period before,' : ''} and the daily line. <a class="underline" {href}>All {unit}</a></p>
	{:else}
		<p class="text-sm text-muted-foreground">{mode === 'all' ? 'No data in this period yet.' : mode === 'rising' ? 'Nothing gained clicks against the period before.' : 'Nothing lost clicks against the period before.'}</p>
	{/if}
</Panel>
