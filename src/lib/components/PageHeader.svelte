<script lang="ts">
	import type { Snippet } from 'svelte';
	import { BookOpen } from '@lucide/svelte';
	import { SITE_TAB_GROUPS } from '$lib/explain';
	import { PAGE_ICON, TAB_ICON, TAB_TONE, type Icon } from '$lib/icons';

	/**
	 * The one header every page opens with: its icon on a tinted badge, the title, one short line on what the page is for, and the
	 * page's buttons on the right (the main one filled, the rest outlined or icon-only). The longer explanation stays one click away
	 * under "How this works", folded like the Explainer, so the data is the first thing anyone sees.
	 *
	 * `tab` is a site tab path ('' is Overview, '/queries'…) and `page` a top-level path ('/alerts'…): either picks the icon and
	 * colour, so a tab, its header and the More menu always agree. `icon` and `tone` override them.
	 */
	let {
		title,
		lead = '',
		tab = undefined,
		page = undefined,
		icon = undefined,
		tone = undefined,
		level = 2,
		label = 'How this works',
		actions,
		meta,
		children
	}: {
		title: string;
		lead?: string;
		tab?: string;
		page?: string;
		icon?: Icon;
		tone?: string;
		level?: 1 | 2;
		label?: string;
		actions?: Snippet;
		meta?: Snippet;
		children?: Snippet;
	} = $props();

	const group = $derived(tab == null ? null : (SITE_TAB_GROUPS.find(([, paths]) => (paths as readonly string[]).includes(tab))?.[0] ?? null));
	const Glyph = $derived(icon ?? (tab != null ? TAB_ICON[tab] : page != null ? PAGE_ICON[page] : undefined));
	const hue = $derived(tone ?? (group ? TAB_TONE[group] : 'blue'));
	let open = $state(false);
</script>

<div class="mb-4">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		{#if Glyph}<span class="ibadge tone-{hue}" aria-hidden="true"><Glyph class="size-4" /></span>{/if}
		<div class="min-w-0 flex-1 basis-64">
			<div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
				<svelte:element this={level === 1 ? 'h1' : 'h2'} class="font-semibold tracking-tight {level === 1 ? 'text-lg' : 'text-base'}">{title}</svelte:element>
				{#if meta}{@render meta()}{/if}
			</div>
			{#if lead}<p class="text-xs text-muted-foreground">{lead}</p>{/if}
		</div>
		{#if children || actions}
			<div class="flex flex-wrap items-center gap-2">
				{#if children}<button type="button" class="btn btn-ghost btn-sm" aria-expanded={open} onclick={() => (open = !open)} title={label}><BookOpen class="size-3.5" aria-hidden="true" /><span class="hidden sm:inline">{label}</span></button>{/if}
				{#if actions}{@render actions()}{/if}
			</div>
		{/if}
	</div>
	{#if children}
		<details bind:open class="[&>summary]:hidden"><summary>{label}</summary><div class="mt-2 max-w-3xl space-y-1.5 rounded-lg border border-dashed bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">{@render children()}</div></details>
	{/if}
</div>
