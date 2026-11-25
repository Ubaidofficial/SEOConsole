<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { FileText } from '@lucide/svelte';
	import { fmtInt } from '$lib/format';
	let { data } = $props();
	const b = $derived(data.brief);
	const verdictLabel = { create: 'Create a new page', optimize: 'Optimise the page that ranks', consolidate: 'Consolidate into one page', rework: 'Rework this page' } as const;
	const copyText = $derived(
		b
			? [`Content brief: ${b.query}`, `Verdict: ${verdictLabel[b.verdict]}${b.targetPage ? ` (${b.targetPage})` : ''}`, b.why, '', `H1: ${b.outline.h1}`, ...b.outline.sections.map((s) => `H2: ${s}`), ...(b.outline.faq.length ? ['', 'FAQ:', ...b.outline.faq.map((f) => `- ${f}`)] : []), ...(b.linkFrom.length ? ['', 'Link from:', ...b.linkFrom.map((l) => `- ${l.page}`)] : [])].join('\n')
			: ''
	);
	let copied = $state(false);
</script>

<PageHeader tab="/brief" title="Content brief" icon={FileText} lead="What to write or rewrite for one search, from your own Search Console data. No credits.">
	<p>The verdict says whether a page of yours already ranks for the search (optimise it), several split it (consolidate), or none does (create one). The searches to cover share the target's main words; it is word overlap, not meaning.</p>
</PageHeader>

<form method="GET" class="mb-4 flex flex-wrap gap-2">
	<input class="input pii min-w-0 flex-1" name="q" value={data.q} placeholder="A search, e.g. remote jobs over 100k" aria-label="Search to brief" required />
	<button class="btn btn-primary">Make the brief</button>
</form>

{#if !b}
	<EmptyState icon={FileText} tone="blue" title="Name a search." text="Or open one on the Queries tab and press Content brief." />
{:else}
	<section class="card mb-4 p-4">
		<div class="flex flex-wrap items-center gap-2">
			<h2 class="pii text-lg font-semibold">{b.query}</h2>
			<span class="chip">{verdictLabel[b.verdict]}</span>
			{#if b.branded}<span class="chip">brand search</span>{/if}
			<button class="btn btn-sm ml-auto" onclick={async () => { try { await navigator.clipboard.writeText(copyText); copied = true; setTimeout(() => (copied = false), 1500); } catch { /* clipboard refused */ } }}>{copied ? 'Copied' : 'Copy brief'}</button>
		</div>
		<p class="pii mt-2 text-sm">{b.why}</p>
		<p class="mt-2 text-xs text-muted-foreground">Last 90 days to {b.window.end}: {fmtInt(b.stats.clicks)} clicks, {fmtInt(b.stats.impressions)} impressions{b.stats.position != null ? `, position ${b.stats.position}` : ''}{b.volume?.searchesPerMonth != null ? ` · about ${fmtInt(b.volume.searchesPerMonth)} searches a month` : ''}{b.volume?.difficulty != null ? `, difficulty ${b.volume.difficulty}` : ''}</p>
		{#if b.current}<p class="pii mt-1 text-xs text-muted-foreground">Now: title “{b.current.title ?? '–'}”, H1 “{b.current.h1 ?? '–'}”</p>{/if}
	</section>

	<div class="grid gap-4 md:grid-cols-2">
		<section class="card p-4">
			<h3 class="mb-2 font-medium">Outline</h3>
			<p class="pii text-sm"><b>H1</b> {b.outline.h1}</p>
			<ul class="pii mt-1 space-y-1 text-sm">{#each b.outline.sections as s}<li><b class="text-muted-foreground">H2</b> {s}</li>{/each}</ul>
			{#if b.outline.faq.length}<p class="mt-3 text-sm font-medium">FAQ</p><ul class="pii list-disc pl-5 text-sm">{#each b.outline.faq as f}<li>{f}</li>{/each}</ul>{/if}
		</section>
		<section class="card p-4">
			<h3 class="mb-2 font-medium">Searches to cover</h3>
			{#if b.related.length}
				<table class="w-full text-sm"><thead><tr><th class="th">Search</th><th class="th text-right">Impr.</th><th class="th text-right">Pos.</th></tr></thead>
					<tbody>{#each b.related.slice(0, 12) as r}<tr><td class="td pii">{r.query}</td><td class="td text-right tabular-nums">{fmtInt(r.impressions)}</td><td class="td text-right tabular-nums">{r.position}</td></tr>{/each}</tbody></table>
			{:else}<p class="text-sm text-muted-foreground">No related searches with enough impressions yet.</p>{/if}
		</section>
		{#if b.pagesRanking.length}
			<section class="card p-4">
				<h3 class="mb-2 font-medium">Your pages shown for it</h3>
				<ul class="pii space-y-1 text-sm">{#each b.pagesRanking.slice(0, 6) as p}<li class="flex gap-2"><span class="min-w-0 flex-1 truncate">{p.page}</span><span class="tabular-nums text-muted-foreground">pos {p.position} · {fmtInt(p.impressions)} impr.</span></li>{/each}</ul>
			</section>
		{/if}
		<section class="card p-4">
			<h3 class="mb-2 font-medium">Link to it from</h3>
			{#if b.linkFrom.length}<ul class="pii space-y-2 text-sm">{#each b.linkFrom as l}<li><span class="block truncate font-medium">{l.page}</span><span class="text-xs text-muted-foreground">“{l.sentence}”</span></li>{/each}</ul>
			{:else}<p class="text-sm text-muted-foreground">No crawled page mentions it yet.</p>{/if}
		</section>
	</div>
	{#if b.notes.length}<ul class="mt-4 space-y-1 text-xs text-muted-foreground">{#each b.notes as n}<li>• {n}</li>{/each}</ul>{/if}
{/if}
