<script lang="ts">
	/** The plain-text credit for the authority circles, shown once on a page that has any: Ahrefs' Domain Rating License and Moz's terms ask for it. */
	let { dr = false, da = false, class: className = '' }: { dr?: boolean; da?: boolean; class?: string } = $props();
</script>

{#if dr || da}
	<span class={className}>{#if dr}Domain Rating by <a class="underline" href="https://ahrefs.com/" target="_blank" rel="noopener">Ahrefs</a>{/if}{#if dr && da}.&nbsp;{/if}{#if da}Domain Authority by <a class="underline" href="https://moz.com/" target="_blank" rel="noopener">Moz</a>{/if}.</span>
{/if}
