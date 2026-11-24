<script lang="ts">
	/**
	 * A small switcher that shows one section of a page at a time instead of stacking every table. The choice is kept in the address
	 * (?section=…, shallow: no reload), so a link or a refresh opens the same section.
	 */
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	type Tab = { id: string; label: string; count?: number | null };
	let { tabs, value = $bindable(''), param = 'section', label = 'Sections' }: { tabs: Tab[]; value?: string; param?: string; label?: string } = $props();
	$effect.pre(() => {
		if (!tabs.some((t) => t.id === value)) {
			const fromUrl = page.url.searchParams.get(param);
			value = tabs.find((t) => t.id === fromUrl)?.id ?? tabs[0]?.id ?? '';
		}
	});
	function pick(id: string) {
		value = id;
		const u = new URL(page.url);
		u.searchParams.set(param, id);
		try {
			replaceState(u, page.state);
		} catch {
			/* before the router is ready: the choice still applies, only the address is not updated */
		}
	}
</script>

<div class="seg mb-3" role="group" aria-label={label}>
	{#each tabs as t (t.id)}
		<button type="button" aria-pressed={value === t.id} class="seg-item {value === t.id ? 'seg-on' : ''}" onclick={() => pick(t.id)}>{t.label}{#if t.count != null}<span class="tnum ml-1.5 text-xs text-muted-foreground">{t.count}</span>{/if}</button>
	{/each}
</div>
