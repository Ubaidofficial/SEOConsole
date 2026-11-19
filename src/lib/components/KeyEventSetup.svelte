<script lang="ts">
	/**
	 * "Track as a key event": the site pushes an event to the dataLayer (a sign-up, an application, a purchase) and GA4 should count it as a
	 * conversion. Preview first (read live from Tag Manager and GA4), then one confirming click: Data Layer Variables, a Custom Event trigger and
	 * a GA4 Event tag in a new workspace (published only when that is safe and asked for), then the key event in GA4. Same consent, preview and
	 * confirmation as the Tag ID fix.
	 */
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	// Local types: client code never imports from $lib/server.
	type Plan = { ok: boolean; error?: string; needsGrant?: 'gtm-write' | 'setup'; event?: string; params?: string[]; measurementId?: string; container?: { publicId: string }; changes?: string[]; alreadyTagged?: boolean; alreadyKeyEvent?: boolean | null; canMarkKeyEvent?: boolean; canPublish?: boolean; publishBlocked?: string };
	type Result = { ok: boolean; error?: string; published: boolean; reviewUrl?: string; versionId?: string; keyEvent?: 'marked' | 'already' | 'skipped' | 'failed'; keyEventError?: string; tagAlready?: boolean };
	type Input = { event: string; params: string[]; measurementId?: string };
	let { access, form }: { access: { canWrite: boolean; account: string | null; readOnly: boolean; ga4Linked: boolean }; form: { kePlan?: Plan; keResult?: Result; keInput?: Input } | null | undefined } = $props();
	let busy = $state('');
	const back = $derived(`/sites/${page.params.id}/tags`);
	const plan = $derived(form?.kePlan);
	const result = $derived(form?.keResult);
	const input = $derived(form?.keInput);
	const done = (name: string) => () => {
		busy = name;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			busy = '';
		};
	};
	const keyEventText = (r: Result) =>
		r.keyEvent === 'marked' ? 'GA4 now counts it as a key event.' : r.keyEvent === 'already' ? 'GA4 already counted it as a key event.' : r.keyEvent === 'failed' ? `Marking it as a key event failed: ${r.keyEventError}` : 'Mark it as a key event in GA4 (Admin → Key events), or allow SEOConsole to edit Google Analytics.';
</script>

