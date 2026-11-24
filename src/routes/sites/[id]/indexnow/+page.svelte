<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusPill from '$lib/components/StatusPill.svelte';
	import { KeyRound, Download, ShieldCheck, RefreshCw, Send, Zap, ZapOff, History, LoaderCircle, Map as MapIcon, Inbox } from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import { ago } from '$lib/format';
	let { data, form } = $props();
	const s = $derived(data.status);
	const verified = $derived(s.hosts.filter((h) => h.ok).length);
	let busy = $state(false);
	// A failed action (a verification that did not pass) does not reload the page's data by itself, so reload it: otherwise the row still says "not checked yet".
	const run = () => { busy = true; return async ({ update }: { update: () => Promise<void> }) => { await update(); await invalidateAll(); busy = false; }; };
</script>

<PageHeader tab="/indexnow" title="IndexNow" lead="Tell Bing and other IndexNow engines the moment a page changes. Google does not take part.">
	<p>IndexNow is an open protocol: one notification reaches the engines that take part, instead of waiting for them to crawl. indexnow.org lists <b>Bing, Naver, Seznam.cz, Yandex and Yep</b>.
		<b class="text-foreground">Google does not take part in IndexNow</b>, so this does nothing for Google; for Google, your sitemap and the Indexing tab are what matter. And a notification is a hint: the engines say it does not guarantee indexing.</p>
	{#snippet meta()}{#if s.hasKey}<StatusPill tone={verified ? 'good' : 'warn'}>{verified ? `${verified} host${verified === 1 ? '' : 's'} verified` : 'no host verified'}</StatusPill>{/if}{#if s.hasKey && s.auto}<StatusPill tone="info">automatic</StatusPill>{/if}{/snippet}
</PageHeader>
<section class="card mb-4 p-4">
	<p class="text-sm">
		{#if s.clicks28d.bing == null}Bing is not connected here, so I cannot show how much traffic it sends you. <a class="underline" href="/connect">Connect Bing Webmaster</a> to see whether this is worth the effort.
		{:else}Over the last 28 days <b>Bing sent {s.clicks28d.bing.toLocaleString('en-US')} clicks against Google's {s.clicks28d.google.toLocaleString('en-US')}</b> ({s.clicks28d.bingShare != null ? (s.clicks28d.bingShare * 100).toFixed(1) : '0'}% of the two). {s.clicks28d.bingShare != null && s.clicks28d.bingShare < 0.05 ? 'A small share: IndexNow is cheap to set up, but do not expect much from it.' : 'Enough to make it worthwhile.'}{/if}
	</p>
</section>

{#if form?.ok}<p class="mb-3 text-sm text-good">{form.ok}</p>{/if}{#if form?.error}<p class="mb-3 text-sm text-bad">{form.error}</p>{/if}

<section class="card mb-4 p-4">
	<h3 class="mb-2 flex items-center gap-2 font-medium"><span class="ibadge ibadge-sm tone-green" aria-hidden="true"><KeyRound class="size-3.5" /></span>1 · Key</h3>
	{#if !s.hasKey}
		<p class="mb-2 text-sm text-muted-foreground">IndexNow proves you own a site with a key file you put on it. Create a key here, download the file, and upload it to the root of your site.</p>
		<form method="POST" action="?/createKey" use:enhance><button class="btn btn-primary btn-sm"><KeyRound class="size-3.5" />Create a key</button></form>
	{:else}
		<div class="flex flex-wrap items-center gap-3 text-sm"><code class="pii break-all rounded bg-black/5 px-2 py-1">{s.key}</code>
			<a class="btn btn-sm" href="/sites/{page.params.id}/indexnow/key.txt" download><Download class="size-3.5" />Download {s.key}.txt</a>
			<form method="POST" action="?/regenerate" use:enhance class="ml-auto"><ConfirmButton title="Make a new key?" description="The key file on your site must be replaced with the new one, and every host must be verified again." confirmLabel="New key">New key</ConfirmButton></form></div>
		<p class="mt-2 text-xs text-muted-foreground">Upload the file so that <code>https://your-host/{s.key}.txt</code> opens and shows exactly the key (UTF-8 text, nothing else). The key is not a password, but search engines expect it to stay yours.</p>
	{/if}
</section>

{#if s.hasKey}
	<section class="card mb-4 p-4">
		<div class="mb-2 flex items-center gap-3"><h3 class="flex items-center gap-2 font-medium"><span class="ibadge ibadge-sm tone-green" aria-hidden="true"><ShieldCheck class="size-3.5" /></span>2 · Verify the key file on each host</h3><form method="POST" action="?/verifyAll" use:enhance={run} class="ml-auto"><button class="btn btn-sm" disabled={busy}><RefreshCw class="size-3.5 {busy ? 'animate-spin' : ''}" />Check all</button></form></div>
		<div class="overflow-x-auto"><table class="w-full text-sm"><tbody>
			{#each s.hosts as h (h.host)}
				<tr><td class="td pii">{h.host}</td>
					<td class="td pii min-w-48 text-xs">{#if h.ok}<StatusPill tone="good">verified</StatusPill>{:else if h.verifiedAt}<StatusPill tone="bad">failed</StatusPill> <span class="text-muted-foreground">{h.message}</span>{:else}<StatusPill tone="muted">not checked yet</StatusPill>{/if}</td>
					<td class="td w-px"><form method="POST" action="?/verify" use:enhance={run}><input type="hidden" name="host" value={h.host} /><button class="btn btn-sm" disabled={busy}>Check</button></form></td></tr>
			{:else}<tr><td class="td"><EmptyState compact icon={MapIcon} title="No hosts known yet" text="Read the sitemaps on the Indexing tab."><a class="btn btn-primary btn-sm" href="/sites/{page.params.id}/indexing"><MapIcon class="size-3.5" />Open the Indexing tab</a></EmptyState></td></tr>{/each}
		</tbody></table></div>
		<p class="mt-2 text-xs text-muted-foreground">Each host (for example <code>example.com</code> and <code>www.example.com</code>) needs the file on itself. Only verified hosts can be submitted.</p>
	</section>

	<section class="card mb-4 p-4">
		<h3 class="mb-2 flex items-center gap-2 font-medium"><span class="ibadge ibadge-sm tone-green" aria-hidden="true"><Send class="size-3.5" /></span>3 · Submit</h3>
		<form method="POST" action="?/submit" use:enhance={run} class="mb-3">
			<textarea class="input h-24 w-full" name="urls" placeholder="Full URLs, one per line: pages you added, changed or removed (removed pages that return 404 or 410 should be reported too)"></textarea>
			<div class="mt-2 flex flex-wrap items-center gap-3"><button class="btn btn-primary btn-sm" disabled={busy || !verified}>{#if busy}<LoaderCircle class="size-3.5 animate-spin" />Sending…{:else}<Send class="size-3.5" />Submit to IndexNow{/if}</button>
				<label class="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" name="force" /> even if sent in the last 24 hours</label>
				{#if !verified}<span class="text-xs text-warn">Verify at least one host first.</span>{/if}</div>
		</form>
		<div class="flex flex-wrap gap-2">
			<form method="POST" action="?/presetRecent" use:enhance={run}><button class="btn btn-sm" disabled={busy || !verified || !data.presets.recent} title="Sitemap URLs whose date is within the last 7 days">Sitemap URLs from the last 7 days ({data.presets.recent})</button></form>
			<form method="POST" action="?/presetRemoved" use:enhance={run}><button class="btn btn-sm" disabled={busy || !verified || !data.presets.removed} title="Pages the indexing monitor saw return 404">Pages that now 404 ({data.presets.removed})</button></form>
		</div>
		<Explainer lead="Safeguards keep this from spamming the engines.">
	<p>Safeguards, because the protocol warns against spam: a URL is not resent within 24 hours (unless you force it), at most {s.dailyCap.toLocaleString('en-US')} URLs a day per site (<code>INDEXNOW_MAX_PER_DAY</code>), and nothing is sent for an hour after an engine says “too many requests”. Sent in the last 24 hours: <b>{s.usedToday.toLocaleString('en-US')}</b>.{#if s.backoffUntil} <b class="text-warn">Paused until {new Date(s.backoffUntil).toLocaleTimeString()}.</b>{/if}</p>
</Explainer>
		<form method="POST" action="?/auto" use:enhance class="mt-3 flex items-center gap-3 border-t pt-3" style="border-color:var(--border)">
			<input type="hidden" name="on" value={s.auto ? '0' : '1'} />
			<button class="btn btn-sm {s.auto ? '' : 'btn-primary'}">{#if s.auto}<ZapOff class="size-3.5" />Turn automatic submission off{:else}<Zap class="size-3.5" />Turn automatic submission on{/if}</button>
			<span class="text-xs text-muted-foreground">{s.auto ? 'On: after each sitemap read, new URLs and URLs whose date moved forward are sent.' : 'Off. When on, new and changed sitemap URLs are sent after each sitemap read (the first read only records a starting point). If a site stamps every URL with its build time, only genuinely new URLs are sent.'}</span>
		</form>
	</section>

	<section class="card p-4">
		<h3 class="mb-2 flex items-center gap-2 font-medium"><span class="ibadge ibadge-sm tone-gray" aria-hidden="true"><History class="size-3.5" /></span>Recent submissions</h3>
		<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr><th class="th">When</th><th class="th">Host</th><th class="th text-right">URLs</th><th class="th">Answer</th><th class="th">By</th></tr></thead><tbody>
			{#each s.recent as r}<tr><td class="td whitespace-nowrap text-xs text-muted-foreground">{ago(r.at)}</td><td class="td pii text-xs">{r.host}</td><td class="td tnum text-right">{r.urls}</td><td class="td text-xs"><StatusPill tone={r.status === 200 || r.status === 202 ? 'good' : 'bad'}>HTTP {r.status || '—'}</StatusPill> {r.message}</td><td class="td text-xs text-muted-foreground">{r.source === 'auto' ? 'automatic' : 'you'}</td></tr>
			{:else}<tr><td class="td" colspan="5"><EmptyState compact icon={Inbox} title="Nothing sent yet." /></td></tr>{/each}
		</tbody></table></div>
	</section>
{/if}
