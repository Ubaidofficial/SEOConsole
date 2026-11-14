<script lang="ts">
	import { enhance } from '$app/forms';
	import Explainer from '$lib/components/Explainer.svelte';
	import { ago, fmtInt, fmtPct, shortUrl } from '$lib/format';
	let { data, form } = $props();
	let busy = $state('');
	let n = $state(10);
	const serpN = $derived(data.serp ? Math.max(1, Math.min(n || 1, data.serp.available, data.serpMax)) : 0);
	const s = $derived(data.stored);
	const vtone: Record<string, string> = { crowded: 'text-warn', mismatch: 'text-warn', both: 'text-bad', ok: 'text-good', unclear: 'text-muted-foreground' };
	const run = (name: string) => () => { busy = name; return async ({ update }: { update: () => Promise<void> }) => { await update(); busy = ''; }; };
</script>

<Explainer lead="Three checks that use OpenSEO's paid data: the results pages you rank on, who beats you, and links to pages that no longer work.">
	<p>Nothing here is sent to OpenSEO until you press a button, and each button says what it will ask. The prices are OpenSEO's own, read from its tool descriptions: about 5 credits for a results page at its usual depth (the depth used here is not priced separately, so 5 is shown as an upper bound) and about 30 for a page of backlinks. For the competitor tools OpenSEO only says "charges credits", so no price is shown; check its balance after the first run. The numbers come from a third-party data provider, not from Google. Results are stored, so reading them again is free, and agents can read them over MCP (<code>get_research_findings</code>) without spending anything.</p>
</Explainer>

