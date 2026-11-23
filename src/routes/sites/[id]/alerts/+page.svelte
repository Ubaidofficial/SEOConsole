<script lang="ts">
	import { enhance } from '$app/forms';
	import { RefreshCw, Trash2 } from '@lucide/svelte';
	import AlertList from '$lib/components/AlertList.svelte';
	import Explainer from '$lib/components/Explainer.svelte';
	let { data } = $props();
	let checking = $state(false);
	let kind = $state('clicks_drop');
	let scopeKind = $state('site');
	const k = $derived(data.kinds.find((x) => x.kind === kind)!);
	const UNIT: Record<string, string> = { '%': '%', places: 'places', count: '', pp: 'points' };
	const builtin = $derived(data.rules.filter((r) => r.builtin));
	const custom = $derived(data.rules.filter((r) => !r.builtin));
	const open = $derived(data.alerts.filter((a) => a.status === 'open'));
	const closed = $derived(data.alerts.filter((a) => a.status !== 'open'));
</script>

{#snippet ruleRow(r: (typeof data.rules)[number])}
	<form method="POST" action="?/rule" use:enhance={() => async ({ update }) => update({ reset: false })} class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
		<input type="hidden" name="id" value={r.id} />
		<label class="flex min-w-0 flex-1 basis-60 items-center gap-2 text-sm">
			<input type="hidden" name="enabled" value="0" />
			<input type="checkbox" name="enabled" value="1" checked={r.enabled} onchange={(e) => e.currentTarget.form?.requestSubmit()} aria-label="Rule on" />
			<span class={r.enabled ? '' : 'text-muted-foreground line-through'}><b class="font-medium">{r.label}</b>{#if r.positive}<span class="ml-1 chip !py-0 text-[10px]">good news</span>{/if}<span class="block text-xs text-muted-foreground"><span class="pii">{r.scope}</span> · {r.text}{#if r.kind === 'tracked_drop' && !data.tracked} · no searches tracked yet{/if}</span></span>
		</label>
		<label class="flex items-center gap-1 text-xs text-muted-foreground">Threshold<input class="input w-20 tnum" name="threshold" type="number" step="any" value={r.threshold} />{UNIT[r.unit]}</label>
		{#if r.kind !== 'deindexed'}
			<label class="flex items-center gap-1 text-xs text-muted-foreground">over<select class="input" name="window" value={String(r.windowDays)}>{#each [7, 14, 28] as w}<option value={String(w)}>{w} days</option>{/each}</select></label>
		{:else}<input type="hidden" name="window" value={r.windowDays} />{/if}
		<button class="btn btn-sm">Save</button>
	</form>
{/snippet}

<div class="mb-3 flex flex-wrap items-center gap-3">
	<h2 class="text-base font-semibold">Alerts</h2>
	<span class="text-xs text-muted-foreground">{open.length} open · checked every hour</span>
	<form class="ml-auto" method="POST" action="?/check" use:enhance={() => { checking = true; return async ({ update }) => { await update(); checking = false; }; }}><button class="btn" disabled={checking}><RefreshCw class="size-3.5 {checking ? 'animate-spin' : ''}" />{checking ? 'Checking…' : 'Check now'}</button></form>
</div>

<AlertList alerts={open} showSite={false} empty="No open alerts for this site." />

<h3 class="mt-6 mb-2 text-sm font-medium">Built-in rules <span class="font-normal text-muted-foreground">· on for every site; change a threshold or switch one off</span></h3>
<div class="divide-y rounded-xl border bg-card" style="border-color:var(--border)">{#each builtin as r (r.id)}{@render ruleRow(r)}{/each}</div>

<h3 class="mt-6 mb-2 text-sm font-medium">Custom alerts <span class="font-normal text-muted-foreground">· {custom.length} of 20; watch part of the site</span></h3>
{#if custom.length}
	<div class="mb-3 divide-y rounded-xl border bg-card" style="border-color:var(--border)">
		{#each custom as r (r.id)}
			<div class="flex items-center">
				<div class="min-w-0 flex-1">{@render ruleRow(r)}</div>
				<form method="POST" action="?/deleteRule" use:enhance class="pr-3"><input type="hidden" name="id" value={r.id} /><button class="btn btn-sm text-muted-foreground" aria-label="Remove this custom alert" title="Remove"><Trash2 class="size-3.5" /></button></form>
			</div>
		{/each}
	</div>
{/if}
<form method="POST" action="?/addRule" use:enhance class="card flex flex-wrap items-end gap-3 p-4">
	<label class="text-xs text-muted-foreground">Watch<select class="input mt-1 block" name="kind" bind:value={kind}>{#each data.kinds as x}<option value={x.kind}>{x.label}</option>{/each}</select></label>
	<label class="text-xs text-muted-foreground">Threshold<span class="mt-1 flex items-center gap-1"><input class="input w-20 tnum" name="threshold" type="number" step="any" value={k.threshold} />{UNIT[k.unit]}</span></label>
	<label class="text-xs text-muted-foreground">Over<select class="input mt-1 block" name="window">{#each [7, 14, 28] as w}<option value={String(w)} selected={w === k.window}>{w} days</option>{/each}</select></label>
	<label class="text-xs text-muted-foreground">On<select class="input mt-1 block" name="scopeKind" bind:value={scopeKind} disabled={!k.scopable}>
		<option value="site">The whole site</option>
		<option value="page">URL path starting with…</option>
		<option value="query">Searches matching (regex)…</option>
		<option value="bucket" disabled={!data.buckets.length}>A keyword bucket{data.buckets.length ? '' : ' (none yet)'}</option>
		<option value="pages" disabled={!data.pageGroups.length}>A page group{data.pageGroups.length ? '' : ' (none yet)'}</option>
	</select></label>
	{#if k.scopable && (scopeKind === 'page' || scopeKind === 'query')}
		<label class="text-xs text-muted-foreground">{scopeKind === 'page' ? 'Path' : 'Pattern'}<input class="input mt-1 block w-56 font-mono text-xs" name="scopeValue" placeholder={scopeKind === 'page' ? '/blog/' : 'shoes|boots'} required /></label>
	{:else if k.scopable && scopeKind === 'bucket'}
		<label class="text-xs text-muted-foreground">Bucket<select class="input mt-1 block" name="bucket">{#each data.buckets as b}<option value={String(b.id)}>{b.name}</option>{/each}</select></label>
	{:else if k.scopable && scopeKind === 'pages'}
		<label class="text-xs text-muted-foreground">Page group<select class="input mt-1 block" name="pageGroup">{#each data.pageGroups as g}<option value={String(g.id)}>{g.name}</option>{/each}</select></label>
	{/if}
	<button class="btn btn-primary">Add alert</button>
	<p class="w-full text-xs text-muted-foreground">{k.rule.replace('{t}', 'N')}. Buckets and page groups are made on the Groups tab.</p>
</form>

<h3 class="mt-6 mb-2 text-sm font-medium">Where alerts go</h3>
<div class="card p-4 text-sm">
	<p class="mb-2 text-muted-foreground">
		{#if data.webhook.site}This site's alerts go to its own webhook, <span class="pii font-mono text-xs">{data.webhook.site}</span>.
		{:else if data.webhook.global}This site's alerts go to the default webhook (DIGEST_WEBHOOK_URL).
		{:else}No webhook is set, so alerts are shown in the app only.{/if}
	</p>
	{#if data.canAdmin}
		<form method="POST" action="?/webhook" use:enhance class="flex flex-wrap items-center gap-2">
			<input class="input w-[min(32rem,100%)] font-mono text-xs" name="url" type="url" placeholder="https://hooks.slack.com/services/… or https://discord.com/api/webhooks/…" aria-label="Slack or Discord webhook for this site" />
			<button class="btn">Use for this site</button>
			{#if data.webhook.site}<button class="btn text-muted-foreground" name="remove" value="1">Use the default</button>{/if}
		</form>
		<form method="POST" action="?/testWebhook" use:enhance class="mt-2"><button class="btn btn-sm">Send a test alert</button></form>
	{:else}<p class="text-xs text-muted-foreground">An admin can send this site's alerts to its own Slack channel or Discord.</p>{/if}
</div>

<Explainer lead="How alert rules work.">
	<p>Every rule compares the last 7, 14 or 28 complete days with the same number of days before, as the period picker does. Clicks and impressions also have to change by more than day-to-day noise, so a quiet site does not alert on a handful of clicks.</p>
	<p>An alert is sent once when it opens and ends by itself when the condition stops. Resolve or dismiss it to close it sooner; the rule then stays quiet until the condition has ended and starts again. Only Slack and Discord addresses can be set here; any other webhook goes in DIGEST_WEBHOOK_URL. There is no email delivery.</p>
</Explainer>

{#if closed.length}
	<h3 class="mt-6 mb-2 text-sm font-medium">Recently closed</h3>
	<AlertList alerts={closed.slice(0, 20)} showSite={false} />
{/if}
