<script lang="ts">
	import { goto } from '$app/navigation';
	import { Check, ChevronDown, Search } from '@lucide/svelte';
	import SiteAvatar from '$lib/components/SiteAvatar.svelte';

	/**
	 * The site's name as a menu (as onsite.so's breadcrumb): open it to jump to another site on the same tab and period. Typing
	 * filters the list; Enter opens the first match; Esc closes. The name itself is the page's h1.
	 */
	let { sites, current, name, hrefFor }: { sites: { id: number; name: string; account: string }[]; current: number; name: string; hrefFor: (id: number) => string } = $props();
	let open = $state(false);
	let q = $state('');
	let box = $state<HTMLDetailsElement>();
	let input = $state<HTMLInputElement>();
	const shown = $derived(q ? sites.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()) || s.account.toLowerCase().includes(q.toLowerCase())) : sites);
	$effect(() => {
		if (open) queueMicrotask(() => input?.focus());
		else q = '';
	});
	function key(e: KeyboardEvent) {
		if (e.key === 'Enter' && shown.length) {
			e.preventDefault();
			open = false;
			goto(hrefFor(shown[0].id));
		}
	}
</script>

<svelte:window onkeydown={(e) => open && e.key === 'Escape' && (open = false)} onclick={(e) => open && box && !box.contains(e.target as Node) && (open = false)} />

<details class="relative min-w-0" bind:open bind:this={box}>
	<summary class="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md px-1 py-0.5 select-none hover:bg-accent [&::-webkit-details-marker]:hidden" aria-label="{name}: switch site">
		<SiteAvatar {name} siteId={current} class="pii !size-6 !rounded-md !text-[11px]" />
		<h1 class="pii truncate text-base font-semibold tracking-tight">{name}</h1>
		{#if sites.length > 1}<ChevronDown class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />{/if}
	</summary>
	{#if sites.length > 1}
		<div class="absolute top-full left-0 z-40 mt-1.5 w-[min(22rem,calc(100vw-2rem))] rounded-xl border bg-card p-1.5 shadow-lg">
			<label class="relative mb-1 block">
				<Search class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
				<input bind:this={input} bind:value={q} onkeydown={key} class="input h-8 w-full pl-8 text-xs" placeholder="Find a site… (Enter opens)" aria-label="Find a site" />
			</label>
			<ul class="max-h-80 overflow-y-auto" role="listbox" aria-label="Sites">
				{#each shown as s (s.id)}
					<li role="option" aria-selected={s.id === current}>
						<a href={hrefFor(s.id)} onclick={() => (open = false)} class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent {s.id === current ? 'bg-accent' : ''}">
							<SiteAvatar name={s.name} siteId={s.id} class="pii !size-5 !rounded !text-[9px]" />
							<span class="min-w-0 flex-1"><span class="pii block truncate text-[13px] font-medium">{s.name}</span><span class="pii block truncate text-[11px] text-muted-foreground">{s.account}</span></span>
							{#if s.id === current}<Check class="size-3.5 text-muted-foreground" aria-hidden="true" />{/if}
						</a>
					</li>
				{:else}
					<li class="px-2 py-3 text-center text-xs text-muted-foreground">No site matches.</li>
				{/each}
			</ul>
		</div>
	{/if}
</details>
