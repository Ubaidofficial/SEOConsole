<script lang="ts">
	import ActionCard from '$lib/components/ActionCard.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { CircleCheck, FunnelX, ScanSearch, Plug, ChevronDown, ChevronUp } from '@lucide/svelte';
	import { TYPE_LABEL } from '$lib/explain';
	let { data } = $props();
	let type = $state('all');
	let only = $state<'all' | 'blocking' | 'quick'>('all');
	let showAll = $state(false);
	const types = $derived([...new Set(data.open.map((a) => a.type))]);
	const count = (f: (a: (typeof data.open)[number]) => boolean) => data.open.filter(f).length;
	const rows = $derived(data.open.filter((a) => (type === 'all' || a.type === type) && (only === 'all' || (only === 'blocking' ? a.blocking : a.effort === 'low' && !a.blocking))));
	const shown = $derived(showAll ? rows : rows.slice(0, 10));
	/** Rank of the first card in this list with the same instructions: later ones point to it instead of repeating it. */
	const sameAs = $derived.by(() => {
		const first = new Map<string, number>();
		return shown.map((a, i) => {
			const at = first.get(a.how);
			if (at == null) first.set(a.how, i + 1);
			return at ?? null;
		});
	});
	const blocking = $derived(count((a) => a.blocking));
	const quick = $derived(count((a) => a.effort === 'low' && !a.blocking));
</script>

<PageHeader tab="/actions" title="Actions" lead="Everything found for this site, in the order to do it: blocking items first, then by estimated gain.">
	<p><b>Blocking</b> items stop the site earning or stop you measuring it. The rest are ranked by estimated clicks per 28 days weighted by confidence. The estimates come from this site's own click-through curve and history; they are model figures, not promises, and are <b>not added up</b> because findings overlap (one page can be a CTR gap and a decay at once).</p>
</PageHeader>

{#if data.open.length === 0}
	<EmptyState icon={CircleCheck} tone="green" title="Nothing to do right now." text="Either the site is healthy, or there is not enough data yet. Connect GA4 and Tag Manager, read the sitemaps and run the on-page check to widen what is looked at.">
		<a class="btn btn-primary btn-sm" href="/sites/{data.site.id}/onpage"><ScanSearch class="size-3.5" />Run the on-page check</a>
		<a class="btn btn-sm" href="/connect"><Plug class="size-3.5" />Connect GA4 and Tag Manager</a>
	</EmptyState>
{:else}
	<div class="mb-3 flex flex-wrap items-center gap-1.5">
		<span class="mr-1 text-sm"><b>{data.open.length}</b> open {#if blocking}· <b class="text-bad">{blocking} blocking</b>{/if}</span>
		<button class="chip {only === 'blocking' ? 'chip-on' : ''}" onclick={() => (only = only === 'blocking' ? 'all' : 'blocking')} disabled={!blocking}>Blocking ({blocking})</button>
		<button class="chip {only === 'quick' ? 'chip-on' : ''}" onclick={() => (only = only === 'quick' ? 'all' : 'quick')} disabled={!quick} title="Low-effort items that are not blocking">Quick wins ({quick})</button>
		{#if types.length > 1}
			<label class="ml-1 flex items-center gap-1.5 text-xs text-muted-foreground">Kind
				<select class="input !h-7 !py-0 text-xs" bind:value={type}>
					<option value="all">All kinds ({data.open.length})</option>
					{#each [...types].sort((x, y) => count((a) => a.type === y) - count((a) => a.type === x)) as t}<option value={t}>{TYPE_LABEL[t]} ({count((a) => a.type === t)})</option>{/each}
				</select>
			</label>
		{/if}
	</div>
	{#if rows.length === 0}<EmptyState icon={FunnelX} title="Nothing matches these filters."><button class="btn btn-sm" onclick={() => ((type = 'all'), (only = 'all'))}><FunnelX class="size-3.5" />Clear them</button></EmptyState>{/if}
	<div class="stagger space-y-3">
		{#each shown as a, i (a.key)}<ActionCard {a} rank={i + 1} sameAs={sameAs[i]} />{/each}
	</div>
	{#if rows.length > 10}<button class="btn btn-sm mt-3" onclick={() => (showAll = !showAll)}>{#if showAll}<ChevronUp class="size-3.5" />Show fewer{:else}<ChevronDown class="size-3.5" />Show all {rows.length}{/if}</button>{/if}
{/if}

{#if data.hidden.length}
	<details class="mt-6">
		<summary class="cursor-pointer text-sm font-medium">Done or snoozed ({data.hidden.length})</summary>
		<div class="mt-3 space-y-3">
			{#each data.hidden as a (a.key)}
				<div class="opacity-70"><p class="mb-1 text-xs text-muted-foreground">{a.status === 'done' ? 'Done' : 'Snoozed'}; returns {new Date(a.until).toLocaleDateString()} if still detected</p><ActionCard {a} rank={0} restore /></div>
			{/each}
		</div>
	</details>
{/if}
