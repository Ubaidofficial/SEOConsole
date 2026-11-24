<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import { Bell, Database, FolderTree, History, LoaderCircle, Plug, SlidersHorizontal, Tag, TriangleAlert } from '@lucide/svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import StatusPill from '$lib/components/StatusPill.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { page as nav } from '$app/state';
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import { enhance } from '$app/forms';
	import { fmtInt, ago } from '$lib/format';
	import { SYNC_RUNS_EXPLAIN, syncModeLabel } from '$lib/explain';
	let { data: page, form } = $props();
	let saving = $state(false);
	const base = $derived(`/sites/${nav.params.id}`);
	/**
	 * Settings, grouped as onsite.so does: this page's own sections first (jump links), then the settings that live on other tabs,
	 * so everything that configures a site can be found from here.
	 */
	const SECTIONS = $derived([
		['Site', [['#general', 'General', SlidersHorizontal], ['#brand', 'Brand and tags', Tag]]],
		['Data', [['#stored', 'Stored data', Database], ['#syncs', 'Recent syncs', History]]],
		['Organise', [[`${base}/groups`, 'Groups and buckets', FolderTree], [`${base}/alerts`, 'Alert rules', Bell]]],
		['Connections', [['/connect', 'Sources and keys', Plug]]],
		['', [['#danger', 'Danger zone', TriangleAlert]]]
	] as const);
</script>

