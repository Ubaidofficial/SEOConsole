<script lang="ts">
	import { enhance } from '$app/forms';
	import Explainer from '$lib/components/Explainer.svelte';
	import { fmtInt, fmtPct, shortUrl } from '$lib/format';
	let { data, form } = $props();
	const pub = $derived(data.publishing);
	const n = $derived(data.niche);
	const l = $derived(data.links);
	const vtone: Record<string, string> = { working: 'text-good', stalled: 'text-bad', slow: 'text-warn', too_new: 'text-muted-foreground', small: 'text-muted-foreground' };
	const groups = $derived([{ title: 'Broken', list: l.broken, detour: false }, { title: 'Through a redirect', list: l.redirected, detour: true }]);
	const stone: Record<string, string> = { winning: 'text-good', 'ranks-no-clicks': 'text-warn', 'reach-only': 'text-bad', minor: 'text-muted-foreground' };
</script>

<Explainer lead="Is what you publish being shown, what is your site actually good at, and are your own links sound?">
	<p>Three checks from data the app already holds, before you publish more or build links. <b>Publishing</b> compares your sitemap with what Search Console showed in 90 days, by section and by age. <b>Niche</b> groups your searches into topics and separates the ones that earn clicks from the ones where you are only shown far down. <b>Links</b> lists broken internal links and links that go through a redirect.</p>
	<p>"Shown" means at least one impression; Search Console's query data leaves out anonymised and very rare searches, so a "never shown" page is one to inspect, not proof it is not indexed. Topics are searches that share a word, not meanings. Thresholds are this app's own rules of thumb.</p>
</Explainer>

