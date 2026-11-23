<script lang="ts">
	import { ago, fmtInt } from '$lib/format';
	import TagIdRepair from '$lib/components/TagIdRepair.svelte';
	import DuplicateTagFix from '$lib/components/DuplicateTagFix.svelte';
	import KeyEventSetup from '$lib/components/KeyEventSetup.svelte';
	let { data, form } = $props();
	const tone = { critical: 'text-bad', warning: 'text-warn', info: 'text-muted-foreground' } as const;
	const icon = { critical: '✕', warning: '⚠', info: 'ℹ' } as const;
	/** Problems first; info notes are shown smaller underneath. */
	const problems = $derived(data.findings.filter((f) => f.severity !== 'info'));
	const notes = $derived(data.findings.filter((f) => f.severity === 'info'));
	const active = $derived(data.snapshot ? data.snapshot.tags.filter((t) => !t.paused).length : 0);
	// The one-click fixes sit inside the finding they fix. A finished fix stays visible even once its finding has gone.
	const hasFinding = (id: string) => data.findings.some((f) => f.id === id);
	const f = $derived(form as Record<string, unknown> | null | undefined);
	const keyEventOpen = $derived(!!(f && ('keFound' in f || 'kePlan' in f || 'keResult' in f)));
</script>

{#if !data.linked}
	<div class="card mb-4 p-6 text-center"><p class="mb-3">No Tag Manager container is linked to this site yet.</p><a class="btn btn-primary" href="/connect">Connect Tag Manager</a></div>
{:else}
	<div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
		<div class="card px-3 py-2">
			<div class="text-xs text-muted-foreground">Container</div>
			<div class="pii truncate text-sm font-medium" title={data.container ?? ''}>{data.snapshot?.publicId ?? data.container}</div>
			<div class="truncate text-xs text-muted-foreground">{data.status?.state === 'error' ? data.status.message : 'read ' + ago(data.status?.lastSync ?? null)}</div>
		</div>
		<div class="card px-3 py-2">
			<div class="text-xs text-muted-foreground">Live version</div>
			<div class="text-sm font-medium">{data.snapshot?.published ? `v${data.snapshot.versionId}` : 'Never published'}</div>
			<div class="truncate text-xs text-muted-foreground" title={data.snapshot?.versionName ?? ''}>{data.snapshot?.versionName ?? ''}</div>
		</div>
		<div class="card px-3 py-2">
			<div class="text-xs text-muted-foreground">Tags</div>
			<div class="tnum text-sm font-medium">{active} active</div>
			<div class="text-xs text-muted-foreground">{data.snapshot ? `${data.snapshot.counts.tags - active} paused · ${data.snapshot.counts.triggers} triggers` : ''}</div>
		</div>
		<div class="card px-3 py-2" title="Last {data.window.days} days. Sessions and clicks are different measurements: a prompt to look, not proof.">
			<div class="text-xs text-muted-foreground">Last {data.window.days} days</div>
			<div class="tnum text-sm font-medium">{fmtInt(data.window.clicks)} clicks · {data.window.ga4 == null ? '–' : fmtInt(data.window.ga4)} sessions</div>
			<div class="text-xs text-muted-foreground">Search Console · GA4 organic</div>
		</div>
	</div>
{/if}

<section class="card mb-4 p-4" aria-labelledby="attention-h">
	<h2 id="attention-h" class="mb-2 font-medium">{problems.length ? `${problems.length} thing${problems.length > 1 ? 's' : ''} to fix` : 'Tracking health'}</h2>
	{#if problems.length}
		<ul class="divide-y" style="border-color:var(--border)">
			{#each problems as p (p.id)}
				<li class="flex gap-3 py-3 first:pt-0 last:pb-0">
					<span class="mt-0.5 {tone[p.severity]}" aria-label={p.severity}>{icon[p.severity]}</span>
					<div class="min-w-0 flex-1">
						<div class="text-sm font-medium">{p.title}</div>
						<details class="text-xs text-muted-foreground"><summary class="cursor-pointer select-none hover:text-foreground">Why it matters and what to do</summary><p class="mt-1">{p.detail}</p></details>
						{#if p.id === 'gtm-duplicate-google-tag'}<DuplicateTagFix dup={data.duplicate} {form} inline />{/if}
						{#if p.id === 'gtm-tag-id-malformed'}<TagIdRepair repair={data.repair} {form} inline />{/if}
					</div>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-sm text-good">{data.sources.gtm || data.sources.ga4 ? 'No problems found.' : 'Nothing to check yet: link GA4 and a Tag Manager container on the Connect page.'}</p>
	{/if}
	{#if !hasFinding('gtm-duplicate-google-tag') && f && 'dupResult' in f}<DuplicateTagFix dup={data.duplicate} {form} inline />{/if}
	{#if !hasFinding('gtm-tag-id-malformed') && f && 'result' in f}<TagIdRepair repair={data.repair} {form} inline />{/if}
	{#if notes.length}
		<ul class="mt-3 space-y-1 border-t pt-3 text-xs text-muted-foreground" style="border-color:var(--border)">
			{#each notes as n (n.id)}<li class="flex gap-2"><span aria-hidden="true">{icon.info}</span><span><span class="text-foreground">{n.title}.</span> {n.detail}</span></li>{/each}
		</ul>
	{/if}
</section>

{#if data.snapshot}
	<section class="card mb-4 overflow-x-auto" aria-labelledby="tags-h">
		<h2 id="tags-h" class="px-4 pt-3 font-medium">Tags in the live version</h2>
		<table class="w-full">
			<thead><tr><th class="th">Tag</th><th class="th">Type</th><th class="th">Fires on</th><th class="th">GA4 ID / event</th><th class="th">State</th></tr></thead>
			<tbody>
				{#each data.snapshot.tags as t (t.id || t.name)}
					<tr>
						<td class="td">{t.name}{#if t.duplicate}<span class="ml-2 rounded-full border px-1.5 text-[10px] text-warn" style="border-color:var(--warn)" title="Loads GA4 for an ID another active tag already loads">duplicate</span>{/if}</td>
						<td class="td text-xs">{t.typeLabel}</td>
						<td class="td text-xs">{t.firing.length ? t.firing.join(', ') : '–'}{#if t.blocking.length}<div class="text-muted-foreground">blocked by {t.blocking.join(', ')}</div>{/if}</td>
						<td class="td text-xs">{t.measurementId ?? ''}{t.eventName ? ' · ' + t.eventName : ''}</td>
						<td class="td text-xs {t.paused ? 'text-warn' : 'text-good'}">{t.paused ? 'paused' : 'active'}</td>
					</tr>
				{:else}<tr><td class="td text-muted-foreground" colspan="5">{data.snapshot.published ? 'The live version has no tags.' : 'Nothing is published, so nothing runs.'}</td></tr>{/each}
			</tbody>
		</table>
	</section>
{/if}

{#if data.linked}
	<details class="card group mb-4" open={keyEventOpen}>
		<summary class="flex cursor-pointer list-none items-center justify-between gap-3 p-4 select-none [&::-webkit-details-marker]:hidden">
			<span><span class="font-medium">Track an event as a key event</span> <span class="block text-xs text-muted-foreground">Send a sign-up or other dataLayer event to GA4 and count it as a conversion.</span></span>
			<span class="text-xs text-muted-foreground group-open:hidden">Open</span><span class="hidden text-xs text-muted-foreground group-open:inline">Close</span>
		</summary>
		<div class="px-4 pb-4"><KeyEventSetup access={data.keyEvent} {form} bare /></div>
	</details>
{/if}
