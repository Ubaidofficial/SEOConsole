<script lang="ts">
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { enhance } from '$app/forms';
	import { fmtInt } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusPill from '$lib/components/StatusPill.svelte';
	import SiteAvatar from '$lib/components/SiteAvatar.svelte';
	import { Map as MapIcon, Plug, Send } from '@lucide/svelte';
	let { data, form } = $props();
	let busy = $state(false);
	type Row = Awaited<typeof data.rows>[number];
	const urlsOf = (r: Row) => r.sitemaps.reduce((a, s) => a + (s.contents ?? []).reduce((b, c) => b + Number(c.submitted ?? 0), 0), 0);
</script>

<PageHeader page="/sitemaps" level={1} title="Sitemaps across all sites" lead="Every site's sitemaps as Search Console lists them, with their warnings and errors.">
	{#snippet actions()}
		<form method="POST" action="?/resubmitAll" use:enhance={() => { busy = true; return async ({ update }) => { await update(); busy = false; }; }}>
			<ConfirmButton class="btn btn-primary btn-sm" destructive={false} title="Resubmit every known sitemap?" description="This asks Google to re-read every sitemap of every site. It does not guarantee faster indexing." confirmLabel="Resubmit all"><Send class="size-3.5" />{busy ? 'Resubmitting…' : 'Resubmit all'}</ConfirmButton>
		</form>
	{/snippet}
</PageHeader>
{#if form?.summary}<p class="mb-3 text-sm text-good">{form.summary}</p>{/if}
{#if form?.error}<p class="mb-3 text-sm text-bad">{form.error}</p>{/if}

{#await data.rows}
	<div class="card divide-y">
		{#each Array(6) as _}
			<div class="flex items-center gap-4 p-3"><Skeleton class="h-4 w-48" /><Skeleton class="h-4 w-24" /><Skeleton class="ml-auto h-4 w-40" /></div>
		{/each}
	</div>
	<p class="mt-2 text-xs text-muted-foreground">Asking Search Console about every property…</p>
{:then rows}
	{@const max = Math.max(1, ...rows.map(urlsOf))}
	{#if rows.length === 0}
		<EmptyState icon={MapIcon} title="No sites to ask about yet." text="Sitemaps are read from Search Console for every verified property of a connected Google account.">
			<a class="btn btn-primary btn-sm" href="/connect"><Plug class="size-3.5" />Connect your data</a>
		</EmptyState>
	{:else}
	<div class="card overflow-x-auto">
		<table class="w-full">
			<thead><tr><th class="th">Site</th><th class="th">Sitemaps</th><th class="th text-right">URLs submitted</th><th class="th text-right">Warnings</th><th class="th text-right">Errors</th><th class="th">Last read</th></tr></thead>
			<tbody>
				{#each rows as r (r.id)}
					{@const urls = urlsOf(r)}
					{@const warn = r.sitemaps.reduce((a, s) => a + Number(s.warnings ?? 0), 0)}
					{@const err = r.sitemaps.reduce((a, s) => a + Number(s.errors ?? 0), 0)}
					{@const last = r.sitemaps.map((s) => s.lastDownloaded ?? '').sort().pop()}
					<tr>
						<td class="td"><div class="flex items-center gap-2"><SiteAvatar name={r.name} siteId={r.id} class="!size-5 !rounded-md !text-[10px]" /><a class="pii hover:underline" href="/sites/{r.id}/sitemaps">{r.name}</a></div></td>
						{#if r.error}
							<td class="td text-bad" colspan="5">{r.error}</td>
						{:else}
							<td class="td">{#if r.sitemaps.length}{r.sitemaps.length}{:else}<StatusPill tone="warn">none submitted</StatusPill>{/if}</td>
							<td class="td tnum cellbar text-right" style="--w:{urls / max}">{fmtInt(urls)}</td>
							<td class="td tnum text-right {warn ? 'text-warn' : ''}">{warn}</td>
							<td class="td tnum text-right {err ? 'text-bad' : ''}">{err}</td>
							<td class="td tnum">{last ? last.slice(0, 10) : '–'}</td>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{/if}
{/await}