{#if !data.linked}
	<div class="card p-6 text-center text-sm"><p class="mb-1 font-medium">This site is not linked to an OpenSEO project.</p><p class="text-muted-foreground">Connect OpenSEO on the <a class="underline" href="/connect">Connect page</a>; each site is matched to its project by domain.</p></div>
{:else}
	{#if form?.ok}<p class="mb-3 text-sm text-good">{form.ok}</p>{/if}
	{#if form?.error}<p class="mb-3 text-sm text-bad">{form.error}</p>{/if}

	<section class="card mb-4 p-4" id="serp">
		<div class="flex flex-wrap items-center gap-2">
			<h2 class="font-medium">Results pages: does your page fit?</h2>
			{#if s.serp}<span class="chip">checked {ago(s.serp.fetchedAt)}</span>{/if}
		</div>
		<p class="mt-1 text-sm text-muted-foreground">Looks up the results pages of searches you rank for but get few clicks on, and checks what sits above the first organic result and what kind of page most results are.</p>
		{#if data.serp && data.serp.keywords.length}
			<form method="POST" action="?/serp" use:enhance={run('serp')} class="mt-2 flex flex-wrap items-center gap-2 text-xs">
				<label class="flex items-center gap-1.5">Searches <input class="input w-20" type="number" name="n" min="1" max={Math.min(data.serpMax, data.serp.available)} bind:value={n} /></label>
				<button class="btn btn-primary !h-8 text-xs" disabled={busy === 'serp'}>{busy === 'serp' ? 'Looking up…' : `Look up ${serpN} results pages, up to about ${serpN * data.serp.perKeyword} credits`}</button>
			</form>
			<details class="mt-1 text-xs text-muted-foreground"><summary class="cursor-pointer">Which searches</summary><p class="pii mt-1">{data.serp.keywords.map((k) => k.keyword).join(' · ')}</p></details>
		{:else}<p class="mt-2 text-xs text-muted-foreground">No search qualifies yet (top 15 with at least 50 impressions).</p>{/if}
		{#if s.serp}
			<p class="mt-3 text-sm">{s.serp.asked} looked up: {s.serp.summary.crowded + s.serp.summary.both} with features above the first result, {s.serp.summary.mismatch + s.serp.summary.both} with a format mismatch, {s.serp.summary.ok} fine{#if s.serp.failed}, {s.serp.failed} could not be read{/if}.</p>
			<div class="mt-2 overflow-x-auto"><table class="w-full text-sm"><thead><tr><th class="th">Search</th><th class="th text-right">Pos.</th><th class="th text-right">Impr.</th><th class="th text-right">Clicks</th><th class="th">Verdict</th><th class="th">What the page looks like</th></tr></thead><tbody>
				{#each s.serp.checks as c}
					<tr><td class="td pii max-w-60 truncate" title={c.keyword}>{c.keyword}</td><td class="td tnum text-right">{c.position ?? '–'}</td><td class="td tnum text-right">{fmtInt(c.impressions)}</td><td class="td tnum text-right">{fmtInt(c.clicks)}</td><td class="td"><span class="font-medium {vtone[c.verdict]}">{data.labels.verdict[c.verdict]}</span></td><td class="td pii text-xs text-muted-foreground">{c.note}{#if c.pageFormat} <span class="opacity-80">(your page: {data.labels.format[c.pageFormat].toLowerCase()})</span>{/if}</td></tr>
				{/each}
			</tbody></table></div>
			<p class="mt-1 text-xs text-muted-foreground">Results are judged from their titles, in English only. A fine verdict does not mean the page is good; a bad one does not prove why people do not click.</p>
		{/if}
	</section>

	<section class="card mb-4 p-4" id="gap">
		<div class="flex flex-wrap items-center gap-2"><h2 class="font-medium">Who beats you, and what you are missing</h2>{#if s.gap}<span class="chip">checked {ago(s.gap.fetchedAt)}</span>{/if}</div>
		<p class="mt-1 text-sm text-muted-foreground">Finds the sites that rank for your searches, skips big platforms, studies the three most visible, and lists keywords they rank for that you have no search for or trail on.</p>
		{#if data.gap && data.gap.keywords.length}
			<form method="POST" action="?/gap" use:enhance={run('gap')} class="mt-2"><button class="btn btn-primary !h-8 text-xs" disabled={busy === 'gap'}>{busy === 'gap' ? 'Comparing…' : `Compare on ${data.gap.keywords.length} searches (${data.gap.calls} OpenSEO calls, price not stated)`}</button></form>
			<p class="mt-1 text-xs text-muted-foreground">{data.gap.note}</p>
		{:else}<p class="mt-2 text-xs text-muted-foreground">No searches at positions 4 to 40 with enough impressions yet.</p>{/if}
		{#if s.gap}
			<p class="pii mt-3 text-xs text-muted-foreground">Studied: {s.gap.studied.length ? s.gap.studied.join(', ') : 'none (every competitor found was a platform)'}. Compared on {s.gap.keywordsUsed} of your searches.</p>
			{#if s.gap.rows.length}
				<div class="mt-2 overflow-x-auto"><table class="w-full text-sm"><thead><tr><th class="th">Keyword</th><th class="th">Kind</th><th class="th text-right">Volume</th><th class="th text-right">KD</th><th class="th text-right">Their rank</th><th class="th text-right">Yours</th><th class="th">Fits your niche</th><th class="th">Competitor</th></tr></thead><tbody>
					{#each s.gap.rows as r}
						<tr><td class="td pii max-w-64 truncate" title={r.keyword}>{r.keyword}</td><td class="td">{r.kind === 'missing' ? 'No search of yours' : 'You are behind'}</td><td class="td tnum text-right">{fmtInt(r.volume)}</td><td class="td tnum text-right">{r.kd ?? '–'}</td><td class="td tnum text-right">{r.competitorRank}</td><td class="td tnum text-right">{r.ownPosition ?? '–'}</td><td class="td">{r.fit === 'core' ? 'Core' : r.fit === 'adjacent' ? 'Adjacent' : r.fit === 'off' ? 'Off-niche' : '–'}</td><td class="td pii text-xs text-muted-foreground">{r.competitor}</td></tr>
					{/each}
				</tbody></table></div>
				<p class="mt-1 text-xs text-muted-foreground">Volume and rank come from OpenSEO's data provider. A competitor being on this list does not mean you can beat it: look at what it has that you lack before writing anything.</p>
			{:else}<p class="mt-2 text-sm">No gaps found among the competitors studied.</p>{/if}
		{/if}
	</section>

	<section class="card mb-4 p-4" id="backlinks">
		<div class="flex flex-wrap items-center gap-2"><h2 class="font-medium">Backlinks: what you have, and links to dead pages</h2>{#if s.backlinks}<span class="chip">checked {ago(s.backlinks.fetchedAt)}</span>{/if}</div>
		<p class="mt-1 text-sm text-muted-foreground">Reads your link profile and lists links from other sites to pages of yours that no longer work, with the closest live page to redirect each to. Spam-scored links are never recommended.</p>
		{#if data.backlinks}
			<form method="POST" action="?/backlinks" use:enhance={run('backlinks')} class="mt-2"><button class="btn btn-primary !h-8 text-xs" disabled={busy === 'backlinks'}>{busy === 'backlinks' ? 'Reading…' : `Read ${data.backlinks.target}'s backlinks, about ${data.backlinks.credits} credits`}</button></form>
		{/if}
		{#if s.backlinks}
			<p class="pii mt-3 text-sm">{s.backlinks.profile.headline}</p>
			<p class="text-xs text-muted-foreground">{s.backlinks.profile.dofollow} followed, {s.backlinks.profile.nofollow} nofollow, {s.backlinks.profile.spammy} scored as spam, {s.backlinks.profile.lost} lost{#if s.backlinks.partial}; only the first {s.backlinks.sample.length ? '200' : ''} were read{/if}. {s.backlinks.deadKnown} dead pages were known when this ran (run the link crawl and check on the Content health tab first for a fuller list).</p>
			{#if s.backlinks.reclaim.length}
				<div class="mt-2 overflow-x-auto"><table class="w-full text-sm"><thead><tr><th class="th">Dead page</th><th class="th text-right">Links</th><th class="th text-right">Followed</th><th class="th">Redirect it to</th><th class="th">Why it counts as dead</th></tr></thead><tbody>
					{#each s.backlinks.reclaim as r}
						<tr><td class="td pii max-w-64 truncate" title={r.target}>{shortUrl(r.target)}</td><td class="td tnum text-right">{r.links.length}</td><td class="td tnum text-right">{r.dofollow}</td><td class="td pii max-w-64 truncate" title={r.redirectTo ?? ''}>{r.redirectTo ? shortUrl(r.redirectTo) : 'No close match: pick one by hand'}{#if r.redirectTo} <span class="text-xs text-muted-foreground">({fmtPct(r.match, 0)} word match)</span>{/if}</td><td class="td text-xs text-muted-foreground">{r.why}</td></tr>
					{/each}
				</tbody></table></div>
			{:else}<p class="mt-2 text-sm">No links to dead pages found.</p>{/if}
		{/if}
	</section>
{/if}
