<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { X, Plus, Target, Lightbulb, ListPlus, Download, Search } from '@lucide/svelte';
	import RankSpark from '$lib/components/RankSpark.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { isBranded } from '$lib/analytics';
	import { pagePath } from '$lib/rules';
	import { fmtInt } from '$lib/format';
	let { data } = $props();

	let sort = $state<'latest' | 'change' | 'clicks' | 'query'>('latest');
	let needle = $state('');
	/** The bucket chip (?bucket=<name>) or the hand-added chip (?only=manual); kept in the address, shallow, so a filtered table can be linked. */
	let bucket = $state(page.url.searchParams.get('bucket') ?? '');
	let manualOnly = $state(page.url.searchParams.get('only') === 'manual');
	const bucketOn = $derived(data.bucketCounts.some((b) => b.name === bucket) ? bucket : '');
	const showManualChip = $derived(data.manualCount > 0 && data.manualCount < data.rows.length);

	function withFilter(u: URL) {
		u.searchParams.delete('bucket');
		u.searchParams.delete('only');
		if (manualOnly) u.searchParams.set('only', 'manual');
		else if (bucket) u.searchParams.set('bucket', bucket);
		return u;
	}
	function pick(b: string, manual = false) {
		bucket = b;
		manualOnly = manual;
		try {
			replaceState(withFilter(new URL(page.url)), page.state);
		} catch {
			/* before the router is ready: the filter still applies, only the address is not updated */
		}
	}
	const windowHref = (d: number) => {
		const u = withFilter(new URL(page.url));
		u.searchParams.delete('from');
		u.searchParams.set('days', String(d));
		return u.pathname + u.search;
	};
	const WINDOWS = [[7, '7 days'], [28, '28 days'], [90, '3 months']] as const;

	const rows = $derived.by(() => {
		const q = needle.trim().toLowerCase();
		return data.rows
			.filter((r) => (manualOnly ? r.manual : !bucketOn || r.buckets.includes(bucketOn)))
			.filter((r) => !q || r.query.includes(q) || r.buckets.some((b) => b.toLowerCase().includes(q)) || (r.landing != null && pagePath(r.landing).toLowerCase().includes(q)))
			.sort((a, b) =>
				sort === 'query' ? a.query.localeCompare(b.query)
				: sort === 'clicks' ? b.clicks - a.clicks
				: sort === 'change' ? (a.change ?? 0) - (b.change ?? 0)
				: (a.week ?? a.latest?.position ?? 999) - (b.week ?? b.latest?.position ?? 999)
			);
	});
	const pos = (p: number | null | undefined) => (p == null ? '–' : p.toFixed(1));
	/** A move in places, in words: positive is better (moved up), as rankReport gives it. */
	const moved = (c: number | null | undefined) =>
		c == null ? { text: '–', cls: 'text-muted-foreground' }
		: Math.abs(c) < 0.05 ? { text: 'no change', cls: 'text-muted-foreground' }
		: c > 0 ? { text: `${c.toFixed(1)} better`, cls: 'text-good' }
		: { text: `${(-c).toFixed(1)} worse`, cls: 'text-bad' };
	const maxClicks = $derived(Math.max(1, ...data.rows.map((r) => r.clicks)));

	const sum = $derived(data.summary);
	const avgMove = $derived(moved(sum.change));
	const top3Diff = $derived(sum.top3 - sum.top3Prev);

	const BANDS = [
		{ label: 'Top 3', color: 'var(--ord-1)' },
		{ label: '4–10', color: 'var(--ord-2)' },
		{ label: '11–20', color: 'var(--ord-3)' },
		{ label: '21+', color: 'var(--ord-4)' }
	];
	const NONE_COLOR = 'var(--muted)';
	const dayTitle = (d: { date: string; bands: number[]; none: number }) => `${d.date}: ${BANDS.map((b, i) => `${b.label} ${d.bands[i]}`).join(', ')}, not shown ${d.none}`;
	/** Google updates that began in the window, placed under the day they began (or the first day, if earlier). */
	const marks = $derived(
		data.googleUpdates.map((u) => {
			const i = Math.max(0, data.bands.findIndex((d) => d.date >= u.begin));
			return { ...u, left: data.bands.length ? (i + 0.5) / data.bands.length : 0 };
		})
	);

	function exportCsv() {
		const text = (v: string) => {
			const t = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v; // a search is third-party text: never let a spreadsheet read it as a formula
			return /[",\n]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
		};
		const head = ['Search', 'Buckets', 'Landing page', 'Position (last 7 days)', 'Change (places, + = better)', 'Best', 'Clicks', 'Days in top 10'];
		const body = rows.map((r) => [text(r.query), text(r.buckets.join('; ')), text(r.landing ?? ''), r.week == null ? '' : r.week.toFixed(1), r.change == null ? '' : r.change.toFixed(1), r.best == null ? '' : r.best.toFixed(1), String(r.clicks), String(r.daysTop10)].join(','));
		const url = URL.createObjectURL(new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' }));
		const a = Object.assign(document.createElement('a'), { href: url, download: `rank-tracking-${data.site.name.replace(/[^\w.-]+/g, '-')}-${data.end}.csv` });
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
</script>

<PageHeader tab="/rank" title="Rank tracking" lead="Daily Google position of the searches you choose, from your own Search Console data. No credits, no scraping.">
	<p>Each day's position is Search Console's average for that search across every country and device, weighted by impressions. A day without an impression has no position (a gap in the line) rather than a guess. Results-page trackers check one place and one device; this shows what searchers actually saw, a few days late, as Search Console is.</p>
	<p>The dashed line is position 10, the end of page one. Position is the average of the last 7 days; the change is against the 7 before. The summary averages these over every tracked search shown in both weeks. The built-in “Tracked searches falling” alert watches these.</p>
	<p>The landing page is the page that earned the search the most clicks in the period.</p>
	{#snippet meta()}
		<span class="text-xs text-muted-foreground">{data.manualCount} of {data.max.total} searches{#if data.rows.length > data.manualCount} + {data.rows.length - data.manualCount} from buckets{/if} · {data.start} → {data.end}</span>
	{/snippet}
	{#snippet actions()}
		{#if data.rows.length}
			<button type="button" class="btn btn-sm" onclick={exportCsv} title="Download the table as shown, as CSV"><Download class="size-3.5" aria-hidden="true" />Export</button>
		{/if}
		<a class="btn btn-primary btn-sm" href="#rank-add"><Plus class="size-3.5" aria-hidden="true" />Track searches</a>
	{/snippet}
</PageHeader>

{#if data.rows.length}
	<section class="card mb-4 grid gap-5 p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" aria-label="Summary">
		<div class="grid content-start gap-4 sm:grid-cols-3 md:grid-cols-1">
			<div>
				<div class="tnum text-2xl font-semibold tracking-tight">{fmtInt(sum.tracked)}</div>
				<div class="text-xs text-muted-foreground">searches tracked</div>
			</div>
			<div>
				<div class="tnum text-2xl font-semibold tracking-tight">{pos(sum.position)}</div>
				<div class="text-xs text-muted-foreground">average position{#if sum.change != null}, <span class="font-medium {avgMove.cls}">{avgMove.text}</span>{/if}</div>
			</div>
			<div>
				<div class="tnum text-2xl font-semibold tracking-tight">{fmtInt(sum.top3)}</div>
				<div class="text-xs text-muted-foreground">in the top 3, <span class="tnum font-medium {top3Diff > 0 ? 'text-good' : top3Diff < 0 ? 'text-bad' : ''}">{top3Diff > 0 ? `+${top3Diff}` : top3Diff < 0 ? `−${-top3Diff}` : 'no change'}</span></div>
			</div>
		</div>
		<div class="min-w-0">
			<div class="mb-2 text-xs font-medium text-muted-foreground">Last {data.bands.length} days</div>
			<div class="flex h-28 items-stretch {data.bands.length <= 120 ? 'gap-px' : ''}" role="img" aria-label="Tracked searches by position band, per day">
				{#each data.bands as d (d.date)}
					<div class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[2px]" title={dayTitle(d)}>
						{#each BANDS as b, i}{#if d.bands[i]}<div style="flex:{d.bands[i]} 1 0;background:{b.color}"></div>{/if}{/each}
						{#if d.none}<div style="flex:{d.none} 1 0;background:{NONE_COLOR}"></div>{/if}
					</div>
				{/each}
			</div>
			{#if marks.length}
				<div class="relative mt-1 h-3" aria-label="Google updates">
					{#each marks as m}
						<span class="absolute top-0 size-2 -translate-x-1/2 rotate-45 rounded-[1px]" style="left:{m.left * 100}%;background:var(--warn)" title="{m.name}: {m.begin} → {m.end ?? 'ongoing'}"><span class="sr-only">{m.name}</span></span>
					{/each}
				</div>
			{/if}
			<div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
				{#each BANDS as b}<span class="inline-flex items-center gap-1"><span class="size-2.5 rounded-sm" style="background:{b.color}" aria-hidden="true"></span>{b.label}</span>{/each}
				<span class="inline-flex items-center gap-1"><span class="size-2.5 rounded-sm border" style="background:{NONE_COLOR};border-color:var(--border)" aria-hidden="true"></span>Not shown</span>
				{#if marks.length}<span class="inline-flex items-center gap-1"><span class="size-2 rotate-45 rounded-[1px]" style="background:var(--warn)" aria-hidden="true"></span>Google update</span>{/if}
			</div>
		</div>
	</section>

	<div class="mb-2 flex flex-wrap items-center gap-2">
		<div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by bucket">
			<button type="button" class="chip {!manualOnly && !bucketOn ? 'chip-on' : ''}" aria-pressed={!manualOnly && !bucketOn} onclick={() => pick('')}><span class="tnum mr-1">{data.rows.length}</span>All</button>
			{#each data.bucketCounts as b (b.name)}
				<button type="button" class="chip {!manualOnly && bucketOn === b.name ? 'chip-on' : ''}" aria-pressed={!manualOnly && bucketOn === b.name} onclick={() => pick(b.name)}><span class="tnum mr-1">{b.count}</span>{b.name}</button>
			{/each}
			{#if showManualChip}
				<button type="button" class="chip {manualOnly ? 'chip-on' : ''}" aria-pressed={manualOnly} onclick={() => pick('', true)} title="Added by hand">Manual<span class="tnum ml-1">{data.manualCount}</span></button>
			{/if}
			<a class="chip" href="/sites/{data.site.id}/groups?view=buckets" title="Keyword buckets live on the Groups tab; a bucket set to track follows its biggest searches here"><Plus class="mr-0.5 size-3" aria-hidden="true" />New bucket</a>
		</div>
		<div class="ml-auto flex flex-wrap items-center gap-2">
			<label class="relative">
				<span class="sr-only">Search the tracked searches</span>
				<Search class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
				<input type="search" class="input h-8 w-44 pl-7 text-sm" placeholder="Search" bind:value={needle} />
			</label>
			<label class="text-xs text-muted-foreground"><span class="sr-only">Sort</span><select class="input h-8" bind:value={sort} aria-label="Sort"><option value="latest">Position</option><option value="change">Biggest fall</option><option value="clicks">Clicks</option><option value="query">A–Z</option></select></label>
			<nav class="seg" aria-label="Window">
				{#each WINDOWS as [d, label]}<a class="seg-item {data.days === d ? 'seg-on' : ''}" aria-current={data.days === d ? 'page' : undefined} href={windowHref(d)} data-sveltekit-noscroll>{label}</a>{/each}
			</nav>
		</div>
	</div>

	<div class="overflow-x-auto rounded-xl border bg-card" style="border-color:var(--border)">
		<table class="w-full text-sm">
			<thead class="text-left text-xs text-muted-foreground">
				<tr class="border-b" style="border-color:var(--border)">
					<th class="px-3 py-2 font-medium">Search</th>
					<th class="px-3 py-2 text-right font-medium" title="Average over the last 7 days">Position</th>
					<th class="px-3 py-2 text-right font-medium" title="Places moved against the 7 days before">Change</th>
					<th class="px-3 py-2 text-right font-medium" title="Best daily position in the period">Best</th>
					<th class="px-3 py-2 font-medium">Daily position</th>
					<th class="px-3 py-2 text-right font-medium">Clicks</th>
					<th class="px-3 py-2 text-right font-medium" title="Days in the top 10 out of days shown">Top 10</th>
					<th class="relative px-3 py-2"><span class="sr-only">Remove</span></th>
				</tr>
			</thead>
			<tbody>
				{#each rows as r (r.query)}
					{@const m = moved(r.change)}
					<tr class="border-b last:border-0" style="border-color:var(--border)">
						<td class="max-w-96 px-3 py-2">
							<div class="flex min-w-0 items-center gap-1.5">
								<a class="truncate hover:underline {isBranded(r.query, data.brandTerms) ? 'pii' : ''}" href="queries?re={encodeURIComponent('^' + r.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')}">{r.query}</a>
								{#each r.buckets as b}<span class="pill pill-muted shrink-0 !px-1.5 !py-0 !text-[10px]" title="Followed because it is one of the 8 biggest searches of this keyword bucket">{b}</span>{/each}
							</div>
							{#if r.landing}<div class="pii truncate text-xs text-muted-foreground" title={r.landing}>{pagePath(r.landing)}</div>{/if}
						</td>
						<td class="tnum px-3 py-2 text-right font-medium" title={r.latest ? `Latest: ${pos(r.latest.position)} on ${r.latest.date}` : 'No impression in the stored days'}>{pos(r.week)}</td>
						<td class="tnum px-3 py-2 text-right whitespace-nowrap {m.cls}">{m.text}</td>
						<td class="tnum px-3 py-2 text-right">{pos(r.best)}</td>
						<td class="px-3 py-1"><RankSpark values={r.series} /></td>
						<td class="tnum cellbar px-3 py-2 text-right" style="--w:{r.clicks / maxClicks}">{fmtInt(r.clicks)}</td>
						<td class="tnum px-3 py-2 text-right text-muted-foreground">{r.daysTop10}/{r.daysShown}</td>
						<td class="px-2 py-2">{#if r.manual}<form method="POST" action="?/remove" use:enhance><input type="hidden" name="query" value={r.query} /><button class="text-muted-foreground hover:text-foreground" aria-label="Stop tracking this search" title="Stop tracking"><X class="size-3.5" /></button></form>{/if}</td>
					</tr>
				{:else}
					<tr><td colspan="8" class="px-3 py-6 text-center text-sm text-muted-foreground">No tracked search matches.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else}
	<EmptyState icon={Target} tone="blue" title="No searches tracked yet." text="Add some below, or pick from the suggestions.">
		<a class="btn btn-primary btn-sm" href="#rank-add"><Plus class="size-3.5" aria-hidden="true" />Track searches</a>
	</EmptyState>
{/if}

<div class="mt-5 grid gap-4 lg:grid-cols-2">
	<form method="POST" action="?/add" use:enhance class="card p-4">
		<label class="flex items-center gap-2 text-sm font-medium" for="rank-add"><span class="ibadge ibadge-sm tone-blue" aria-hidden="true"><ListPlus class="size-3.5" /></span>Track searches</label>
		<p class="mb-2 text-xs text-muted-foreground">One per line, up to {data.max.atOnce} at a time. Written as people search; case does not matter.</p>
		<textarea id="rank-add" name="queries" rows="5" class="input w-full font-mono text-xs" placeholder={'running shoes\nbest trail running shoes'}></textarea>
		<button class="btn btn-primary mt-2"><Plus class="size-3.5" aria-hidden="true" />Track</button>
	</form>
	{#if data.suggestions.length}
		<form method="POST" action="?/add" use:enhance class="card p-4">
			<div class="flex items-center gap-2 text-sm font-medium"><span class="ibadge ibadge-sm tone-amber" aria-hidden="true"><Lightbulb class="size-3.5" /></span>Suggestions</div>
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
