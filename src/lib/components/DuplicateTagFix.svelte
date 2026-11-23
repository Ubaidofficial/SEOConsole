<script lang="ts">
	/**
	 * "Pause the duplicate Google tag": two or more active tags load GA4 for the same measurement ID. Preview first (read live from Tag Manager),
	 * then one confirming click: a new workspace with only the duplicates paused (nothing deleted), published only when that is safe and asked for.
	 */
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	// Local types: client code never imports from $lib/server.
	type Brief = { tagId: string; name: string; firing: string[] };
	type Plan = { ok: boolean; error?: string; needsGrant?: boolean; container?: { path: string; publicId: string; name: string }; groups?: { measurementId: string; keep: Brief; pause: Brief[] }[]; canPublish?: boolean; publishBlocked?: string };
	type Result = { ok: boolean; error?: string; published: boolean; reviewUrl?: string; versionId?: string; paused?: string[] };
	let { dup, form, inline = false }: { dup: { show: boolean; canWrite: boolean; account: string | null; readOnly: boolean }; form: { dupPlan?: Plan; dupResult?: Result } | null | undefined; inline?: boolean } = $props();
	let busy = $state('');
	const back = $derived(`/sites/${page.params.id}/tags`);
	const plan = $derived(form?.dupPlan);
	const result = $derived(form?.dupResult);
	const done = (name: string) => () => {
		busy = name;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			busy = '';
		};
	};
	const on = (t: Brief) => (t.firing.length ? t.firing.join(', ') : 'nothing');
</script>

{#if dup.show || result}
	<svelte:element this={inline ? 'div' : 'section'} class={inline ? 'mt-2' : 'card mb-4 p-4'} aria-labelledby={inline ? undefined : 'dup-h'}>
		{#if !inline}<h2 id="dup-h" class="font-medium">Pause the duplicate Google tag</h2>{/if}
		{#if result?.ok}
			<p class="mt-2 text-sm text-good">{result.published ? `Done: version ${result.versionId ?? ''} is published with ${result.paused?.join(', ') ?? 'the duplicate'} paused.` : 'The change is ready in a new workspace. Open it in Tag Manager, check it, then Submit and Publish.'}</p>
			<p class="mt-1 text-xs text-muted-foreground">{result.published ? 'To check: open Preview in Tag Manager and confirm one Google tag fires per page. Unpausing the tag undoes this.' : 'Nothing is live until you publish it.'}{#if result.reviewUrl}<a class="ml-1 underline" href={result.reviewUrl} target="_blank" rel="noreferrer noopener">Open in Tag Manager</a>{/if}</p>
		{:else}
			<p class="mt-1 text-xs text-muted-foreground" class:hidden={inline}>More than one active tag loads GA4 for the same ID, so page views may be counted twice. SEOConsole can pause the extra ones in a new workspace, after showing you which. Nothing is deleted, and nothing changes until you confirm.</p>
			{#if dup.readOnly}
				<p class="mt-2 text-xs text-warn">This server runs with READ_ONLY=1, so it never changes Tag Manager.</p>
			{:else if !dup.canWrite}
				<p class="mt-2 mb-2 text-xs text-muted-foreground">SEOConsole can read this container but not edit it. Allow it once{dup.account ? ` with ${dup.account}` : ''}.</p>
				<a class="btn btn-primary text-xs" href="/auth/connect?grant=gtm-write&back={encodeURIComponent(back)}">Allow SEOConsole to edit Tag Manager</a>
			{:else}
				<form method="POST" action="?/duplicatePlan" use:enhance={done('plan')} class="mt-2"><button class="btn text-xs" disabled={!!busy}>{busy === 'plan' ? 'Reading Tag Manager…' : inline ? 'Fix it: preview first' : 'Preview the fix'}</button></form>
			{/if}
			{#if result && !result.ok}<p class="mt-2 text-xs text-bad" role="alert">{result.error}</p>{/if}
			{#if plan && !plan.ok}
				<p class="mt-2 text-xs text-bad" role="alert">{plan.error}</p>
				{#if plan.needsGrant}<a class="btn mt-2 text-xs" href="/auth/connect?grant=gtm-write&back={encodeURIComponent(back)}">Allow SEOConsole to edit Tag Manager</a>{/if}
			{:else if plan?.ok && !result?.ok}
				<div class="mt-3 rounded-md border bg-muted/40 p-3 text-xs" role="region" aria-label="Preview of the Tag Manager change">
					<p class="mb-2 font-medium text-foreground">This will change</p>
					<dl class="grid grid-cols-[7rem_1fr] gap-y-1">
						<dt class="text-muted-foreground">Container</dt><dd>{plan.container?.publicId}{plan.container?.name ? ` · ${plan.container.name}` : ''}</dd>
						{#each plan.groups ?? [] as g (g.measurementId)}
							<dt class="text-muted-foreground">Keep</dt><dd>“{g.keep.name}” on {on(g.keep)} <span class="font-mono">({g.measurementId})</span></dd>
							{#each g.pause as t (t.tagId)}<dt class="text-muted-foreground">Pause</dt><dd>“{t.name}” on {on(t)}</dd>{/each}
						{/each}
						<dt class="text-muted-foreground">Workspace</dt><dd>a new one, “SEOConsole pause duplicate Google tag”. Your other workspaces are not touched.</dd>
					</dl>
					<form method="POST" action="?/duplicateApply" use:enhance={done('apply')} class="mt-3 flex flex-wrap gap-2">
						<button class="btn btn-primary text-xs" name="mode" value="publish" disabled={!plan.canPublish || !!busy}>{busy === 'apply' ? 'Working…' : 'Pause and publish'}</button>
						<button class="btn text-xs" name="mode" value="workspace" disabled={!!busy}>Pause, I'll publish in Tag Manager</button>
					</form>
					{#if !plan.canPublish && plan.publishBlocked}<p class="mt-2 text-muted-foreground">{plan.publishBlocked}</p>{/if}
				</div>
			{/if}
		{/if}
	</svelte:element>
{/if}
