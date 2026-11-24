<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import { fmtInt, fmtSigned } from '$lib/format';
	import { isBranded } from '$lib/analytics';
	import { page } from '$app/state';
	import { enhance } from '$app/forms';
	import RuleGroupEditor from '$lib/components/RuleGroupEditor.svelte';
	import Chart from '$lib/components/Chart.svelte';
	import { Sparkles } from '@lucide/svelte';
	let { data, form } = $props();
	let suggesting = $state(false);
	const isAdmin = $derived(page.data.user?.role === 'owner' || page.data.user?.role === 'admin');
	let editing = $state<number | 'new' | null>(null);
	let chartFor = $state<{ id: number; name: string } | null>(null);
	let chart = $state<any[]>([]);
	const canEdit = $derived(page.data.user?.role !== 'viewer');
	async function showChart(row: { id: number | null; name: string }) {
		if (row.id == null || !data.mine) return;
		if (chartFor?.id === row.id) return (chartFor = null);
		chartFor = { id: row.id, name: row.name };
		chart = await fetch(`/sites/${page.params.id}/history?kind=group&type=${data.mine.kind}&value=${row.id}&days=480`).then((r) => r.json());
	}
	const views = [['buckets', 'Keyword buckets'], ['pagegroups', 'Page groups'], ['folders', 'URL folders'], ['topics', 'Topic clusters'], ['heatmap', 'Decay heatmap'], ['locales', 'Locales & countries']] as const;
	const href = (o: Record<string, string | number>) => `?${new URLSearchParams({ days: String(data.days), view: data.view, depth: String(data.depth), by: data.by, ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])) })}`;
	const monthLabel = (m: string) => new Date(m + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
	const cell = (v: number, max: number) => (max > 0 ? Math.min(1, v / max) : 0);
</script>

<div class="mb-4 flex flex-wrap items-center gap-3">
	<nav class="seg" aria-label="Group views">
		{#each views as [v, label]}<a class="seg-item {data.view === v ? 'seg-on' : ''}" aria-current={data.view === v ? 'page' : undefined} href={href({ view: v })} data-sveltekit-noscroll>{label}</a>{/each}
	</nav>
	{#if data.view === 'folders' || (data.view === 'heatmap' && data.by === 'group')}
		<span class="text-xs text-muted-foreground">Folder depth</span>
		<nav class="seg" aria-label="Folder depth">{#each [1, 2, 3] as d}<a class="seg-item {data.depth === d ? 'seg-on' : ''}" aria-current={data.depth === d ? 'page' : undefined} href={href({ depth: d })} data-sveltekit-noscroll>{d}</a>{/each}</nav>
	{/if}
</div>

{#if data.mine}
	{@const bucket = data.mine.kind === 'bucket'}
	<div class="mb-3 flex flex-wrap items-center gap-3">
		<p class="text-xs text-muted-foreground">{bucket ? 'Searches sorted into topics by your own rules. A search can sit in several buckets.' : 'Pages sorted into sections by your own rules on the path. A page can sit in several groups.'} Click a row for its daily chart.</p>
		{#if canEdit}
			<div class="ml-auto flex gap-2">
				<form method="POST" action="?/suggest" use:enhance={() => { suggesting = true; return async ({ update }) => { await update({ reset: false }); suggesting = false; }; }}><button class="btn" disabled={suggesting} title={data.aiReady ? 'Your AI provider (the one Ask uses) reads your top searches and pages and proposes buckets, page groups and brand terms. Nothing is saved until you tick and add.' : 'Proposes buckets from your topic clusters and page groups from your folders. Set up Ask to have an AI propose them.'}><Sparkles class="size-3.5" />{suggesting ? 'Suggesting…' : data.aiReady ? 'Suggest with AI' : 'Suggest'}</button></form>
				{#if editing !== 'new'}<button class="btn" onclick={() => (editing = 'new')}>{bucket ? 'New bucket' : 'New page group'}</button>{/if}
			</div>
		{/if}
	</div>
	{#if form?.suggestions}
		{@const sg = form.suggestions}
		<section class="card mb-4 p-4" aria-labelledby="sg-h">
			<div class="mb-2 flex flex-wrap items-baseline gap-x-3"><h2 id="sg-h" class="font-medium">Suggestions</h2><span class="text-xs text-muted-foreground">{sg.source === 'ai' ? 'from AI' : 'from your topic clusters and folders'} · tick what to keep</span></div>
			{#if sg.note}<p class="mb-3 text-xs text-muted-foreground">{sg.note}</p>{/if}
			{#if sg.brandTerms.length}
				<form method="POST" action="?/useBrand" use:enhance class="mb-4 flex flex-wrap items-center gap-2 text-sm">
					<span class="text-muted-foreground">Brand terms:</span>
					{#each sg.brandTerms as t}<label class="chip gap-1.5"><input type="checkbox" name="term" value={t} checked />{t}</label>{/each}
					{#if isAdmin}<button class="btn btn-sm">Use as brand terms</button>{:else}<span class="text-xs text-muted-foreground">An admin can set these in Settings.</span>{/if}
				</form>
			{/if}
			<form method="POST" action="?/acceptSuggestions" use:enhance={() => async ({ update }) => { await update(); }} class="grid gap-4 lg:grid-cols-2">
				{#each [['bucket', 'Keyword buckets', sg.buckets, 'searches'], ['pages', 'Page groups', sg.pageGroups, 'pages']] as const as [kind, label, list, unit]}
					<div>
						<h3 class="mb-1.5 text-sm font-medium">{label}</h3>
						{#if list.length}
							<ul class="space-y-1.5">
								{#each list as x}
									<li><label class="flex items-start gap-2 text-sm"><input type="checkbox" name="pick" value={JSON.stringify({ kind, name: x.name, set: x.set })} checked class="mt-1" /><span class="min-w-0 flex-1"><b class="font-medium">{x.name}</b> <span class="tnum text-xs text-muted-foreground">· {x.matches} {unit}, {x.clicks.toLocaleString('en-US')} clicks</span><span class="pii block truncate text-xs text-muted-foreground">{x.examples.join(' · ')}</span></span></label></li>
								{/each}
							</ul>
						{:else}<p class="text-xs text-muted-foreground">None to suggest.</p>{/if}
					</div>
				{/each}
				{#if sg.buckets.length + sg.pageGroups.length}<div class="lg:col-span-2"><button class="btn btn-primary">Add the ticked ones</button></div>{/if}
			</form>
		</section>
	{/if}
	{#if editing === 'new'}<div class="mb-4"><RuleGroupEditor kind={data.mine.kind} onDone={() => (editing = null)} /></div>{/if}
	{#if data.mine.rows.length}
		{#if !data.mine.comparable}<p class="mb-2 text-xs text-warn">Change against the previous period is hidden: that period is not downloaded yet.</p>{/if}
		{@const none = data.mine.rows.find((r) => r.id == null)}
		<DataTable rows={data.mine.rows.filter((r) => r.id != null)} onRowClick={showChart} cols={[{ key: 'name', label: bucket ? 'Bucket' : 'Group', type: 'text', pii: false }, { key: 'members', label: bucket ? 'Searches' : 'Pages', type: 'int' }, { key: 'clicks', label: 'Clicks', type: 'int', bar: true }, { key: 'deltaPct', label: 'Δ clicks', type: 'delta' }, { key: 'impressions', label: 'Impressions', type: 'int' }, { key: 'ctr', label: 'CTR', type: 'pct' }, { key: 'position', label: 'Position', type: 'pos' }, { key: 'summary', label: 'Rules', type: 'text', pii: true }]} sortKey="clicks" />
		{#if none}<p class="tnum mt-2 text-xs text-muted-foreground">{bucket ? 'In no bucket' : 'In no group'}: {none.members.toLocaleString('en-US')} {bucket ? 'searches' : 'pages'}, {none.clicks.toLocaleString('en-US')} clicks.</p>{/if}
		{#if chartFor}
			<div class="card mt-3 p-4">
				<div class="mb-2 flex flex-wrap items-center gap-2"><span class="font-medium">{chartFor.name}</span><span class="text-xs text-muted-foreground">all stored history</span>
					<a class="btn btn-sm ml-auto" href="{bucket ? 'queries' : 'pages'}?days={data.days}&{bucket ? 'bucket' : 'group'}={chartFor.id}">Open in {bucket ? 'Queries' : 'Pages'}</a>
				</div>
				<Chart data={chart} defaultMetrics={['clicks', 'position']} height={220} />
			</div>
		{/if}
		<h3 class="mt-6 mb-2 text-sm font-medium">{bucket ? 'Your buckets' : 'Your page groups'}</h3>
		<ul class="divide-y rounded-xl border bg-card" style="border-color:var(--border)">
			{#each data.mine.groups as g (g.id)}
				<li class="px-4 py-2.5">
					<div class="flex flex-wrap items-center gap-2 text-sm">
						<span class="font-medium">{g.name}</span>
						<a class="text-xs text-muted-foreground hover:underline" href="{bucket ? 'queries' : 'pages'}?days={data.days}&{bucket ? 'bucket' : 'group'}={g.id}">open in {bucket ? 'Queries' : 'Pages'}</a>
						{#if bucket}<a class="text-xs text-muted-foreground hover:underline" href="rank?days={data.days}" title="Its 8 biggest searches are followed on the Rank tracking tab">{g.track ? 'top 8 rank-tracked' : 'not rank-tracked'}</a>{/if}
						{#if canEdit}
							{#if bucket}<form method="POST" action="?/toggleTrack" use:enhance class="ml-auto"><input type="hidden" name="id" value={g.id} /><input type="hidden" name="on" value={g.track ? '0' : '1'} /><button class="btn btn-sm" aria-pressed={g.track}>{g.track ? 'Stop tracking' : 'Track top 8'}</button></form>{/if}
							<button class="btn btn-sm {bucket ? '' : 'ml-auto'}" onclick={() => (editing = editing === g.id ? null : g.id)}>{editing === g.id ? 'Close' : 'Edit'}</button>
							<form method="POST" action="?/deleteGroup" use:enhance><input type="hidden" name="id" value={g.id} /><button class="btn btn-sm text-muted-foreground">Remove</button></form>
						{/if}
					</div>
					{#if editing === g.id}<div class="mt-2"><RuleGroupEditor kind={data.mine.kind} group={g} onDone={() => (editing = null)} /></div>{/if}
				</li>
			{/each}
		</ul>
	{:else if editing !== 'new'}
		<div class="card p-6 text-center text-sm text-muted-foreground">{bucket ? 'No keyword buckets yet. A bucket gathers searches about one topic, such as everything containing “shoe” but not “repair”.' : 'No page groups yet. A group gathers a section of the site, such as every path starting with /blog/.'}</div>
	{/if}
{:else if data.view === 'folders' && data.groups}
	<p class="mb-3 text-xs text-muted-foreground">Pages grouped by the folder they live in (<code>/blog/post</code> → <code>/blog/</code>); pages directly under the root share “/”. Compared with the previous {data.days} days. Use it to see which section of the site is growing or shrinking, rather than reading page by page.</p>
	{#if data.comparable === false}<p class="mb-2 text-xs text-warn">Change against the previous period is hidden: {data.reason}</p>{/if}
	<DataTable rows={data.groups} cols={[{ key: 'key', label: 'Folder', type: 'text', pii: true }, { key: 'pages', label: 'Pages', type: 'int' }, { key: 'clicks', label: 'Clicks', type: 'int', bar: true }, { key: 'deltaPct', label: 'Δ clicks', type: 'delta' }, { key: 'impressions', label: 'Impressions', type: 'int' }, { key: 'position', label: 'Position', type: 'pos' }]} sortKey="clicks" />
{:else if data.view === 'topics' && data.topics}
	<Explainer lead="Queries grouped by their most telling shared word.">
	<p>Queries grouped by their most telling shared word (brand terms and words in nearly every query are skipped). It is a transparent word match, not a semantic model, so queries that mean the same with different words are not merged.
		{(data.topics.unclusteredShare * 100).toFixed(0)}% of impressions sit in queries outside any cluster.</p>
</Explainer>
	<DataTable rows={data.topics.clusters.map((c) => ({ ...c, examples: c.top.join(' · ') }))} cols={[{ key: 'topic', label: 'Topic word', type: 'text' }, { key: 'queries', label: 'Queries', type: 'int' }, { key: 'clicks', label: 'Clicks', type: 'int', bar: true }, { key: 'impressions', label: 'Impressions', type: 'int' }, { key: 'position', label: 'Position', type: 'pos' }, { key: 'examples', label: 'Top queries', type: 'text', pii: (r: { top: string[] }) => r.top.some((q) => isBranded(q, data.brandTerms ?? [])) }]} sortKey="clicks" empty="Not enough queries to form clusters yet." />
{:else if data.view === 'heatmap' && data.heatmap}
	<div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
		<span>Rows:</span>
		<span class="seg"><a class="seg-item {data.by === 'group' ? 'seg-on' : ''}" aria-current={data.by === 'group' ? 'page' : undefined} href={href({ by: 'group' })} data-sveltekit-noscroll>Folders</a><a class="seg-item {data.by === 'page' ? 'seg-on' : ''}" aria-current={data.by === 'page' ? 'page' : undefined} href={href({ by: 'page' })} data-sveltekit-noscroll>Pages</a></span>
		<span class="ml-2">Complete calendar months only (a part-month would look like a collapse). Each row is shaded against its own best month, so a fading row lightens to the right.</span>
	</div>
	{#if data.heatmap.months.length < 2 || !data.heatmap.rows.length}
		<div class="card p-6 text-center text-sm text-muted-foreground">Needs at least two complete months of stored history. The app is still downloading it, or the site is new.</div>
	{:else}
		<div class="card overflow-x-auto">
			<table class="w-full">
				<thead><tr><th class="th">{data.by === 'group' ? 'Folder' : 'Page'}</th>{#each data.heatmap.months as m}<th class="th text-center text-[11px]">{monthLabel(m)}</th>{/each}<th class="th text-right" title="Newest month against this row's best month">vs peak</th><th class="th text-right" title="Second half of the window against the first half">Trend</th></tr></thead>
				<tbody>
					{#each data.heatmap.rows as r (r.key)}
						{@const max = Math.max(...r.months)}
						<tr>
							<td class="td pii max-w-[22rem] truncate" title={r.key}>{r.key.replace(/^https?:\/\/(www\.)?/, '')}</td>
							{#each r.months as v, i}<td class="fade-in td tnum text-center text-[11px]" style:--i={i} style="background:color-mix(in oklch, var(--c-clicks) {Math.round(cell(v, max) * 65)}%, transparent)" title="{fmtInt(v)} clicks">{v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v}</td>{/each}
							<td class="td tnum text-right text-xs {r.fromPeakPct != null && r.fromPeakPct <= -0.5 ? 'text-bad' : ''}">{r.fromPeakPct == null ? '–' : fmtSigned(r.fromPeakPct)}</td>
							<td class="td tnum text-right text-xs {r.trendPct != null && r.trendPct <= -0.25 ? 'text-bad' : r.trendPct != null && r.trendPct >= 0.25 ? 'text-good' : ''}">{r.trendPct == null ? '–' : fmtSigned(r.trendPct)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
{:else if data.view === 'locales' && data.locales}
	<h2 class="mb-1 font-medium">Locale folders</h2>
	<Explainer lead="Locale folders, and where their clicks really come from.">
	<p>Folders such as <code>/en-gb/</code> or <code>/de/</code> and where their clicks really come from. A region folder (like <code>/en-gb/</code>) that earns under 40% of its clicks from its own country is flagged: check its hreflang tags and which page Google shows to whom. Only common countries are mapped.</p>
</Explainer>
	<DataTable rows={data.locales.map((l) => ({ ...l, top: l.topCountries.map((c) => `${c.country.toUpperCase()} ${(c.share * 100).toFixed(0)}%`).join(' · '), flag: l.mismatch ? '⚠ check hreflang' : '' }))} cols={[{ key: 'folder', label: 'Folder', type: 'text', pii: true }, { key: 'clicks', label: 'Clicks', type: 'int', bar: true }, { key: 'impressions', label: 'Impressions', type: 'int' }, { key: 'homeShare', label: 'From own country', type: 'pct' }, { key: 'top', label: 'Top countries', type: 'text' }, { key: 'flag', label: '', type: 'text' }]} sortKey="clicks" filterable={false} empty="No locale folders found in this site's URLs." />
	<h2 class="mt-6 mb-1 font-medium">Cannibalization within a country</h2>
	<p class="mb-2 text-xs text-muted-foreground">Queries where two or more pages compete for the same people in the <i>same</i> country. The same query answered by different pages in different countries is normal for a localised site and is not listed.</p>
	<DataTable rows={data.cannibal.map((g) => ({ country: g.country.toUpperCase(), query: g.query, severity: g.severity, clicksAtStake: Math.round(g.potentialClicks), pages: g.pages.length, winner: g.winner, totalClicks: g.totalClicks }))} cols={[{ key: 'country', label: 'Country', type: 'text' }, { key: 'query', label: 'Query', type: 'text', pii: (r: { query: string }) => isBranded(r.query, data.brandTerms ?? []) }, { key: 'severity', label: 'Severity', type: 'text' }, { key: 'clicksAtStake', label: 'Clicks at stake', type: 'int' }, { key: 'pages', label: 'Pages', type: 'int' }, { key: 'winner', label: 'Winning page', type: 'link' }]} sortKey="clicksAtStake" empty="No page competes with another inside one country." />
{/if}
