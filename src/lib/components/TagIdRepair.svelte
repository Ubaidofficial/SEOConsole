<script lang="ts">
	/**
	 * "Fix the Tag ID": a Google tag has text that is not an ID in its Tag ID field (a whole pasted gtag.js snippet is the usual cause).
	 * Preview first (read live from Tag Manager), then one confirming click: a new workspace with only that field corrected, published only when
	 * that is safe and asked for. Same consent, preview and confirmation as the Clarity install.
	 */
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	// Local types, like the Clarity component: client code never imports from $lib/server.
	type RepairTag = { tagId: string; name: string; type: string; current: string; paused: boolean; firing: string[]; candidates: { id: string; from: 'inside' | 'property' }[]; recommended: string | null };
	type RepairPlan = { ok: boolean; error?: string; needsGrant?: boolean; container?: { path: string; publicId: string; name: string }; tags?: RepairTag[]; canPublish?: boolean; publishBlocked?: string };
	type Result = { ok: boolean; error?: string; published: boolean; reviewUrl?: string; versionId?: string };
	let { repair, form }: { repair: { show: boolean; canWrite: boolean; account: string | null; readOnly: boolean }; form: { plan?: RepairPlan; result?: Result; fixedId?: string } | null | undefined } = $props();
	let busy = $state('');
	const back = $derived(`/sites/${page.params.id}/tags`);
	const plan = $derived(form?.plan);
	const result = $derived(form?.result);
	const done = (name: string) => () => {
		busy = name;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			busy = '';
		};
	};
</script>

{#if repair.show || result}
	<section class="card mb-4 p-4" aria-labelledby="repair-h">
		<h2 id="repair-h" class="font-medium">Fix the Tag ID</h2>
		{#if result?.ok}
			<p class="mt-2 text-sm text-good">{result.published ? `Done: version ${result.versionId ?? ''} is published with the corrected Tag ID.` : 'The corrected tag is ready in a new workspace. Open it in Tag Manager, check it, then Submit and Publish.'}</p>
			<p class="mt-1 text-xs text-muted-foreground">{result.published ? 'Google Analytics should start receiving visits within a few minutes: check GA4 Realtime. This page catches up after the next Tag Manager sync.' : 'Nothing is live until you publish it.'}{#if result.reviewUrl}<a class="ml-1 underline" href={result.reviewUrl} target="_blank" rel="noreferrer noopener">Open in Tag Manager</a>{/if}</p>
		{:else}
			<p class="mt-1 text-xs text-muted-foreground">A Google tag in the live container has text that is not an ID where its Tag ID belongs, so it cannot send anything to Google Analytics. SEOConsole can correct just that field, in a new workspace, after showing you exactly what will change. Nothing changes until you confirm.</p>
			{#if repair.readOnly}
				<p class="mt-2 text-xs text-warn">This server runs with READ_ONLY=1, so it never changes Tag Manager.</p>
			{:else if !repair.canWrite}
				<p class="mt-2 mb-2 text-xs text-muted-foreground">SEOConsole can read this container but not edit it. Allow it once{repair.account ? ` with ${repair.account}` : ''}: Google will ask to let SEOConsole edit, version and publish your Tag Manager containers.</p>
				<a class="btn btn-primary text-xs" href="/auth/connect?grant=gtm-write&back={encodeURIComponent(back)}">Allow SEOConsole to edit Tag Manager</a>
			{:else}
				<form method="POST" action="?/repairPlan" use:enhance={done('plan')} class="mt-2"><button class="btn text-xs" disabled={!!busy}>{busy === 'plan' ? 'Reading Tag Manager…' : 'Preview the fix'}</button></form>
			{/if}
			{#if result && !result.ok}<p class="mt-2 text-xs text-bad" role="alert">{result.error}</p>{/if}
			{#if plan && !plan.ok}
				<p class="mt-2 text-xs text-bad" role="alert">{plan.error}</p>
				{#if plan.needsGrant}<a class="btn mt-2 text-xs" href="/auth/connect?grant=gtm-write&back={encodeURIComponent(back)}">Allow SEOConsole to edit Tag Manager</a>{/if}
			{:else if plan?.ok && !result?.ok}
				{#each plan.tags ?? [] as t (t.tagId)}
					<div class="mt-3 rounded-md border bg-muted/40 p-3 text-xs" role="region" aria-label="Preview of the Tag Manager change">
						<p class="mb-2 font-medium text-foreground">This will change</p>
						<dl class="grid grid-cols-[7rem_1fr] gap-y-1">
							<dt class="text-muted-foreground">Container</dt><dd>{plan.container?.publicId}{plan.container?.name ? ` · ${plan.container.name}` : ''}</dd>
							<dt class="text-muted-foreground">Tag</dt><dd>“{t.name}”{t.paused ? ' (paused)' : ''}, fires on {t.firing.length ? t.firing.join(', ') : 'nothing'}</dd>
							<dt class="text-muted-foreground">Tag ID now</dt><dd class="pii break-all font-mono">{t.current}{t.current.length >= 120 ? '…' : ''}</dd>
							<dt class="text-muted-foreground">Workspace</dt><dd>a new one, “SEOConsole fix Tag ID”. Nothing else in the tag changes.</dd>
						</dl>
						<form method="POST" action="?/repairApply" use:enhance={done('apply')} class="mt-3">
							<input type="hidden" name="tagId" value={t.tagId} />
							<fieldset class="mb-2">
								<legend class="mb-1 font-medium text-foreground">Set the Tag ID to</legend>
								{#each t.candidates as c (c.id)}
									<label class="mb-0.5 flex items-center gap-2"><input type="radio" name="newId" value={c.id} checked={t.recommended === c.id} required={!t.recommended} /><span class="font-mono">{c.id}</span><span class="text-muted-foreground">{c.from === 'inside' ? 'found inside the pasted text' : 'your linked GA4 property'}</span></label>
								{/each}
								<label class="mt-1 flex items-center gap-2"><span class="text-muted-foreground">or another measurement ID</span><input class="input w-44 font-mono" name="otherId" placeholder="G-XXXXXXXXXX" pattern="[Gg]-[A-Za-z0-9]{'{'}4,{'}'}" autocomplete="off" /></label>
								{#if !t.recommended && t.candidates.length}<p class="mt-1 text-warn">The ID inside the text is not your linked GA4 property's, so pick the one you mean.</p>{/if}
							</fieldset>
							<div class="flex flex-wrap gap-2">
								<button class="btn btn-primary text-xs" name="mode" value="publish" disabled={!plan.canPublish || !!busy}>{busy === 'apply' ? 'Working…' : 'Fix and publish'}</button>
								<button class="btn text-xs" name="mode" value="workspace" disabled={!!busy}>Fix, I'll publish in Tag Manager</button>
							</div>
						</form>
						{#if !plan.canPublish && plan.publishBlocked}<p class="mt-2 text-muted-foreground">{plan.publishBlocked}</p>{/if}
					</div>
				{/each}
			{/if}
		{/if}
	</section>
{/if}
