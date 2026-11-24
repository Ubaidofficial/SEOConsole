<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Inbox } from '@lucide/svelte';
	import type { Icon } from '$lib/icons';
	/**
	 * What a section shows when it has nothing yet, or its source is not connected: an icon, one line saying why, one line on what
	 * to do, and the button that does it. `compact` is the in-table version (no card, less padding).
	 */
	let { icon = Inbox, title, text = '', tone = 'gray', compact = false, children }: { icon?: Icon; title: string; text?: string; tone?: string; compact?: boolean; children?: Snippet } = $props();
	const Glyph = $derived(icon);
</script>

<div class="flex flex-col items-center justify-center gap-2 text-center {compact ? 'px-4 py-6' : 'card px-6 py-10'}">
	<span class="ibadge ibadge-lg tone-{tone}" aria-hidden="true"><Glyph class="size-5" /></span>
	<div class="text-sm font-medium">{title}</div>
	{#if text}<div class="max-w-md text-xs text-muted-foreground">{text}</div>{/if}
	{#if children}<div class="mt-1 flex flex-wrap items-center justify-center gap-2">{@render children()}</div>{/if}
</div>
