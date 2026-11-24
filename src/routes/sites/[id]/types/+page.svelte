<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { FileText, Shapes, Sparkles, RefreshCw } from '@lucide/svelte';
	import AreaSpark from '$lib/components/AreaSpark.svelte';
	import Delta from '$lib/components/Delta.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import { trendOf } from '$lib/trend';
	import { fmtInt, fmtPct, fmtPos } from '$lib/format';
	import { TYPE_HINT, TYPE_LABEL, appearanceLabel } from '$lib/searchTypes';

	let { data } = $props();
	const active = $derived(data.types.filter((t) => t.has));
	const empty = $derived(data.types.filter((t) => !t.has));
	const maxAppearClicks = $derived(Math.max(1, ...data.appearance.rows.map((r) => r.clicks)));
	const pageTypes = $derived(active.filter((t) => t.type !== 'web' && data.typePages.types[t.type]?.rows.length));
</script>

<PageHeader tab="/types" title="Search types" lead="Google reports each kind of search separately; the numbers are not added up.">
	<p>Google reports each kind of search separately. The Clicks, Impressions, CTR and Position cards on Overview are <b>Web</b> only, which is also what Search Console shows by default; the other types add to your reach but are not in those totals.</p>
</PageHeader>

{#if !data.typesPulled}
	<EmptyState icon={RefreshCw} tone="blue" title="Search types are fetched on the next sync of this site." text="Press Sync (top right) to fetch them now." />
{:else}
	<div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
		{#each active as t (t.type)}
			<div class="rounded-2xl border bg-card p-5 shadow-xs">
				<div class="flex items-start justify-between gap-3">
					<div>
						<div class="text-lg font-semibold tracking-tight">{TYPE_LABEL[t.type]}</div>
						<div class="text-xs text-muted-foreground">{TYPE_HINT[t.type]}</div>
					</div>
					<div class="flex flex-col items-end gap-1">
						<span class="tnum rounded-full bg-muted px-3 py-1 text-sm font-medium">{fmtInt(t.clicks)} clicks</span>
						<Delta value={t.clicksDelta} why="Needs 10+ clicks in the previous period" />
					</div>
				</div>
				<AreaSpark values={t.spark} trend={trendOf(t.clicksDelta, t.spark)} class="mt-4" />
				<div class="tnum mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
					<span>Impr. <b class="font-medium text-foreground">{fmtInt(t.impressions)}</b></span>
					<span>CTR <b class="font-medium text-foreground">{fmtPct(t.ctr)}</b></span>
					<span>Pos. <b class="font-medium text-foreground">{fmtPos(t.position)}</b></span>
				</div>
				<div class="mt-3">
					<div class="h-1.5 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-foreground/70" style="width:{Math.max(1, t.share * 100)}%"></div></div>
					<div class="mt-1 text-[11px] text-muted-foreground">{fmtPct(t.share, 0)} of all clicks across search types</div>
				</div>
			</div>
		{/each}
	</div>
	{#if empty.length}
		<p class="mt-4 text-sm text-muted-foreground">
			No traffic in this period from: {empty.map((t) => TYPE_LABEL[t.type]).join(', ')}.
			If you expect Discover, News or Image traffic and it is missing here, check that this property receives it in Search Console itself.
		</p>
	{/if}

	{#if active.some((t) => t.type !== 'web')}
		<h3 class="mt-8 mb-1 flex items-center gap-2 text-base font-semibold"><span class="ibadge ibadge-sm tone-blue" aria-hidden="true"><FileText class="size-3.5" /></span>Pages by search type</h3>
		{#if !data.pageWindows}
			<EmptyState compact icon={Shapes} title="Pages per search type are kept for the 7d, 28d, 3m, 6m and 16m periods." text="Pick one of those periods to see them." />
		{:else if !pageTypes.length}
			<EmptyState compact icon={RefreshCw} title="Which pages earn this traffic is read once a day." text="It appears after the next sync." />
		{:else}
			<p class="mb-3 text-sm text-muted-foreground">The articles behind each type, for the {data.days} days ending {data.typePages.pulledOn}. A Discover rise or drop is usually a few pages: sort by Δ to find them.</p>
			{#each pageTypes as t (t.type)}
				{@const tp = data.typePages.types[t.type]!}
				<h4 class="mt-4 mb-1 text-sm font-medium">{TYPE_LABEL[t.type]}</h4>
				<DataTable
					rows={tp.rows}
					cols={[
						{ key: 'page', label: 'Page', type: 'link', href: (r) => r.page },
						{ key: 'clicks', label: 'Clicks', type: 'int', bar: true },
						...(tp.hasPrev ? [{ key: 'clicksDelta', label: 'Δ clicks', title: 'Against the same number of days just before. Empty for a page with no clicks then.', type: 'delta' as const }, { key: 'prevClicks', label: 'Before', type: 'int' as const }] : []),
						{ key: 'impressions', label: 'Impressions', type: 'int' },
						{ key: 'ctr', label: 'CTR', type: 'pct' },
						...(t.type === 'discover' ? [] : [{ key: 'position', label: 'Position', type: 'pos' as const }])
					]}
					sortKey="clicks"
					pageSize={10}
				/>
			{/each}
		{/if}
	{/if}

	<h3 class="mt-8 mb-1 flex items-center gap-2 text-base font-semibold"><span class="ibadge ibadge-sm tone-blue" aria-hidden="true"><Sparkles class="size-3.5" /></span>Search appearance</h3>
	<p class="mb-3 text-sm text-muted-foreground">
		How results were shown (rich results, snippets and similar), for the {data.appearance.pulledOn ? `${data.days} days ending ${data.appearance.pulledOn}` : 'selected period'}. Google reports this on its own: it cannot be split by query, page or country.
	</p>
	{#if data.appearance.rows.length}
		<div class="card overflow-x-auto">
			<table class="w-full text-sm">
				<thead><tr><th class="th">Appearance</th><th class="th text-right">Clicks</th><th class="th text-right">Impressions</th><th class="th text-right">CTR</th><th class="th text-right">Position</th></tr></thead>
				<tbody>
					{#each data.appearance.rows as r (r.appearance)}
						<tr>
							<td class="td" title={r.appearance}>{appearanceLabel(r.appearance)}</td>
							<td class="td tnum cellbar text-right" style="--w:{r.clicks / maxAppearClicks}">{fmtInt(r.clicks)}</td>
							<td class="td tnum text-right">{fmtInt(r.impressions)}</td>
							<td class="td tnum text-right">{fmtPct(r.impressions ? r.clicks / r.impressions : 0)}</td>
							<td class="td tnum text-right">{fmtPos(r.position)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<EmptyState icon={Sparkles} title="No search-appearance data for this window." text="Google only lists appearances where your pages were shown with a special treatment." />
	{/if}
{/if}
