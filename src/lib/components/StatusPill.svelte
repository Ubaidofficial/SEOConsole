<script lang="ts">
	import type { Snippet } from 'svelte';
	/** A word with a coloured dot (good, warn, bad, info, muted). The word carries the meaning; the colour only helps it stand out. */
	let { tone = 'muted', pulse = false, title = undefined, children }: { tone?: 'good' | 'warn' | 'bad' | 'info' | 'muted'; pulse?: boolean; title?: string; children: Snippet } = $props();
</script>

<span class="pill pill-{tone}" {title}><span class="size-1.5 rounded-full {pulse ? 'animate-pulse' : ''}" style="background:currentColor" aria-hidden="true"></span>{@render children()}</span>
