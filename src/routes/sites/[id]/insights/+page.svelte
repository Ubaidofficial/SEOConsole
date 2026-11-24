<script lang="ts">
	import { page } from '$app/state';
	import { Bookmark } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import StatusPill from '$lib/components/StatusPill.svelte';
	import { SITE_PRIMARY_TABS, SITE_SOURCE_TABS, SITE_TABS, SITE_TAB_GROUPS } from '$lib/explain';
	import { TAB_ICON, TAB_TONE } from '$lib/icons';
	import { fmtCompact } from '$lib/format';

	let { data } = $props();
	const base = $derived(`/sites/${page.params.id}`);
	const days = $derived(page.url.searchParams.get('days') ?? '28');
	/** One line each, short enough for a card (the tab's longer description is its hover text). */
	const SHORT: Record<string, string> = {
		'/quickwins': 'The easiest edits first',
		'/opportunities': 'Searches close to the top, and clicks your titles leave behind',
		'/cannibalization': 'Pages splitting one search',
		'/decay': 'Pages losing clicks over time',
		'/diagnose': 'Why clicks changed, checked in order',
		'/health': 'What you publish, what wins, and broken links',
		'/research': 'Results pages, competitors and backlinks (OpenSEO)',
		'/onpage': 'Titles, descriptions and headings against the searches',
		'/links': 'Internal links to add, with the anchor text',
		'/vitals': 'Speed and stability for real visitors',
		'/tests': 'Did a change work? Before/after against control pages',
		'/trends': 'Searches and pages moving more than noise',
		'/groups': 'Your keyword buckets and page groups',
		'/segments': 'Clicks by device and country',
		'/types': 'Web, image, video, news and Discover',
		'/submit': 'Send new or changed pages to search engines',
		'/request': "Today's short list for Google's Request Indexing",
		'/indexnow': 'Tell Bing and others the moment a page changes',
		'/sitemaps': 'Your sitemaps, as Google reads them',
		'/inspect': "Google's index status for any URL"
	};
	const ROW = new Set<string>([...(SITE_PRIMARY_TABS as readonly string[]), ...(SITE_SOURCE_TABS as readonly string[]), '/settings', '/insights']);
	const sections = $derived(SITE_TAB_GROUPS.map(([caption, paths]) => [caption, (paths as readonly string[]).filter((t) => !ROW.has(t))] as const).filter(([, paths]) => paths.length));
	const labelOf = (t: string) => SITE_TABS.find(([p]) => p === t)?.[1] ?? t;
	const aboutOf = (t: string) => SITE_TABS.find(([p]) => p === t)?.[2] ?? '';
	/** The card's big number and the line under it. */
	function headline(t: string): [string, string] {
		const c = data.byTab[t];
		const what = t === '/quickwins' ? 'low-effort finding' : 'finding';
		if (c?.best) return [`≈ +${fmtCompact(Math.round(c.best))}`, `est. clicks / 28d from the biggest of ${c.findings} ${what}${c.findings === 1 ? '' : 's'}`];
		if (c?.findings) return [String(c.findings), `open ${what}${c.findings === 1 ? '' : 's'}`];
		if (t === '/tests') return [String(data.extra.tests), data.extra.tests === 1 ? 'test' : 'tests'];
		if (t === '/groups') return [String(data.extra.buckets + data.extra.pageGroups), `${data.extra.buckets} bucket${data.extra.buckets === 1 ? '' : 's'} · ${data.extra.pageGroups} page group${data.extra.pageGroups === 1 ? '' : 's'}`];
		return ['', 'Nothing flagged right now'];
	}
	const total = $derived(Object.entries(data.byTab).reduce((a, [t, c]) => (t === '/quickwins' ? a : a + c.findings), 0));
</script>

<PageHeader tab="/insights" title="Insights" lead="Every report for this site on one page, each with its headline number. Numbers come from the open findings on the Actions tab.">
	{#snippet meta()}<span class="text-xs text-muted-foreground">{total} open finding{total === 1 ? '' : 's'}</span>{/snippet}
	<p>A card's big number is the largest click estimate of any one finding on that report, not a sum: findings overlap (one search can sit in two of them), so adding them up would overstate. A report with nothing flagged can still be worth opening; the card then says so.</p>
</PageHeader>

{#if data.views.length}
	<h3 class="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Saved</h3>
	<div class="card mb-6 divide-y" style="border-color:var(--border)">
		{#each data.views as v (v.id)}
			<a class="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50" href="{base}{v.tab}?{v.params}&days={days}">
				<span class="ibadge ibadge-sm tone-blue" aria-hidden="true"><Bookmark class="size-3.5" /></span>
				<span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">{v.name}</span><span class="block text-xs text-muted-foreground">{labelOf(v.tab)} · saved {new Date(v.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span></span>
			</a>
		{/each}
	</div>
{/if}

{#each sections as [caption, paths]}
	<h3 class="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{caption}</h3>
	<div class="stagger mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
		{#each paths as t}
			{@const Icon = TAB_ICON[t]}
			{@const [big, line] = headline(t)}
			{@const c = data.byTab[t]}
			<a href="{base}{t}?days={days}" title={aboutOf(t)} class="card group flex min-h-40 flex-col p-4 transition-colors hover:border-foreground/25 hover:bg-accent/30">
				<div class="flex items-center gap-2.5">
					{#if Icon}<span class="ibadge tone-{TAB_TONE[caption]}" aria-hidden="true"><Icon class="size-4" /></span>{/if}
					<span class="font-medium">{labelOf(t)}</span>
					{#if c?.blocking}<span class="ml-auto"><StatusPill tone="bad">{c.blocking} blocking</StatusPill></span>{/if}
				</div>
				<p class="mt-1.5 text-[13px] text-muted-foreground">{SHORT[t] ?? ''}</p>
				<div class="mt-auto pt-4">
					{#if big}<div class="tnum text-2xl font-semibold tracking-tight">{big}</div>{/if}
					<div class="text-xs text-muted-foreground">{line}</div>
				</div>
			</a>
		{/each}
	</div>
{/each}
