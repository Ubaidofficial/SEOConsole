<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ImageDown, LoaderCircle, Maximize2, Minimize2 } from '@lucide/svelte';
	import InfoTip from '$lib/components/InfoTip.svelte';
	import type { Icon } from '$lib/icons';

	/**
	 * A report panel with the same header everywhere (as onsite.so's): its icon, its title (a link to the full report when there is
	 * one), an ⓘ with what it shows, a short count, the panel's own switches, and two tools: save the panel as a PNG and open it full
	 * screen (Esc closes). The image is drawn in the browser from the panel itself (html-to-image); nothing is sent anywhere.
	 * Privacy mode: the blurred names stay blurred in the image, because the image is taken from what is on screen.
	 */
	let {
		title,
		href = undefined,
		icon = undefined,
		tone = 'blue',
		info = '',
		meta = '',
		id = undefined,
		class: className = '',
		controls,
		children
	}: {
		title: string;
		href?: string;
		icon?: Icon;
		tone?: string;
		info?: string;
		meta?: string;
		id?: string;
		class?: string;
		controls?: Snippet;
		children: Snippet;
	} = $props();

	let el = $state<HTMLElement>();
	let big = $state(false);
	let saving = $state(false);
	const Glyph = $derived(icon);
	const file = $derived(title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'panel');

	async function save() {
		if (!el || saving) return;
		saving = true;
		try {
			const { toPng } = await import('html-to-image');
			const bg = getComputedStyle(el).backgroundColor || '#ffffff';
			const url = await toPng(el, { pixelRatio: 2, backgroundColor: bg, filter: (n) => !(n instanceof HTMLElement && n.dataset.noexport != null) });
			Object.assign(document.createElement('a'), { href: url, download: `${file}.png` }).click();
		} catch {
			/* the browser could not draw it (an unusual font or image): nothing to undo */
		} finally {
			saving = false;
		}
	}
</script>

<svelte:window onkeydown={(e) => big && e.key === 'Escape' && (big = false)} />
{#if big}<div class="fixed inset-0 z-40 bg-background/70 backdrop-blur-sm" aria-hidden="true" onclick={() => (big = false)}></div>{/if}
<section
	bind:this={el}
	{id}
	aria-labelledby={id ? `${id}-h` : undefined}
	class="rounded-2xl border bg-card p-5 shadow-xs {big ? 'fixed inset-3 z-50 overflow-auto sm:inset-8' : className}"
	role={big ? 'dialog' : undefined}
	aria-modal={big ? 'true' : undefined}
>
	<div class="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
		{#if Glyph}<span class="ibadge ibadge-sm tone-{tone}" aria-hidden="true"><Glyph class="size-3.5" /></span>{/if}
		<h2 id={id ? `${id}-h` : undefined} class="text-base font-semibold tracking-tight">{#if href}<a class="hover:underline" {href}>{title}</a>{:else}{title}{/if}</h2>
		{#if meta}<span class="tnum text-xs text-muted-foreground">{meta}</span>{/if}
		{#if info}<span data-noexport><InfoTip text={info} label={title} /></span>{/if}
		<div class="ml-auto flex items-center gap-1.5">
			{#if controls}{@render controls()}{/if}
			<span class="flex items-center" data-noexport>
				<button type="button" class="btn btn-ghost btn-xs !px-1.5" onclick={save} disabled={saving} title="Save as image (PNG)" aria-label="Save {title} as an image">{#if saving}<LoaderCircle class="size-3.5 animate-spin" />{:else}<ImageDown class="size-3.5" />{/if}</button>
				<button type="button" class="btn btn-ghost btn-xs !px-1.5" onclick={() => (big = !big)} title={big ? 'Close (Esc)' : 'Open full screen'} aria-label={big ? `Close ${title}` : `Open ${title} full screen`}>{#if big}<Minimize2 class="size-3.5" />{:else}<Maximize2 class="size-3.5" />{/if}</button>
			</span>
		</div>
	</div>
	{@render children()}
</section>
