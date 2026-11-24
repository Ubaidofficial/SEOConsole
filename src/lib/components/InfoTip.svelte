<script lang="ts">
	import { Info } from '@lucide/svelte';
	import { Tip } from '$lib/components/ui/tooltip';
	/** A small ⓘ that shows `text` on hover and on keyboard focus: a definition or a caveat that would otherwise be a paragraph. */
	let { text, label = 'More about this', class: className = '' }: { text: string; label?: string; class?: string } = $props();
</script>

<Tip {text}><span role="img" aria-label="{label}: {text}" class="inline-grid size-4 place-items-center text-muted-foreground hover:text-foreground {className}"><Info class="size-3.5" aria-hidden="true" /></span></Tip>
