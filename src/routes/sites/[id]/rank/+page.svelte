<script lang="ts">
	import { enhance } from '$app/forms';
	import { X } from '@lucide/svelte';
	import RankSpark from '$lib/components/RankSpark.svelte';
	import Explainer from '$lib/components/Explainer.svelte';
	import { isBranded } from '$lib/analytics';
	import { fmtInt } from '$lib/format';
	let { data } = $props();
	let sort = $state<'latest' | 'change' | 'clicks' | 'query'>('latest');
	const rows = $derived(
		[...data.rows].sort((a, b) =>
			sort === 'query' ? a.query.localeCompare(b.query)
			: sort === 'clicks' ? b.clicks - a.clicks
			: sort === 'change' ? (a.change ?? 0) - (b.change ?? 0)
			: (a.latest?.position ?? 999) - (b.latest?.position ?? 999)
		)
	);
	const pos = (p: number | null | undefined) => (p == null ? '–' : p.toFixed(1));
	const top10 = $derived(data.rows.filter((r) => r.week != null && r.week <= 10.5).length);
</script>

<div class="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
	<h2 class="text-base font-semibold">Rank tracking</h2>
	<span class="text-xs text-muted-foreground">{data.rows.filter((r) => r.manual).length} of {data.max.total} searches{#if data.rows.some((r) => !r.manual)} + {data.rows.filter((r) => !r.manual).length} from buckets{/if} · {top10} on page one this week · {data.start} → {data.end}</span>
	{#if data.rows.length}
		<label class="ml-auto text-xs text-muted-foreground">Sort <select class="input" bind:value={sort}><option value="latest">Position</option><option value="change">Biggest fall</option><option value="clicks">Clicks</option><option value="query">A–Z</option></select></label>
	{/if}
</div>

<Explainer lead="Daily Google position of the searches you choose, from your own Search Console data. No credits, no scraping.">
	<p>Each day's position is Search Console's average for that search across every country and device, weighted by impressions. A day without an impression has no position (a gap in the line) rather than a guess. Results-page trackers check one place and one device; this shows what searchers actually saw, a few days late, as Search Console is.</p>
	<p>The dashed line is position 10, the end of page one. “This week” is the last 7 days against the 7 before. The built-in “Tracked searches falling” alert watches these.</p>
</Explainer>

{#if rows.length}
	<div class="overflow-x-auto rounded-xl border bg-card" style="border-color:var(--border)">
		<table class="w-full text-sm">
			<thead class="text-left text-xs text-muted-foreground">
				<tr class="border-b" style="border-color:var(--border)">
					<th class="px-3 py-2 font-medium">Search</th>
					<th class="px-3 py-2 text-right font-medium" title="The newest day with an impression">Latest</th>
					<th class="px-3 py-2 text-right font-medium" title="Average over the last 7 days">This week</th>
					<th class="px-3 py-2 text-right font-medium" title="Places moved against the 7 days before; + is up">Change</th>
					<th class="px-3 py-2 text-right font-medium" title="Best daily position in the period">Best</th>
					<th class="px-3 py-2 font-medium">Daily position</th>
					<th class="px-3 py-2 text-right font-medium">Clicks</th>
					<th class="px-3 py-2 text-right font-medium" title="Days in the top 10 out of days shown">Top 10</th>
					<th class="relative px-3 py-2"><span class="sr-only">Remove</span></th>
				</tr>
			</thead>
			<tbody>
				{#each rows as r (r.query)}
					<tr class="border-b last:border-0" style="border-color:var(--border)">
						<td class="max-w-72 truncate px-3 py-2"><a class="hover:underline {isBranded(r.query, data.brandTerms) ? 'pii' : ''}" href="queries?re={encodeURIComponent('^' + r.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')}">{r.query}</a>{#if r.buckets.length}<span class="ml-1.5 text-[11px] text-muted-foreground" title="Followed because it is one of the 8 biggest searches of this keyword bucket">· {r.buckets.join(', ')}</span>{/if}</td>
						<td class="tnum px-3 py-2 text-right font-medium" title={r.latest ? `on ${r.latest.date}` : 'No impression in the stored days'}>{pos(r.latest?.position)}</td>
						<td class="tnum px-3 py-2 text-right">{pos(r.week)}</td>
						<td class="tnum px-3 py-2 text-right {r.change == null ? 'text-muted-foreground' : r.change >= 0.5 ? 'text-good' : r.change <= -0.5 ? 'text-bad' : 'text-muted-foreground'}">{r.change == null ? '–' : (r.change > 0 ? '+' : '') + r.change.toFixed(1)}</td>
						<td class="tnum px-3 py-2 text-right">{pos(r.best)}</td>
						<td class="px-3 py-1"><RankSpark values={r.series} /></td>
						<td class="tnum px-3 py-2 text-right">{fmtInt(r.clicks)}</td>
						<td class="tnum px-3 py-2 text-right text-muted-foreground">{r.daysTop10}/{r.daysShown}</td>
						<td class="px-2 py-2">{#if r.manual}<form method="POST" action="?/remove" use:enhance><input type="hidden" name="query" value={r.query} /><button class="text-muted-foreground hover:text-foreground" aria-label="Stop tracking this search" title="Stop tracking"><X class="size-3.5" /></button></form>{/if}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else}
	<p class="rounded-xl border bg-card px-4 py-6 text-center text-sm text-muted-foreground" style="border-color:var(--border)">No searches tracked yet. Add some below, or pick from the suggestions.</p>
{/if}

<div class="mt-5 grid gap-4 lg:grid-cols-2">
	<form method="POST" action="?/add" use:enhance class="card p-4">
		<label class="text-sm font-medium" for="rank-add">Track searches</label>
		<p class="mb-2 text-xs text-muted-foreground">One per line, up to {data.max.atOnce} at a time. Written as people search; case does not matter.</p>
		<textarea id="rank-add" name="queries" rows="5" class="input w-full font-mono text-xs" placeholder={'running shoes\nbest trail running shoes'}></textarea>
		<button class="btn btn-primary mt-2">Track</button>
	</form>
	{#if data.suggestions.length}
		<form method="POST" action="?/add" use:enhance class="card p-4">
			<div class="text-sm font-medium">Suggestions</div>
			<p class="mb-2 text-xs text-muted-foreground">Your biggest searches on page one or two in the last 28 days, not tracked yet.</p>
			<ul class="max-h-56 space-y-1 overflow-y-auto text-sm">
				{#each data.suggestions as s}
					<li><label class="flex items-center gap-2"><input type="checkbox" name="query" value={s.query} /><span class="min-w-0 flex-1 truncate {isBranded(s.query, data.brandTerms) ? 'pii' : ''}">{s.query}</span><span class="tnum text-xs text-muted-foreground">pos {s.position.toFixed(1)} · {fmtInt(s.impressions)} impr.</span></label></li>
				{/each}
			</ul>
			<button class="btn mt-2">Track the ticked ones</button>
		</form>
	{/if}
</div>