{#if form?.ok}<p class="mb-3 text-sm text-good">{form.ok}</p>{/if}
{#if form?.error}<p class="mb-3 text-sm text-bad">{form.error}</p>{/if}

<PageHeader tab="/settings" title="Settings" lead="This site's name, tags and brand terms, the data stored for it, and where its other settings live." />

<div class="grid grid-cols-1 gap-6 lg:grid-cols-[13rem_1fr]">
<nav class="lg:sticky lg:top-20 lg:self-start" aria-label="Settings sections">
	<ul class="flex gap-1 overflow-x-auto lg:block lg:space-y-4">
		{#each SECTIONS as [caption, items]}
			<li class="shrink-0">
				{#if caption}<div class="mb-1 hidden px-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase lg:block">{caption}</div>{/if}
				<ul class="flex gap-1 lg:block lg:space-y-0.5">
					{#each items as [href, label, Icon]}
						<li><a {href} class="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] whitespace-nowrap hover:bg-accent {href === '#danger' ? 'text-bad' : 'text-muted-foreground hover:text-foreground'}"><Icon class="size-3.5 shrink-0" />{label}{#if !href.startsWith('#')}<span class="ml-auto text-[10px] opacity-60" aria-hidden="true">↗</span>{/if}</a></li>
					{/each}
				</ul>
			</li>
		{/each}
	</ul>
</nav>
<div class="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
	<section id="general" class="card scroll-mt-20 p-4">
		<h3 class="mb-3 flex items-center gap-2 font-medium"><span class="ibadge ibadge-sm tone-gray" aria-hidden="true"><SlidersHorizontal class="size-3.5" /></span>Site preferences{#if page.site?.hidden}<StatusPill tone="warn">hidden</StatusPill>{/if}</h3>
		<form method="POST" action="?/save" use:enhance={() => { saving = true; return async ({ update }) => { await update({ reset: false }); saving = false; }; }} class="space-y-4 text-sm">
			<label class="block"><span class="text-xs text-muted-foreground">Display name</span><input class="input w-full" name="label" value={page.site?.label ?? ''} /></label>
			<label id="brand" class="block scroll-mt-20"><span class="text-xs text-muted-foreground">Tags (comma separated)</span><input class="input w-full" name="tags" value={page.site?.tags ?? ''} /></label>
			<label class="block"><span class="text-xs text-muted-foreground">Brand terms (comma separated; used to split branded vs non-branded)</span><input class="input w-full" name="brand" value={page.site?.brandTerms ?? ''} /></label>
			<label class="flex items-center gap-2"><input type="checkbox" name="hidden" checked={page.site?.hidden} /> Hide from dashboard and stop scheduled syncs</label>
			<button class="btn btn-primary" disabled={saving}>{#if saving}<LoaderCircle class="size-4 animate-spin" />Saving…{:else}Save changes{/if}</button>
		</form>
	</section>

	<section id="stored" class="card scroll-mt-20 p-4 text-sm">
		<h3 class="mb-3 flex items-center gap-2 font-medium"><span class="ibadge ibadge-sm tone-blue" aria-hidden="true"><Database class="size-3.5" /></span>Stored data</h3>
		<p class="tnum">{fmtInt(page.stored.days)} days of totals · {fmtInt(page.stored.detail)} query/page rows</p>
		<p class="mt-1 text-xs text-muted-foreground">Per-day detail is capped at {fmtInt(page.maxRowsPerDay)} rows (MAX_ROWS_PER_DAY). Long-tail rows beyond the cap are not stored; totals are always complete.</p>
		<form method="POST" action="?/resync" use:enhance class="mt-3">
			<ConfirmButton class="btn" destructive={false} title="Reset and re-pull history?" description="The locally stored data for this site is deleted and downloaded again from Google. This can take a while." confirmLabel="Reset and re-pull">Reset &amp; re-pull history</ConfirmButton>
		</form>
	</section>

	<section id="syncs" class="card scroll-mt-20 overflow-x-auto xl:col-span-2">
		<h3 class="flex items-center gap-2 p-4 pb-1 font-medium"><span class="ibadge ibadge-sm tone-blue" aria-hidden="true"><History class="size-3.5" /></span>Recent syncs</h3>
		<div class="px-4 pb-2"><Explainer lead="Each run re-pulls the newest days, and pulls more history until it is complete."><p>{SYNC_RUNS_EXPLAIN}</p></Explainer></div>
		<table class="w-full">
			<thead><tr><th class="th">Started</th><th class="th">Mode</th><th class="th text-right">Days</th><th class="th text-right">Rows</th><th class="th">Result</th></tr></thead>
			<tbody>
				{#each page.runs as r}
					<tr>
						<td class="td">{ago(r.started_at)}</td><td class="td">{syncModeLabel(r.mode)}</td>
						<td class="td tnum text-right">{r.days}</td><td class="td tnum text-right">{fmtInt(r.rows)}</td>
						<td class="td">{#if r.error}<StatusPill tone="bad">failed</StatusPill> <span class="text-xs text-bad">{r.error}</span>{:else if !r.finished_at}<StatusPill tone="info" pulse>running</StatusPill>{:else}<StatusPill tone="good">ok</StatusPill>{#if r.truncated_days}<span class="ml-1 text-xs text-muted-foreground">{r.truncated_days} day(s) capped</span>{/if}{/if}</td>
					</tr>
				{:else}<tr><td colspan="5"><EmptyState compact icon={History} title="No syncs yet." text="The first sync starts by itself a moment after a site is added." /></td></tr>{/each}
			</tbody>
		</table>
	</section>

	<section id="danger" class="card scroll-mt-20 p-4 text-sm xl:col-span-2" style="border-color:var(--bad)">
		<h3 class="mb-1 flex items-center gap-2 font-medium text-bad"><span class="ibadge ibadge-sm tone-red" aria-hidden="true"><TriangleAlert class="size-3.5" /></span>Danger zone</h3>
		<p class="mb-3 text-xs text-muted-foreground">Removes this property from Google Search Console itself, for every user of it. Google cannot undo this from here; the stored history stays restorable under Recently removed on the dashboard for 14 days.</p>
		<form method="POST" action="?/removeProperty" use:enhance class="flex flex-wrap gap-2">
			<input class="input w-80" name="confirm" aria-label="Type the site name to confirm" placeholder="Type the site name to confirm" />
			<button class="btn btn-danger">Remove from Search Console</button>
		</form>
	</section>
</div>
</div>
