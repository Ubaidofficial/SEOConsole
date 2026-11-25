<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import DataTable from '$lib/components/DataTable.svelte';
	import Chart from '$lib/components/Chart.svelte';
	import { POSITION_BUCKETS } from '$lib/plan';
	import BarList from '$lib/components/viz/BarList.svelte';
	import SavedViews from '$lib/components/SavedViews.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Download, Funnel, Trash2, X } from '@lucide/svelte';
	import { TEXT_OPS, describePattern, textFilter, type TextOp } from '$lib/textfilter';

	import { enhance } from '$app/forms';
	import { ago } from '$lib/format';
	let { data, form } = $props();
	let fetching = $state(false);
	let open = $state<string | null>(null);
	let history = $state<any[]>([]);
	let loading = $state(false);
	let pagesFor = $state<{ page: string; clicks: number; impressions: number; position: number }[]>([]);

	function setParam(k: string, v: string) {
		const u = new URL(page.url);
		v ? u.searchParams.set(k, v) : u.searchParams.delete(k);
		goto(u.pathname + u.search, { keepFocus: true });
	}
	async function toggle(row: { query: string }) {
		if (open === row.query) return (open = null);
		open = row.query;
		loading = true;
		const u = `/sites/${page.params.id}/history?kind=query&value=${encodeURIComponent(row.query)}&days=480`;
		const pu = `/sites/${page.params.id}/history?kind=pages&value=${encodeURIComponent(row.query)}&period=${page.url.searchParams.get('days') ?? 28}`;
		queueMicrotask(() => detail?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
		[history, pagesFor] = await Promise.all([fetch(u).then((r) => r.json()), fetch(pu).then((r) => r.json())]);
		loading = false;
	}
	/** Filters besides the query type, so the Filters button can say how many are on. */
	const activeFilters = $derived([data.pos, data.filters.country, data.filters.device, data.re, data.nre].filter(Boolean).length);
	const canEdit = $derived(page.data.user?.role !== 'viewer');
	let op = $state<TextOp>('contains');
	let text = $state('');
	function applyText(e: SubmitEvent) {
		e.preventDefault();
		const f = textFilter(op, text);
		if (!f) return;
		const u = new URL(page.url);
		u.searchParams.set(f.key, f.pattern);
		text = '';
		goto(u.pathname + u.search, { keepFocus: true });
	}
	/** Every filter that is on, as a chip you can remove on its own (as Plausible does), so what the table shows is never a mystery. */
	const chips = $derived.by(() => {
		const out: { key: string; field: string; value: string }[] = [];
		if (data.b !== 'all') out.push({ key: 'b', field: 'Query', value: data.b === 'brand' ? 'is branded' : 'is not branded' });
		if (data.qf) out.push({ key: 'qf', field: 'Quick filter', value: data.quickFilters.find((f) => f.key === data.qf)?.label ?? data.qf });
		if (data.pos) out.push({ key: 'pos', field: 'Position', value: POSITION_BUCKETS.find((b) => b.key === data.pos)?.label ?? data.pos });
		if (data.filters.country) out.push({ key: 'country', field: 'Country', value: `is ${data.filters.country.toUpperCase()}` });
		if (data.filters.device) out.push({ key: 'device', field: 'Device', value: `is ${data.filters.device}` });
		if (data.re) out.push({ key: 're', field: 'Query', value: describePattern(data.re, false) });
		if (data.nre) out.push({ key: 'nre', field: 'Query', value: describePattern(data.nre, true) });
		if (data.bucket) out.push({ key: 'bucket', field: 'Bucket', value: `is ${data.buckets.find((b) => b.id === data.bucket)?.name ?? data.bucket}` });
		return out;
	});
	function drop(keys: string[]) {
		const u = new URL(page.url);
		for (const k of keys) u.searchParams.delete(k);
		goto(u.pathname + u.search, { keepFocus: true, noScroll: true });
	}
	let detail: HTMLElement | undefined = $state();
	const cols = $derived([
		{ key: 'query', label: 'Query', type: 'text' as const, pii: (r: { branded: boolean }) => r.branded },
		{ key: 'clicks', label: 'Clicks', type: 'int' as const, bar: true },
		{ key: 'clicksDelta', label: 'Δ %', title: 'Change in clicks compared with the previous period of the same length (for example +9.5% = 9.5% more clicks than before). A dash means there were no clicks before, so there is no percentage.', type: 'delta' as const },
		{ key: 'impressions', label: 'Impressions', type: 'int' as const },
		{ key: 'ctr', label: 'CTR', type: 'pct' as const },
		{ key: 'position', label: 'Position', type: 'pos' as const },
		{ key: 'trend', label: 'Trend', type: 'spark' as const, title: 'Clicks by day over the period (shown for the 200 biggest searches)' },
		...(data.openseo?.known ? [{ key: 'volume', label: 'Volume', type: 'int' as const, title: 'Monthly searches for this query in the market of the linked OpenSEO project (from DataForSEO through OpenSEO). A dash: not fetched yet, or too small to measure.' }, { key: 'kd', label: 'KD', type: 'int' as const, title: 'Keyword difficulty from OpenSEO, 0 to 100: how hard the top results are to outrank' }] : [])
	]);
</script>

<PageHeader tab="/queries" title="Queries" lead="Every search you were shown for, with quick filters, keyword buckets and saved views. Click a row for its full history.">
	{#snippet actions()}<a class="btn btn-sm" href="/sites/{page.params.id}/export?dim=query&days={page.url.searchParams.get('days') ?? 28}"><Download class="size-3.5" />Export CSV</a>{/snippet}
</PageHeader>
<div class="mb-2 flex flex-wrap items-center gap-2">
	<select class="input" aria-label="Query type" value={data.b} onchange={(e) => setParam('b', e.currentTarget.value)}>
		<option value="all">All queries</option><option value="nonbrand">Non-branded</option><option value="brand">Branded</option>
	</select>
	<details class="group relative">
		<summary class="btn cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden"><Funnel class="size-3.5" />Filters{#if activeFilters}<span class="ml-1.5 rounded-full bg-[color:var(--link)] px-1.5 text-[10px] text-white">{activeFilters}</span>{/if}</summary>
		<div class="card absolute left-0 z-20 mt-1 w-[min(44rem,90vw)] p-3 shadow-lg">
			<div class="mb-2 flex flex-wrap items-center gap-2">
	<select class="input" aria-label="Position" value={data.pos} onchange={(e) => setParam('pos', e.currentTarget.value)}>
		<option value="">Any position</option>{#each POSITION_BUCKETS as b}<option value={b.key}>{b.label}</option>{/each}
	</select>
	<select class="input" aria-label="Country" value={data.filters.country ?? ''} onchange={(e) => setParam('country', e.currentTarget.value)}>
		<option value="">All countries</option>{#each data.countries as c}<option value={c}>{c.toUpperCase()}</option>{/each}
	</select>
	<select class="input" aria-label="Device" value={data.filters.device ?? ''} onchange={(e) => setParam('device', e.currentTarget.value)}>
		<option value="">All devices</option>{#each data.devices as d}<option value={d}>{d}</option>{/each}
	</select>
			</div>
			<div class="text-xs font-medium text-muted-foreground">Query text</div>
	<form class="mt-1 flex flex-wrap items-center gap-2" onsubmit={applyText}>
		<select class="input" bind:value={op} aria-label="How to match">{#each TEXT_OPS as [k, l]}<option value={k}>{l}</option>{/each}</select>
		<input class="input w-72 {op === 'regex' ? 'font-mono text-xs' : ''}" bind:value={text} placeholder={op === 'any' ? 'shoes, boots, sandals' : op === 'regex' ? '^how|best .* tools' : 'running shoes'} aria-label="Text to match" />
		<button class="btn btn-primary">Add filter</button>
	</form>
	<p class="mt-1 text-[11px] text-muted-foreground">Case-insensitive. "Matches regex" works like Search Console's custom filter; "matches any of" takes a list split by commas.</p>
	{#if data.regexError}<p class="mt-1 text-xs text-bad">{data.regexError}</p>{/if}
		</div>
	</details>
	{#if data.buckets.length}
		<select class="input" aria-label="Keyword bucket" value={data.bucket ? String(data.bucket) : ''} onchange={(e) => setParam('bucket', e.currentTarget.value)}>
			<option value="">All buckets</option>{#each data.buckets as b}<option value={String(b.id)}>{b.name}</option>{/each}
		</select>
	{/if}
</div>
{#if chips.length}
	<div class="mb-2 flex flex-wrap items-center gap-1.5" aria-label="Filters on">
		{#each chips as c}
			<span class="inline-flex items-center overflow-hidden rounded-md border bg-card text-xs shadow-xs">
				<span class="bg-muted px-2 py-1 text-muted-foreground">{c.field}</span><span class="px-2 py-1 {c.key === 're' || c.key === 'nre' ? 'pii' : ''}">{c.value}</span>
				<button type="button" class="tap grid h-full place-items-center border-l px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Remove filter: {c.field} {c.value}" onclick={() => drop(c.key === 'qf' ? ['qf', 'q'] : [c.key])}><X class="size-3" /></button>
			</span>
		{/each}
		{#if chips.length > 1}<button type="button" class="btn btn-ghost btn-xs" onclick={() => drop(['b', 'qf', 'q', 'pos', 'country', 'device', 're', 'nre', 'bucket'])}><Trash2 class="size-3" />Clear all</button>{/if}
	</div>
{/if}
<nav class="mb-2 flex flex-wrap items-center gap-1.5" aria-label="Quick filters">
	{#each data.quickFilters as f}<button type="button" class="chip {data.qf === f.key ? 'chip-on' : ''}" title={f.hint} aria-pressed={data.qf === f.key} onclick={() => { const u = new URL(page.url); u.searchParams.delete('q'); data.qf === f.key ? u.searchParams.delete('qf') : u.searchParams.set('qf', f.key); goto(u.pathname + u.search, { keepFocus: true, noScroll: true }); }}>{f.label}</button>{/each}
</nav>
<SavedViews views={data.views} canSave={canEdit} />
{#if data.bucketMissing}<p class="mb-2 text-xs text-bad">That keyword bucket no longer exists.</p>{/if}
<p class="mb-2 text-xs text-muted-foreground"><b class="text-foreground">{data.rows.length.toLocaleString('en-US')}</b> searches. Branded = contains <span class="pii">{data.brandTerms.length ? data.brandTerms.join(', ') : '(no brand terms — set them in Settings)'}</span>. Click a row for its full-history chart.</p>

{#if data.openseo}
	<form method="POST" action="?/oseoVolumes" use:enhance={() => { fetching = true; return async ({ update }) => { await update(); fetching = false; }; }} class="mb-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
		<button class="btn btn-sm" disabled={fetching || !data.openseo.pending}>{fetching ? 'Asking OpenSEO…' : data.openseo.known ? 'Fetch volume for new searches' : 'Show search volume (OpenSEO)'}</button>
		<span>{data.openseo.known ? `${data.openseo.known.toLocaleString('en-US')} searches have a volume, fetched ${ago(data.openseo.fetchedAt ?? 0)}.` : 'Monthly searches and difficulty for your top searches, from your OpenSEO project.'} {data.openseo.pending ? `Next fetch: up to ${data.openseo.pending} searches, which uses OpenSEO credits.` : 'All current searches are covered.'}</span>
	</form>
	{#if form?.ok}<p class="mb-2 text-xs text-good">{form.ok}</p>{/if}{#if form?.error}<p class="mb-2 text-xs text-bad">{form.error}</p>{/if}
{/if}
<DataTable rows={data.rows} {cols} sortKey="clicks" onRowClick={toggle} pageSize={25} />

{#if open}
	<div class="card mt-3 scroll-mt-4 p-4" bind:this={detail}>
		<div class="mb-2 flex flex-wrap items-center gap-2"><span class="font-medium">“<span class="pii">{open}</span>” — all stored history</span>
			<a class="btn btn-sm ml-auto" href="brief?q={encodeURIComponent(open)}" title="What to write or rewrite for this search, from your own data (no credits)">Content brief</a>{#if data.tracked.includes(open)}<a class="chip" href="rank?days={page.url.searchParams.get('days') ?? 28}">Tracked</a>{:else if canEdit}<form method="POST" action="?/track" use:enhance><input type="hidden" name="query" value={open} /><button class="btn btn-sm" title="Follow its daily position on the Rank tracking tab">Track position</button></form>{/if}
		</div>
		{#if loading}<p class="text-muted-foreground">Loading…</p>{:else}
			<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
				<div class="lg:col-span-2"><Chart data={history} defaultMetrics={['clicks', 'position']} height={220} /></div>
				<div>
					<h3 class="mb-2 text-sm font-medium">Your pages for this search <span class="font-normal text-muted-foreground">· this period</span></h3>
					{#if pagesFor.length}<BarList items={pagesFor.map((p) => ({ label: p.page.replace(/^https?:\/\/[^/]+/, '') || '/', value: p.impressions, href: p.page, note: `pos ${p.position?.toFixed(1) ?? '–'} · ${p.clicks} clicks`, pii: true }))} unit="impr." limit={6} />
					{#if pagesFor.length > 1}<p class="mt-2 text-xs text-muted-foreground">More than one page shows for this search; see the Cannibalization tab if they split the clicks.</p>{/if}
					{:else}<p class="text-xs text-muted-foreground">No pages in this period.</p>{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}