<section class="card mb-4 p-4" id="publishing">
	<h2 class="font-medium">Publishing: is it being shown?</h2>
	{#if !pub.historyComplete}<p class="mt-1 text-sm text-warn">The last 90 days of Search Console history are still being downloaded, so "shown" counts below are too low and no verdict should be trusted yet.</p>{/if}
	<p class="pii mt-1 text-sm">{pub.headline}</p>
	{#if pub.buildStamp}<p class="mt-1 text-xs text-warn">{fmtPct(pub.buildStamp.share, 0)} of the dated sitemap URLs share the date {pub.buildStamp.date}: that is a build stamp, so page age below is unknown for them and "too new" is never granted to them.</p>{/if}
	{#if pub.sections.length}
		<div class="mt-3 overflow-x-auto"><table class="w-full text-sm"><thead><tr><th class="th">Section</th><th class="th text-right">Pages</th><th class="th text-right">Shown</th><th class="th text-right">Clicks</th><th class="th text-right">Clicks / page</th><th class="th text-right" title="From the stored URL Inspection sample">Indexed of checked</th><th class="th text-right">noindex</th><th class="th">Verdict</th></tr></thead><tbody>
			{#each pub.sections.slice(0, 20) as s (s.folder)}
				<tr><td class="td pii">{s.folder}</td><td class="td tnum text-right">{fmtInt(s.urls)}</td><td class="td tnum text-right">{fmtInt(s.shown)} <span class="text-xs text-muted-foreground">({fmtPct(s.shownShare, 0)})</span></td><td class="td tnum text-right">{fmtInt(s.clicks)}</td><td class="td tnum text-right">{s.clicksPerUrl.toFixed(2)}</td><td class="td tnum text-right">{s.inspected ? `${s.indexed} of ${s.inspected}` : '–'}</td><td class="td tnum text-right">{s.noindex || '–'}</td><td class="td"><span class="font-medium {vtone[s.verdict]}" title={s.advice}>{data.labels.verdict[s.verdict]}</span></td></tr>
			{/each}
		</tbody></table></div>
		<details class="mt-2 text-xs text-muted-foreground"><summary class="cursor-pointer">What to do about each verdict</summary>
			<ul class="mt-1 space-y-1">{#each pub.sections.filter((s) => s.verdict === 'stalled' || s.verdict === 'slow') as s}<li class="pii"><b class="text-foreground">{s.folder}</b>: {s.advice}{#if s.reasons.length} Google's reasons in the sample: {s.reasons.map((r) => `${r.reason} (${r.count})`).join(', ')}.{/if}</li>{/each}</ul>
		</details>
		<h3 class="mb-1 mt-4 text-sm font-medium">By age of page</h3>
		<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr><th class="th">Age</th><th class="th text-right">Pages</th><th class="th text-right">Shown</th><th class="th text-right">Clicks</th></tr></thead><tbody>
			{#each pub.cohorts.filter((c) => c.urls) as c}<tr><td class="td">{c.bucket}</td><td class="td tnum text-right">{fmtInt(c.urls)}</td><td class="td tnum text-right">{fmtInt(c.shown)} <span class="text-xs text-muted-foreground">({fmtPct(c.shownShare, 0)})</span></td><td class="td tnum text-right">{fmtInt(c.clicks)}</td></tr>{/each}
		</tbody></table></div>
		<p class="mt-1 text-xs text-muted-foreground">{pub.velocity.last30} pages with a trustworthy date were touched in the last 30 days, {pub.velocity.last90} in 90 ({pub.velocity.known} of {pub.totals.urls} pages have one).</p>
	{/if}
</section>

<section class="card mb-4 p-4" id="niche">
	<h2 class="font-medium">Niche: what you actually win</h2>
	<p class="pii mt-1 text-sm">{n.headline}</p>
	{#if n.topics.length}
		<div class="mt-3 overflow-x-auto"><table class="w-full text-sm"><thead><tr><th class="th">Topic</th><th class="th">Status</th><th class="th text-right">Searches</th><th class="th text-right">Clicks</th><th class="th text-right">Impressions</th><th class="th text-right">Position</th><th class="th">Examples</th></tr></thead><tbody>
			{#each n.topics as t (t.topic)}
				<tr><td class="td pii font-medium">{t.topic}</td><td class="td"><span class="{stone[t.status]}" title={data.labels.advice[t.status]}>{data.labels.status[t.status]}</span></td><td class="td tnum text-right">{fmtInt(t.queries)}</td><td class="td tnum text-right">{fmtInt(t.clicks)}</td><td class="td tnum text-right">{fmtInt(t.impressions)}</td><td class="td tnum text-right">{t.position.toFixed(1)}</td><td class="td pii max-w-72 truncate text-xs text-muted-foreground" title={t.examples.join(' · ')}>{t.examples.join(' · ')}</td></tr>
			{/each}
		</tbody></table></div>
	{/if}
	<form method="GET" class="mt-4 text-xs">
		<label class="mb-1 block font-medium" for="kw">Score a list of candidate keywords against what already wins (one per line)</label>
		<textarea id="kw" name="kw" rows="4" class="input w-full max-w-xl" placeholder="elon musk book recommendations&#10;best fiction books">{n.kw}</textarea>
		<div class="mt-1"><button class="btn btn-sm">Score them</button></div>
	</form>
	{#if n.candidates.length}
		<table class="mt-3 w-full text-sm"><thead><tr><th class="th">Keyword</th><th class="th">Fit</th><th class="th text-right">Score</th><th class="th">Note</th></tr></thead><tbody>
			{#each n.candidates as c}<tr><td class="td pii">{c.keyword}</td><td class="td">{data.labels.fit[c.fit]}</td><td class="td tnum text-right">{c.score.toFixed(2)}</td><td class="td text-xs text-muted-foreground">{c.note}</td></tr>{/each}
		</tbody></table>
	{/if}
</section>

<section class="card mb-4 p-4" id="links">
	<div class="flex flex-wrap items-center gap-2">
		<h2 class="font-medium">Links: broken or detoured</h2>
		<form method="POST" action="?/verifyLinks" use:enhance class="ml-auto"><button class="btn btn-sm" disabled={!l.uncheckedTotal} title="Fetches up to {data.verifyMax} link targets from your own site">Check {Math.min(l.uncheckedTotal, data.verifyMax)} unchecked link targets</button></form>
	</div>
	<p class="pii mt-1 text-sm">{l.headline}</p>
	{#if !l.pagesCrawled}<p class="mt-1 text-xs text-muted-foreground">The crawl is on the <a class="underline" href="links">Internal links</a> tab.</p>{/if}
	{#if form?.ok}<p class="mt-2 text-xs text-good">{form.ok}</p>{/if}
	{#if form?.error}<p class="mt-2 text-xs text-bad">{form.error}</p>{/if}
	{#each groups as g (g.title)}
		{#if g.list.length}
			<h3 class="mb-1 mt-3 text-sm font-medium">{g.title}</h3>
			<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr><th class="th">Link target</th><th class="th text-right">Status</th><th class="th text-right">Pages linking</th><th class="th">From (first)</th></tr></thead><tbody>
				{#each g.list as t}
					<tr><td class="td pii max-w-72 truncate" title={t.target}>{t.target}{#if t.finalUrl && g.detour}<span class="text-xs text-muted-foreground"> → {shortUrl(t.finalUrl)}</span>{/if}</td><td class="td tnum text-right">{t.status || '–'}</td><td class="td tnum text-right">{t.sources.length}</td><td class="td pii max-w-72 truncate text-xs text-muted-foreground" title={t.sources[0].page}>{shortUrl(t.sources[0].page)}{#if t.sources[0].anchor} · “{t.sources[0].anchor}”{/if}</td></tr>
				{/each}
			</tbody></table></div>
		{/if}
	{/each}
	<p class="mt-2 text-xs text-muted-foreground">The crawl keeps only the final address after redirects, so chains of several redirects cannot be counted. A 401, 403 or 429 answer is not called broken: a site's own bot protection often answers a crawler that way.</p>
</section>

<section class="card mb-4 p-4" id="notfound">
	<h2 class="font-medium">Not-found pages visitors reach</h2>
	{#if !data.notFound.ga4}
		<p class="mt-1 text-xs text-muted-foreground">Needs GA4: pages are found by the title GA4 records for them (“404”, “Page not found” and the same in six more languages). <a class="underline" href="analytics">Link GA4</a>.</p>
	{:else if !data.notFound.rows.length}
		<p class="mt-1 text-sm text-muted-foreground">No page GA4 saw in the last 28 days has a not-found title.</p>
		<p class="mt-1 text-xs text-muted-foreground">If your 404 page has an ordinary title, it cannot be found this way.</p>
	{:else}
		<p class="mt-1 text-sm">{data.notFound.rows.length} address{data.notFound.rows.length === 1 ? '' : 'es'} answered “not found”{#if data.notFound.rows.some((r) => r.likelyInvented)}; <b>{data.notFound.rows.filter((r) => r.likelyInvented).length}</b> look made up by an AI assistant{/if}.</p>
		<div class="mt-2 overflow-x-auto"><table class="w-full text-sm">
			<thead><tr><th class="th">Address</th><th class="th text-right">Views</th><th class="th text-right" title="Sessions an AI assistant sent here (GA4 referrer)">From AI</th><th class="th">Known to</th><th class="th"></th></tr></thead>
			<tbody>
				{#each data.notFound.rows.slice(0, 40) as r (r.path)}
					<tr>
						<td class="td pii max-w-96 truncate" title={r.title}>{r.path}</td>
						<td class="td tnum text-right">{r.views}</td>
						<td class="td tnum text-right" title={r.assistants.join(', ')}>{r.ai || '–'}{#if r.assistants.length} <span class="text-xs text-muted-foreground">{r.assistants.join(', ')}</span>{/if}</td>
						<td class="td text-xs text-muted-foreground">{[r.inSearch ? 'Google' : '', r.inSitemap ? 'sitemap' : ''].filter(Boolean).join(', ') || 'neither'}</td>
						<td class="td text-xs">{#if r.likelyInvented}<span class="text-bad">likely made up by AI: redirect it</span>{:else if r.inSitemap}<span class="text-warn">in a sitemap: fix or remove</span>{/if}</td>
					</tr>
				{/each}
			</tbody>
		</table></div>
		<p class="mt-2 text-xs text-muted-foreground">“Likely made up” means an AI assistant sent visits here and neither Google nor a sitemap has ever known the address. Redirect it to the page it meant.</p>
	{/if}
</section>
