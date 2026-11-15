<script lang="ts">
	import Chart from '$lib/components/Chart.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import Delta from '$lib/components/Delta.svelte';
	import Explainer from '$lib/components/Explainer.svelte';
	import { enhance } from '$app/forms';
	import { fmtInt, fmtPct, ago } from '$lib/format';
	let { data, form } = $props();
	let busy = $state(false);
	const path = (u: string) => { try { const x = new URL(u); return x.pathname + x.search || '/'; } catch { return u; } };
	const KIND = { gone: 'Page not found', error: 'Server error' } as const;
	const cols = (l: string, link = false) => [
		{ key: 'term', label: l, type: (link ? 'link' : 'text') as 'link' | 'text', pii: link ? undefined : (r: { branded?: boolean }) => !!r.branded },
		{ key: 'clicks', label: 'Clicks', type: 'int' as const },
		{ key: 'impressions', label: 'Impressions', type: 'int' as const },
		{ key: 'ctr', label: 'CTR', type: 'pct' as const },
		{ key: 'clickPos', label: 'Avg click pos.', type: 'pos' as const }
	];
</script>

{#if !data.linked}
	<div class="card p-6 text-center"><p class="mb-3">Bing Webmaster isn't linked to this site yet.</p><a class="btn btn-primary" href="/connect">Connect Bing</a></div>
{:else}
	<div class="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
		<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Bing clicks</div><div class="tnum text-xl font-semibold">{fmtInt(data.kpi.clicks)}</div><Delta value={data.kpi.clicksDelta} /></div>
		<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Bing impressions</div><div class="tnum text-xl font-semibold">{fmtInt(data.kpi.impressions)}</div><Delta value={data.kpi.impressionsDelta} /></div>
		<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Bing clicks vs Google</div><div class="tnum text-xl font-semibold">{fmtPct(data.kpi.shareOfGoogle)}</div><div class="text-xs text-muted-foreground">of Google's {fmtInt(data.kpi.googleClicks)}</div></div>
		<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Site</div><div class="pii truncate text-sm font-medium">{data.bingUrl}</div><div class="text-xs text-muted-foreground">{data.status.state === 'error' ? data.status.message : 'synced ' + ago(data.status.lastSync)}</div></div>
	</div>
	<div class="card mb-4 p-4"><Chart data={data.series} hide={['position']} labels={{ clicks: 'Bing clicks', impressions: 'Bing impressions' }} /></div>
	<p class="mb-3 text-xs text-muted-foreground">Daily totals come from Bing's traffic endpoint (updated daily; includes web, chat, news, images, videos from 24 Mar 2023). Query and page tables use Bing's detail endpoints, which Microsoft documents as <b>updated weekly</b>, so they lag the totals and are aggregated from weekly rows.</p>
	<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
		<section><h2 class="mb-2 font-medium">Top queries</h2><DataTable rows={data.queries} cols={cols('Query')} sortKey="clicks" pageSize={15} /></section>
		<section><h2 class="mb-2 font-medium">Top pages</h2><DataTable rows={data.pages} cols={cols('Page', true)} sortKey="clicks" pageSize={15} /></section>
	</div>
	<section class="mt-6" id="links">
		<div class="mb-2 flex flex-wrap items-center gap-2">
			<h2 class="font-medium">Inbound links Bing knows about</h2>
			<form method="POST" action="?/refreshLinks" class="ml-auto" use:enhance={() => { busy = true; return async ({ update }) => { await update(); busy = false; }; }}>
				<button class="btn !h-8 text-xs" disabled={busy || data.readOnly}>{busy ? 'Fetching…' : 'Refresh now'}</button>
			</form>
		</div>
		{#if form?.error}<p class="mb-2 text-sm text-red-600" role="alert">{form.error}</p>{/if}
		{#if !data.linksData}
			<p class="card p-4 text-sm text-muted-foreground">Not fetched yet. It is read once a week with the key you already connected, or press Refresh now.</p>
		{:else if !data.linksData.report}
			<p class="card p-4 text-sm text-muted-foreground">The last attempt failed: {data.linksData.error}. It will retry within a day.</p>
		{:else}
			{@const r = data.linksData.report}
			{#if r.malware.length}
				<p class="mb-3 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm" role="alert"><b>Bing flags malware on {r.malware.length} page{r.malware.length === 1 ? '' : 's'}.</b> <span class="pii">{r.malware.slice(0, 3).map(path).join(', ')}</span>. Check them first.</p>
			{/if}
			<p class="mb-3 text-sm">{r.headline}</p>
			<div class="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
				<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Inbound links</div><div class="tnum text-xl font-semibold">{fmtInt(r.totals.links)}</div><div class="text-xs text-muted-foreground">to {fmtInt(r.totals.pagesWithLinks)} pages{r.totals.truncated ? ' (first part)' : ''}</div></div>
				<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Not found (4xx)</div><div class="tnum text-xl font-semibold">{fmtInt(r.issueCounts.gone)}</div></div>
				<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Server errors (5xx)</div><div class="tnum text-xl font-semibold">{fmtInt(r.issueCounts.error)}</div></div>
				<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Blocked to Bing</div><div class="tnum text-xl font-semibold">{fmtInt(r.issueCounts.blocked)}</div></div>
			</div>
			<Explainer lead="Pages that fail but still have links pointing at them waste those links.">
				Redirect each missing page to its closest live page (the suggestion matches the words in the address) so the links count again. A server error needs fixing rather than redirecting. This is Bing's view: a small or new site may have few links in it, and Bing can take days to drop an address you have fixed. Fetched {ago(data.linksData.fetchedAt)}.
			</Explainer>
			<div class="mt-3 grid grid-cols-1 gap-6 lg:grid-cols-2">
				<div>
					<h3 class="mb-1 text-sm font-medium">Failing pages that still have links</h3>
					{#if r.dead.length}
						<div class="card overflow-x-auto"><table class="w-full text-sm">
							<thead><tr class="text-left text-xs text-muted-foreground"><th class="p-2">Page</th><th class="p-2">Problem</th><th class="p-2 text-right">Links</th><th class="p-2">Redirect to</th></tr></thead>
							<tbody>{#each r.dead.slice(0, 25) as d (d.url)}
								<tr class="border-t"><td class="pii max-w-[16rem] truncate p-2" title={d.url}>{path(d.url)}</td><td class="p-2">{KIND[d.kind]} ({d.httpCode})</td><td class="tnum p-2 text-right">{fmtInt(d.inLinks)}</td><td class="pii max-w-[14rem] truncate p-2" title={d.redirectTo ?? ''}>{d.redirectTo ? path(d.redirectTo) : d.kind === 'error' ? 'Fix the error' : 'No close match: pick one'}</td></tr>
							{/each}</tbody>
						</table></div>
					{:else}
						<p class="card p-3 text-sm text-muted-foreground">None. Every failing page Bing found has no links pointing at it.</p>
					{/if}
				</div>
				<div>
					<h3 class="mb-1 text-sm font-medium">Most linked pages</h3>
					<div class="card overflow-x-auto"><table class="w-full text-sm">
						<thead><tr class="text-left text-xs text-muted-foreground"><th class="p-2">Page</th><th class="p-2 text-right">Links</th></tr></thead>
						<tbody>{#each r.mostLinked.slice(0, 10) as m (m.url)}<tr class="border-t"><td class="pii max-w-[22rem] truncate p-2" title={m.url}>{path(m.url)}</td><td class="tnum p-2 text-right">{fmtInt(m.count)}</td></tr>{/each}</tbody>
					</table></div>
				</div>
			</div>
		{/if}
	</section>
{/if}
