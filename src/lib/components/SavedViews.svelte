<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { Bookmark, X } from '@lucide/svelte';
	/** The tab's saved views as chips, and a form to save the current filters. Views are shared with the whole team; the period is not saved. */
	let { views, canSave }: { views: { id: number; name: string; params: string; createdBy: string | null }[]; canSave: boolean } = $props();
	let naming = $state(false);
	const days = $derived(page.url.searchParams.get('days'));
	const hrefOf = (params: string) => `?${days ? `days=${days}&` : ''}${params}`;
	const current = $derived.by(() => {
		const u = new URLSearchParams(page.url.search);
		u.delete('days');
		return u.toString();
	});
</script>

{#if views.length || canSave}
	<div class="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
		<Bookmark class="size-3.5 text-muted-foreground" aria-hidden="true" />
		{#each views as v (v.id)}
			<span class="chip inline-flex items-center gap-1 {current === v.params ? 'chip-on' : ''}">
				<a href={hrefOf(v.params)} title={v.createdBy ? `Saved by ${v.createdBy}` : undefined}>{v.name}</a>
				{#if canSave}<form method="POST" action="?/deleteView" use:enhance class="inline-flex"><input type="hidden" name="id" value={v.id} /><button class="text-muted-foreground hover:text-foreground" aria-label="Remove the view {v.name}"><X class="size-3" /></button></form>{/if}
			</span>
		{/each}
		{#if !views.length}<span class="text-muted-foreground">No saved views.</span>{/if}
		{#if canSave && current}
			{#if naming}
				<form method="POST" action="?/saveView" use:enhance={() => async ({ update }) => { await update(); naming = false; }} class="inline-flex items-center gap-1">
					<input type="hidden" name="params" value={current} />
					<!-- svelte-ignore a11y_autofocus -->
					<input class="input h-7 w-40 text-xs" name="name" maxlength="60" placeholder="Name this view" aria-label="Name of the view" required autofocus />
					<button class="btn btn-sm">Save</button>
					<button type="button" class="btn btn-sm text-muted-foreground" onclick={() => (naming = false)}>Cancel</button>
				</form>
			{:else}
				<button class="btn btn-sm" onclick={() => (naming = true)} title="Save these filters for the whole team">Save view</button>
			{/if}
		{/if}
	</div>
{/if}
