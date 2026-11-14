<script lang="ts">
	import { BANDS_TEXT, BAND_COLOR, BAND_NAME, authorityBand } from '$lib/authority';
	/**
	 * Ahrefs Domain Rating (DR) and Moz Domain Authority (DA) as two small circles next to a site's name: a ring filled to the score
	 * and the number inside, coloured red, orange or green by score (see $lib/authority: the bands are this app's own). Each circle links to its provider and names it in its tooltip and label. The written credit the providers'
	 * terms ask for ("Domain Rating by Ahrefs", "Domain Authority by Moz") is shown in plain text once on each page that has a circle
	 * (see AuthorityCredit), not repeated on every card. Nothing is drawn until a value exists.
	 */
	type Badge = { value: number; date: string | null } | null;
	let { authority, class: className = '' }: { authority: { dr: Badge; da: Badge }; class?: string } = $props();
	const items = $derived(
		[
			{ key: 'dr', label: 'DR', credit: 'Domain Rating by Ahrefs', href: 'https://ahrefs.com/', b: authority.dr },
			{ key: 'da', label: 'DA', credit: 'Domain Authority by Moz', href: 'https://moz.com/', b: authority.da }
		]
			.filter((i) => i.b)
			.map((i) => {
				// The colour follows the number people read (rounded), so a 59.8 shown as "60" is not orange under a "green 60 or more" legend.
				const shown = Math.round(i.b!.value);
				const band = authorityBand(shown);
				return { ...i, shown, band, color: BAND_COLOR[band], name: BAND_NAME[band] };
			})
	);
</script>

{#if items.length}
	<span class="inline-flex shrink-0 items-center gap-1.5 {className}">
		{#each items as i (i.key)}
			<a
				href={i.href}
				target="_blank"
				rel="noopener"
				class="relative z-10 grid size-10 place-items-center rounded-full"
				style="background: conic-gradient({i.color} {Math.min(100, Math.max(0, i.b!.value))}%, color-mix(in oklab, {i.color} 22%, var(--border)) 0)"
				title="{i.credit}: {i.shown} of 100, {i.name} ({BANDS_TEXT}){i.b!.date ? `, as of ${i.b!.date}` : ''}"
				aria-label="{i.credit}: {i.shown} of 100, {i.name}"
			>
				<span class="grid size-[34px] place-items-center rounded-full bg-card leading-none">
					<span class="text-[8px] font-semibold tracking-wide" style="color: {i.color}">{i.label}</span>
					<span class="tnum -mt-1 text-[14px] font-semibold text-foreground">{i.shown}</span>
				</span>
			</a>
		{/each}
	</span>
{/if}
