<script lang="ts">
	/**
	 * Ahrefs Domain Rating (DR) and Moz Domain Authority (DA) as two small circles next to a site's name: a ring filled to the score
	 * and the number inside. Each circle links to its provider and names it in its tooltip and label. The written credit the providers'
	 * terms ask for ("Domain Rating by Ahrefs", "Domain Authority by Moz") is shown in plain text once on each page that has a circle
	 * (see AuthorityCredit), not repeated on every card. Nothing is drawn until a value exists.
	 */
	type Badge = { value: number; date: string | null } | null;
	let { authority, class: className = '' }: { authority: { dr: Badge; da: Badge }; class?: string } = $props();
	const items = $derived(
		[
			{ key: 'dr', label: 'DR', credit: 'Domain Rating by Ahrefs', href: 'https://ahrefs.com/', b: authority.dr },
			{ key: 'da', label: 'DA', credit: 'Domain Authority by Moz', href: 'https://moz.com/', b: authority.da }
		].filter((i) => i.b)
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
				style="background: conic-gradient(var(--primary) {Math.min(100, Math.max(0, i.b!.value))}%, var(--border) 0)"
				title="{i.credit}: {i.b!.value} of 100{i.b!.date ? `, as of ${i.b!.date}` : ''}"
				aria-label="{i.credit}: {i.b!.value} of 100"
			>
				<span class="grid size-[34px] place-items-center rounded-full bg-card leading-none">
					<span class="text-[8px] font-semibold tracking-wide text-muted-foreground">{i.label}</span>
					<span class="tnum -mt-1 text-[14px] font-semibold text-foreground">{Math.round(i.b!.value)}</span>
				</span>
			</a>
		{/each}
	</span>
{/if}
