<script lang="ts">
	import Chart from '$lib/components/Chart.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import Delta from '$lib/components/Delta.svelte';
	import Explainer from '$lib/components/Explainer.svelte';
	import SectionTabs from '$lib/components/SectionTabs.svelte';
	import { enhance } from '$app/forms';
	import { fmtInt, fmtPct, ago } from '$lib/format';
	let { data, form } = $props();
	let busy = $state(false);
	let view = $state('');
	let pqBusy = $state(false);
	let pqPage = $state('');
	let pqForm: HTMLFormElement | undefined = $state();
	const pq = $derived(form && 'pageQueries' in form ? form.pageQueries : null);
	const showQueries = (r: { term: string }) => {
		pqPage = r.term;
		queueMicrotask(() => pqForm?.requestSubmit());
	};
	const CODE_LABEL: Record<string, string> = { '2xx': 'OK (2xx)', '301': 'Moved (301)', '302': 'Temporary (302)', '4xx': 'Not found (4xx)', '5xx': 'Server error (5xx)', other: 'Other' };
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
	<details class="mb-4 text-xs text-muted-foreground"><summary class="cursor-pointer select-none hover:text-foreground">Where these numbers come from</summary><p class="mt-1">Daily totals come from Bing's traffic endpoint (updated daily; includes web, chat, news, images, videos from 24 Mar 2023). Query and page tables use Bing's detail endpoints, which Microsoft documents as <b>updated weekly</b>, so they lag the totals and are aggregated from weekly rows.</p></details>
	<SectionTabs bind:value={view} label="Bing details" tabs={[
		{ id: 'queries', label: 'Queries' },
		{ id: 'pages', label: 'Pages' },
		{ id: 'crawl', label: 'Crawling' },
		{ id: 'sitemaps', label: 'Sitemaps', count: data.crawl?.feeds.length ?? null },
		{ id: 'links', label: 'Inbound links' }
	]} />
	{#if view === 'queries'}
			<section><h2 class="sr-only">Top queries</h2><DataTable rows={data.queries} cols={cols('Query')} sortKey="clicks" pageSize={15} /></section>
	{:else if view === 'pages'}
		<section>
			<h2 class="sr-only">Top pages</h2>
			<DataTable rows={data.pages} cols={cols('Page', true)} sortKey="clicks" pageSize={15} onRowClick={showQueries} />
			<p class="mt-1 text-xs text-muted-foreground">Click a row to see the searches that showed that page.</p>
		</section>
	<form method="POST" action="?/pageQueries" bind:this={pqForm} class="hidden" use:enhance={() => { pqBusy = true; return async ({ update }) => { await update({ reset: false }); pqBusy = false; }; }}>
		<input type="hidden" name="page" value={pqPage} />
	</form>
	{#if pqBusy || pq || (form && 'pqError' in form)}
		<section class="mt-4" aria-live="polite">
			<h2 class="mb-1 font-medium">Searches for <span class="pii">{path(pq?.page ?? pqPage)}</span></h2>
			{#if pqBusy}
				<p class="text-xs text-muted-foreground">Asking Bing…</p>
			{:else if form && 'pqError' in form}
				<p class="text-xs text-warn" role="alert">{form.pqError}</p>
			{:else if pq && !pq.queries.length}
				<p class="text-xs text-muted-foreground">Bing lists no searches for this page in this period{pq.weeksInBing ? '' : ', or at all'}. Bing updates this weekly.</p>
			{:else if pq}
				<p class="mb-2 text-xs text-muted-foreground">Read live from Bing, summed over this period's weekly rows.</p>
				<DataTable rows={pq.queries} cols={[{ key: 'query', label: 'Query', type: 'text', pii: true }, { key: 'clicks', label: 'Clicks', type: 'int', bar: true }, { key: 'impressions', label: 'Impressions', type: 'int' }, { key: 'ctr', label: 'CTR', type: 'pct' }, { key: 'position', label: 'Avg position', type: 'pos' }]} sortKey="clicks" pageSize={15} />
			{/if}
		</section>
	{/if}
	{:else if view === 'crawl'}
	<section id="crawl">
		<h2 class="sr-only">How Bing crawls the site</h2>
		{#if !data.crawl}
			<p class="card p-4 text-sm text-muted-foreground">Read on the next Bing sync.</p>
		{:else}
			{@const c = data.crawl}
			{#if c.crawlError}<p class="mb-2 text-xs text-warn">Bing's crawl statistics could not be read on the last sync: {c.crawlError}</p>{/if}
			{#if c.totals}
				{@const t = c.totals}
				<div class="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
					<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Pages in Bing's index</div><div class="tnum text-xl font-semibold">{fmtInt(t.inIndex)}</div>{#if t.inIndexBefore != null && t.inIndex != null}<div class="text-xs text-muted-foreground">{t.inIndex - t.inIndexBefore >= 0 ? '+' : ''}{fmtInt(t.inIndex - t.inIndexBefore)} in this period</div>{/if}</div>
					<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Pages crawled</div><div class="tnum text-xl font-semibold">{fmtInt(t.crawled)}</div></div>
					<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Crawl errors</div><div class="tnum text-xl font-semibold {t.crawlErrors ? 'text-bad' : ''}">{fmtInt(t.crawlErrors)}</div></div>
					<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Blocked by robots.txt</div><div class="tnum text-xl font-semibold">{fmtInt(t.blockedByRobots)}</div></div>
				</div>
				<div class="card mb-3 p-4"><Chart data={c.days.map((x) => ({ date: x.date, clicks: x.crawled, impressions: x.errors, position: 0 }))} hide={['position']} labels={{ clicks: 'Pages crawled', impressions: 'Crawl errors' }} /></div>
				<p class="mb-2 text-xs text-muted-foreground">
					Status codes Bing got: {Object.entries(t.codes).filter(([, v]) => v > 0).map(([k, v]) => `${CODE_LABEL[k]} ${fmtInt(v)}`).join(' · ') || 'none recorded'}{t.dnsFailures || t.timeouts ? ` · DNS failures ${fmtInt(t.dnsFailures)} · timeouts ${fmtInt(t.timeouts)}` : ''}{t.malware ? ` · malware flagged ${fmtInt(t.malware)}` : ''}. Bing keeps about six months.
				</p>
			{:else}
				<p class="mb-3 text-sm text-muted-foreground">Bing has no crawl statistics for this period.</p>
			{/if}
		{/if}
	</section>
	{:else if view === 'sitemaps'}
		{#if data.crawl}
			{@const c = data.crawl}
			<h2 class="sr-only">Sitemaps Bing knows</h2>
			{#if c.feedsError}<p class="mb-2 text-xs text-warn">Bing's sitemap list could not be read on the last sync: {c.feedsError}</p>{/if}
			{#if c.sentBySeoConsole}
				{@const m = c.sentBySeoConsole}
				<p class="mb-2 text-xs {m.failed.length ? 'text-warn' : 'text-muted-foreground'}">
					{#if m.submitted.length}Sent to Bing by SEOConsole on {m.day}: {m.submitted.map(path).join(', ')}.{/if}
					{#if m.failed.length}Bing refused {m.failed.map((f) => path(f.path)).join(', ')} on {m.day}: {m.failed[0].error} It is tried again tomorrow.{/if}
				</p>
			{/if}
			{#if c.feeds.length}
				<div class="card overflow-x-auto"><table class="w-full text-sm">
					<thead><tr class="text-left text-xs text-muted-foreground"><th class="p-2">Sitemap</th><th class="p-2">Status</th><th class="p-2 text-right">URLs</th><th class="p-2">Last read by Bing</th><th class="p-2">Submitted</th></tr></thead>
					<tbody>{#each c.feeds as f (f.url)}
						<tr class="border-t"><td class="pii max-w-[20rem] truncate p-2" title={f.url}>{path(f.url)}</td><td class="p-2 {/fail|error/i.test(f.status) ? 'text-bad' : ''}">{f.status || '–'}</td><td class="tnum p-2 text-right">{fmtInt(f.urlCount)}</td><td class="p-2">{f.lastCrawled ?? 'never'}</td><td class="p-2">{f.submitted ?? '–'}</td></tr>
					{/each}</tbody>
				</table></div>
			{:else if !c.feedsError}
				<p class="card p-3 text-sm text-muted-foreground">Bing lists no sitemaps for this site yet. SEOConsole sends it the sitemaps Search Console has on each Bing sync.</p>
			{/if}
		{:else}
			<p class="card p-4 text-sm text-muted-foreground">Read on the next Bing sync.</p>
		{/if}
	{:else}
	<section id="links">
		<div class="mb-2 flex flex-wrap items-center gap-2">
			<h2 class="font-medium">Inbound links Bing knows about</h2>
			<form method="POST" action="?/refreshLinks" class="ml-auto" use:enhance={() => { busy = true; return async ({ update }) => { await update(); busy = false; }; }}>
				<button class="btn btn-sm" disabled={busy || data.readOnly}>{busy ? 'Fetching…' : 'Refresh now'}</button>
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
{/if}
