<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusPill from '$lib/components/StatusPill.svelte';
	import { CalendarPlus, ChartLine, Plus, RefreshCw } from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import { ago } from '$lib/format';
	let { data, form } = $props();
	const tone: Record<string, 'bad' | 'warn' | 'muted'> = { core: 'bad', spam: 'warn', discover: 'muted', other: 'muted' };
</script>

<PageHeader page="/updates" level={1} title="Google ranking updates" lead="Google's ranking updates, marked on every chart and flagged on any SEO test they overlap.">
	<p>Core, spam and Discover updates are marked on every site's chart and flagged on any SEO test that overlaps one, because an update can move a section of a site for reasons unrelated to your change.
	The list is read from Google's own <a class="underline" href="https://status.search.google.com/" target="_blank" rel="noreferrer noopener">Search Status Dashboard</a> once a day. That dashboard keeps only recent history, so the app keeps every update it has seen; add older ones by hand.
	Dates are the UTC date of Google's timestamp; Search Console days are Pacific time, so an update can look a day off.</p>
	{#snippet meta()}<span class="text-xs text-muted-foreground">{data.checkedAt ? 'last checked ' + ago(data.checkedAt) : 'not checked yet'}</span>{/snippet}
	{#snippet actions()}<form method="POST" action="?/import" use:enhance><button class="btn btn-primary btn-sm"><RefreshCw class="size-3.5" />Check Google now</button></form>{/snippet}
</PageHeader>

<section class="card mb-5 p-4">
	{#if form?.ok}<p class="mb-3 text-sm text-good">{form.ok}</p>{/if}{#if form?.error}<p class="mb-3 text-sm text-bad">{form.error}</p>{/if}
	<div class="mb-2 flex items-center gap-2"><span class="ibadge ibadge-sm tone-blue" aria-hidden="true"><CalendarPlus class="size-3.5" /></span><h2 class="text-sm font-medium">Add an older update</h2></div>
	<form method="POST" action="?/add" use:enhance class="flex flex-wrap items-end gap-2">
		<label class="text-xs text-muted-foreground">Name<input class="input mt-1 block w-72" name="name" placeholder="e.g. March 2025 core update" required /></label>
		<label class="text-xs text-muted-foreground">Started<input class="input mt-1 block" type="date" name="begin" required /></label>
		<label class="text-xs text-muted-foreground">Finished (optional)<input class="input mt-1 block" type="date" name="end" /></label>
		<button class="btn"><Plus class="size-3.5" />Add</button>
	</form>
</section>

<div class="card overflow-x-auto">
	<table class="w-full">
		<thead><tr><th class="th">Update</th><th class="th">Type</th><th class="th">Started</th><th class="th">Finished</th><th class="th">Source</th><th class="th relative"><span class="sr-only">Actions</span></th></tr></thead>
		<tbody>
			{#each data.updates as u (u.id)}
				<tr>
					<td class="td font-medium">{u.name}</td><td class="td text-xs"><StatusPill tone={tone[u.kind] ?? 'muted'}>{u.kind}</StatusPill></td>
					<td class="td tnum text-xs">{u.begin}</td><td class="td tnum text-xs">{#if u.end}{u.end}{:else}<StatusPill tone="info" pulse>rolling out</StatusPill>{/if}</td>
					<td class="td text-xs text-muted-foreground">{u.source === 'google' ? 'Google' : 'added by hand'}</td>
					<td class="td text-right">{#if u.source === 'manual'}<form method="POST" action="?/remove" use:enhance><input type="hidden" name="id" value={u.id} /><ConfirmButton title="Remove this update?" description="Only your own entry is removed." confirmLabel="Remove">Remove</ConfirmButton></form>{/if}</td>
				</tr>
			{:else}<tr><td class="td" colspan="6"><EmptyState compact icon={ChartLine} title="No updates stored yet." text="Check Google now to read the recent ones from Google's Search Status Dashboard." /></td></tr>{/each}
		</tbody>
	</table>
</div>