<section class="card mb-4 p-4" aria-labelledby="ke-h">
	<h2 id="ke-h" class="font-medium">Track an event as a key event</h2>
	<p class="mt-1 text-xs text-muted-foreground">When your site pushes an event to the dataLayer (for example <code>job_alert_signup</code> after a sign-up), SEOConsole can add the Tag Manager variables, trigger and GA4 event tag that send it to Google Analytics, and mark it as a key event there. It shows exactly what will change first; nothing changes until you confirm.</p>
	{#if access.readOnly}
		<p class="mt-2 text-xs text-warn">This server runs with READ_ONLY=1, so it never changes Tag Manager or Google Analytics.</p>
	{:else if !access.canWrite}
		<p class="mt-2 mb-2 text-xs text-muted-foreground">SEOConsole can read this container but not edit it. Allow it once{access.account ? ` with ${access.account}` : ''}: Google will ask to let SEOConsole edit, version and publish your Tag Manager containers and edit Google Analytics.</p>
		<a class="btn btn-primary text-xs" href="/auth/connect?grant=setup&back={encodeURIComponent(back)}">Allow SEOConsole to edit Tag Manager and GA4</a>
	{:else}
		{#if result?.ok}
			<p class="mt-2 text-sm text-good" role="status">
				{result.tagAlready ? 'Tag Manager already sent this event to GA4.' : result.published ? `Done: version ${result.versionId ?? ''} is published with the GA4 event tag.` : 'The variables, trigger and tag are ready in a new workspace. Open it in Tag Manager, check it, then Submit and Publish.'}
				{keyEventText(result)}
			</p>
			<p class="mt-1 text-xs text-muted-foreground">Check it: trigger the event on your site (for example sign up for an alert), then look in GA4 → Reports → Realtime. Key events show in reports within a day.{#if result.reviewUrl}<a class="ml-1 underline" href={result.reviewUrl} target="_blank" rel="noreferrer noopener">Open in Tag Manager</a>{/if}</p>
		{/if}
		<form method="POST" action="?/keyEventPlan" use:enhance={done('plan')} class="mt-3 grid gap-2 text-xs sm:grid-cols-[1fr_2fr_1fr_auto] sm:items-end">
			<label class="grid gap-1"><span class="text-muted-foreground">dataLayer event name</span><input class="input font-mono" name="event" required placeholder="job_alert_signup" value={input?.event ?? ''} autocomplete="off" /></label>
			<label class="grid gap-1"><span class="text-muted-foreground">Parameters to send (optional, comma separated)</span><input class="input font-mono" name="params" placeholder="alert_form, alert_frequency" value={input?.params?.join(', ') ?? ''} autocomplete="off" /></label>
			<label class="grid gap-1"><span class="text-muted-foreground">Measurement ID (optional)</span><input class="input font-mono" name="measurementId" placeholder={access.ga4Linked ? 'from your GA4 property' : 'G-XXXXXXXXXX'} value={input?.measurementId ?? ''} autocomplete="off" /></label>
			<button class="btn text-xs" disabled={!!busy}>{busy === 'plan' ? 'Reading Tag Manager…' : 'Preview'}</button>
		</form>
		{#if result && !result.ok}<p class="mt-2 text-xs text-bad" role="alert">{result.error}</p>{/if}
		{#if plan && !plan.ok}
			<p class="mt-2 text-xs text-bad" role="alert">{plan.error}</p>
			{#if plan.needsGrant}<a class="btn mt-2 text-xs" href="/auth/connect?grant={plan.needsGrant}&back={encodeURIComponent(back)}">Allow SEOConsole to edit</a>{/if}
		{:else if plan?.ok && !result}
			<div class="mt-3 rounded-md border bg-muted/40 p-3 text-xs" role="region" aria-label="Preview of the changes">
				<p class="mb-2 font-medium text-foreground">This will change, in {plan.container?.publicId}{plan.alreadyTagged ? '' : ' (a new workspace)'}</p>
				<ul class="list-disc space-y-0.5 pl-4">{#each plan.changes ?? [] as c (c)}<li>{c}</li>{/each}</ul>
				{#if plan.needsGrant === 'setup'}<p class="mt-2"><a class="underline" href="/auth/connect?grant=setup&back={encodeURIComponent(back)}">Allow SEOConsole to edit Google Analytics</a> so it can mark the key event too.</p>{/if}
				<form method="POST" action="?/keyEventApply" use:enhance={done('apply')} class="mt-3 flex flex-wrap gap-2">
					<input type="hidden" name="event" value={plan.event} />
					<input type="hidden" name="params" value={plan.params?.join(',')} />
					<input type="hidden" name="measurementId" value={plan.measurementId} />
					{#if plan.alreadyTagged}
						<button class="btn btn-primary text-xs" name="mode" value="publish" disabled={!!busy || !plan.canMarkKeyEvent || !!plan.alreadyKeyEvent}>{busy === 'apply' ? 'Working…' : 'Mark as key event'}</button>
					{:else}
						<button class="btn btn-primary text-xs" name="mode" value="publish" disabled={!plan.canPublish || !!busy}>{busy === 'apply' ? 'Working…' : 'Create and publish'}</button>
						<button class="btn text-xs" name="mode" value="workspace" disabled={!!busy}>Create, I'll publish in Tag Manager</button>
					{/if}
				</form>
				{#if !plan.alreadyTagged && !plan.canPublish && plan.publishBlocked}<p class="mt-2 text-muted-foreground">{plan.publishBlocked}</p>{/if}
			</div>
		{/if}
	{/if}
</section>
