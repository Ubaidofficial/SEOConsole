<script lang="ts">
	import { privacy } from '$lib/privacy.svelte';
	import { enhance } from '$app/forms';
	import { LoaderCircle, ScanSearch, ListOrdered, Send, ListPlus, SquareCheck, Square } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusPill from '$lib/components/StatusPill.svelte';
	import { ago, shortUrl } from '$lib/format';
	let { data, form } = $props();
	let busy = $state(false);
	let picked = $state<string[]>([]);
	const notIndexed = $derived(data.results.filter((x) => !x.r.error && x.r.indexStatusResult?.verdict !== 'PASS').map((x) => x.url));
	const allShown = $derived(data.results.map((x) => x.url));
	const tone = (v?: string) => (v === 'PASS' ? 'good' : v === 'FAIL' ? 'bad' : v ? 'warn' : 'muted');
</script>

<PageHeader tab="/inspect" title="Inspect" lead="Look up Google's index status for specific URLs (URL Inspection).">
	<p>Uses the URL Inspection API (quota is per property, roughly 2,000 inspections per day — verify current limits in Google’s docs). Results are cached for 12 hours.</p>
</PageHeader>

<div class="mb-5 rounded-xl border bg-card p-4 shadow-xs">
	<form method="POST" action="?/inspect" use:enhance={() => { busy = true; return async ({ update }) => { await update(); busy = false; }; }}>
		<textarea class="input h-24 w-full font-mono text-xs" name="urls" aria-label="URLs to inspect, one per line" placeholder="One URL per line (max 20 per run)"></textarea>
		<div class="mt-2 flex flex-wrap items-center gap-3">
			<button class="btn btn-primary btn-sm" disabled={busy}>{#if busy}<LoaderCircle class="size-3.5 animate-spin" />Inspecting…{:else}<ScanSearch class="size-3.5" />Inspect URLs{/if}</button>
			<button class="btn btn-sm" formaction="?/top" disabled={busy}><ListOrdered class="size-3.5" />Inspect top 10 pages</button>
			<label class="flex items-center gap-1 text-xs"><input type="checkbox" name="force" /> bypass 12h cache</label>
		</div>
	</form>
	{#if form?.error}<p class="mt-2 text-sm text-bad">{form.error}</p>{/if}
	{#if form?.submitted}<p class="mt-2 text-sm text-good">{form.submitted}</p>{/if}
	{#if form && 'live' in form}<p class="mt-2 text-xs text-muted-foreground">{form.live} fetched from Google, {form.cached} from cache.{form.truncated ? ' Only the first 20 URLs were used.' : ''}</p>{/if}
</div>

<form method="POST" use:enhance={() => async ({ update }) => { await update({ reset: false }); }}>
<div class="mb-2 flex flex-wrap items-center gap-2 text-xs">
	<span class="text-muted-foreground">With the ticked URLs:</span>
	<button class="btn btn-sm" formaction="?/submitSelected" disabled={!picked.length} title="Send them to IndexNow, Bing and (for job and livestream pages) Google's Indexing API"><Send class="size-3.5" />Submit for indexing</button>
	<button class="btn btn-sm" formaction="?/addToRequests" disabled={!picked.length} title="Put them on the Request indexing list, where you press Search Console's button"><ListPlus class="size-3.5" />Add to the Request list</button>
	<button class="btn btn-sm" type="button" onclick={() => (picked = [...notIndexed])} disabled={!notIndexed.length}><SquareCheck class="size-3.5" />Tick the not-indexed ({notIndexed.length})</button>
	<button class="btn btn-sm" type="button" onclick={() => (picked = picked.length ? [] : [...allShown])}>{#if picked.length}<Square class="size-3.5" />Untick all{:else}<SquareCheck class="size-3.5" />Tick all{/if}</button>
</div>
<div class="overflow-x-auto rounded-xl border bg-card shadow-xs">
	<table class="w-full">
		<thead><tr><th class="th relative w-px"><span class="sr-only">Pick</span></th><th class="th">URL</th><th class="th">Verdict</th><th class="th">Coverage</th><th class="th">Last crawl</th><th class="th">Canonical</th><th class="th">Checked</th></tr></thead>
		<tbody>
			{#each data.results as { url, at, r } (url)}
				{@const s = r.indexStatusResult}
				<tr>
					<td class="td w-px"><input type="checkbox" name="url" value={url} bind:group={picked} aria-label="Pick {url}" /></td>
					<td class="td max-w-[26rem] truncate"><a class="pii hover:underline" href={url} target="_blank" rel="noreferrer noopener" title={privacy.on ? undefined : url}>{shortUrl(url)}</a></td>
					{#if r.error}
						<td class="td text-bad" colspan="4">{r.error}</td>
					{:else}
						<td class="td"><StatusPill tone={tone(s?.verdict)}>{s?.verdict ?? '–'}</StatusPill></td>
						<td class="td">{s?.coverageState ?? '–'}</td>
						<td class="td tnum">{s?.lastCrawlTime?.slice(0, 10) ?? '–'}</td>
						<td class="td">
							{#if s?.googleCanonical && s?.userCanonical && s.googleCanonical !== s.userCanonical}<StatusPill tone="warn" title="Google chose {s.googleCanonical}">mismatch</StatusPill>{:else}<StatusPill tone="good">ok</StatusPill>{/if}
						</td>
					{/if}
					<td class="td text-xs text-muted-foreground">{ago(at)}</td>
				</tr>
			{:else}
				<tr><td class="td" colspan="7"><EmptyState compact icon={ScanSearch} title="Nothing inspected yet." text="Paste URLs above, or inspect your top 10 pages." /></td></tr>
			{/each}
		</tbody>
	</table>
</div>
</form>
