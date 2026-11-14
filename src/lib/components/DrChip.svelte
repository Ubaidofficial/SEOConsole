<script lang="ts">
	/**
	 * Ahrefs Domain Rating next to a site's name. Ahrefs' Domain Rating License requires the credit "Domain Rating by Ahrefs" beside the
	 * number, with Ahrefs linked to https://ahrefs.com/, never hidden: so the credit is part of the chip. Nothing is drawn until a value exists.
	 */
	let { dr, class: className = '' }: { dr: { dr: number; date: string | null } | null; class?: string } = $props();
</script>

{#if dr}
	<span class="chip tnum !px-1.5 !py-0 text-[10px] {className}" title="Domain Rating by Ahrefs: {dr.dr} of 100{dr.date ? `, as of ${dr.date}` : ''}"><abbr title="Domain Rating" class="no-underline">DR</abbr>&nbsp;{dr.dr} <span class="ml-0.5 opacity-70">by <a class="underline" href="https://ahrefs.com/" target="_blank" rel="noopener">Ahrefs</a></span></span>
{/if}
