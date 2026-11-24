<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { Bell, BellOff, Mail, Pencil, Plus, RefreshCw, Send, ShieldCheck, Sliders, Trash2, Webhook } from '@lucide/svelte';
	import AlertList from '$lib/components/AlertList.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import StatusPill from '$lib/components/StatusPill.svelte';
	let { data } = $props();
	let checking = $state(false);
	let kind = $state('clicks_drop');
	let scopeKind = $state('site');
	const k = $derived(data.kinds.find((x) => x.kind === kind)!);
	const UNIT: Record<string, string> = { '%': '%', places: 'places', count: '', pp: 'points' };
	const builtin = $derived(data.rules.filter((r) => r.builtin));
	const custom = $derived(data.rules.filter((r) => !r.builtin));
	/** The tab's link keeps the period and anything else already in the address. */
	const showHref = (key: string) => {
		const q = new URLSearchParams(page.url.search);
		q.set('show', key);
		return `?${q}`;
	};
	const tabs = [['open', 'Open'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed'], ['cleared', 'Ended by itself']] as const;
	const EMPTY = { open: 'No open alerts for this site.', resolved: 'No resolved alerts yet.', dismissed: 'No dismissed alerts.', cleared: 'No alerts have ended by themselves yet.' };
	const FORMAT: Record<string, string> = { slack: 'Slack', discord: 'Discord' };
	/** Where this site's alerts are posted, in a few words: its own webhook, the default one, and email. */
	const destination = $derived.by(() => {
		const parts: string[] = [];
		const f = FORMAT[data.webhook.format ?? ''];
		if (data.webhook.site) parts.push(`its own ${f ? f + ' ' : ''}webhook`);
		else if (data.webhook.global) parts.push(`the default ${f ? f + ' ' : ''}webhook`);
		if (data.email.configured && data.email.recipients) parts.push('email');
		return parts;
	});
	const onCount = $derived(data.rules.filter((r) => r.enabled).length);
	let adding = $state(false);
	let editing = $state<number | null>(null);
	const windowText = (r: { kind: string; windowDays: number }) => (r.kind === 'deindexed' ? `last ${r.windowDays} days` : `over ${r.windowDays} days`);
</script>

{#snippet ruleRow(r: (typeof data.rules)[number])}
	<form id="rule-{r.id}" method="POST" action="?/rule" use:enhance={() => async ({ update }) => { await update({ reset: false }); editing = null; }} class="scroll-mt-20 target:bg-accent/60 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
		<input type="hidden" name="id" value={r.id} />
		<label class="relative inline-flex shrink-0 cursor-pointer items-center" title={r.enabled ? 'On: click to switch off' : 'Off: click to switch on'}>
			<input type="hidden" name="enabled" value="0" />
			<input type="checkbox" class="peer sr-only" name="enabled" value="1" checked={r.enabled} onchange={(e) => e.currentTarget.form?.requestSubmit()} aria-label="{r.label}: rule on" />
			<span class="h-5 w-9 rounded-full bg-muted ring-1 ring-border transition-colors peer-checked:bg-[color:var(--good)] peer-focus-visible:ring-2 peer-focus-visible:ring-ring" aria-hidden="true"></span>
			<span class="absolute left-0.5 size-4 rounded-full bg-card shadow-sm transition-transform peer-checked:translate-x-4" aria-hidden="true"></span>
		</label>
		<div class="min-w-0 flex-1 basis-56 text-sm {r.enabled ? '' : 'text-muted-foreground'}">
			<b class="font-medium">{r.label}</b>{#if r.positive}<span class="ml-1.5 pill pill-good">good news</span>{/if}
			<span class="block text-xs text-muted-foreground"><span class="pii">{r.scope}</span> · {r.text}{#if r.kind === 'tracked_drop' && !data.tracked} · no searches tracked yet{/if}</span>
		</div>
		{#if editing === r.id}
			<label class="flex items-center gap-1 text-xs text-muted-foreground">Threshold<input class="input w-20 tnum" name="threshold" type="number" step="any" value={r.threshold} />{UNIT[r.unit]}</label>
			{#if r.kind !== 'deindexed'}
				<label class="flex items-center gap-1 text-xs text-muted-foreground">over<select class="input" name="window" value={String(r.windowDays)}>{#each [7, 14, 28] as w}<option value={String(w)}>{w} days</option>{/each}</select></label>
			{:else}<input type="hidden" name="window" value={r.windowDays} />{/if}
			<button class="btn btn-primary btn-xs">Save</button>
			<button type="button" class="btn btn-ghost btn-xs" onclick={() => (editing = null)}>Cancel</button>
		{:else}
			<input type="hidden" name="threshold" value={r.threshold} /><input type="hidden" name="window" value={r.windowDays} />
			<span class="chip tnum">{r.threshold}{UNIT[r.unit] === '%' ? '%' : UNIT[r.unit] ? ' ' + UNIT[r.unit] : ''} · {windowText(r)}</span>
			<button type="button" class="btn btn-ghost btn-xs" onclick={() => (editing = r.id)} aria-label="Change {r.label}"><Pencil class="size-3.5" />Edit</button>
		{/if}
	</form>
{/snippet}

<PageHeader tab="/alerts" title="Alerts" lead="Rules check this site every hour and open an alert when something moves more than normal.">
	{#snippet meta()}<StatusPill tone={data.openNow.problems ? 'bad' : data.openNow.open ? 'good' : 'muted'}>{data.openNow.open} open</StatusPill><span class="text-xs text-muted-foreground">{onCount} of {data.rules.length} rules on</span>{/snippet}
	{#snippet actions()}
		<form method="POST" action="?/check" use:enhance={() => { checking = true; return async ({ update }) => { await update(); checking = false; }; }}><button class="btn btn-sm" disabled={checking}><RefreshCw class="size-3.5 {checking ? 'animate-spin' : ''}" />{checking ? 'Checking…' : 'Check now'}</button></form>
		<button type="button" class="btn btn-primary btn-sm" aria-expanded={adding} onclick={() => { adding = !adding; if (adding) queueMicrotask(() => document.getElementById('new-alert')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })); }}><Plus class="size-3.5" />New alert</button>
	{/snippet}
	<p>Every rule compares the last 7, 14 or 28 complete days with the same number of days before, as the period picker does. Clicks and impressions also have to change by more than day-to-day noise, so a quiet site does not alert on a handful of clicks.</p>
	<p>An alert is sent once when it opens and ends by itself when the condition stops. Resolve or dismiss it to close it sooner; the rule then stays quiet until the condition has ended and starts again. Only Slack and Discord addresses can be set here; any other webhook goes in DIGEST_WEBHOOK_URL. With SMTP set up in .env, alerts are emailed as well.</p>
</PageHeader>

<div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
	<nav class="seg" aria-label="Which alerts">
		{#each tabs as [key, label] (key)}
			{#if key !== 'cleared' || data.counts.cleared || data.show === 'cleared'}
				<a class="seg-item {data.show === key ? 'seg-on' : ''}" aria-current={data.show === key ? 'page' : undefined} href={showHref(key)} data-sveltekit-noscroll>{label} · <span class="tnum">{data.counts[key]}</span></a>
			{/if}
		{/each}
	</nav>
	<div class="flex items-center gap-1.5 text-xs text-muted-foreground sm:ml-auto">
		{#if destination.length}
			{#if data.webhook.site || data.webhook.global}<Webhook class="size-3.5 shrink-0" />{:else}<Mail class="size-3.5 shrink-0" />{/if}
			<span>Alerts post to <span class="font-medium text-foreground">{destination.join(' and ')}</span></span>
		{:else}
			<BellOff class="size-3.5 shrink-0" /><span>Alerts show here only</span>
		{/if}
		<span aria-hidden="true">·</span><a class="text-link hover:underline" href="#where">Change</a>
	</div>
</div>

<AlertList alerts={data.alerts} cards={data.cards} showSite={false} empty={EMPTY[data.show]} />

<h3 class="mt-6 mb-2 flex items-center gap-2 text-sm font-medium"><span class="ibadge ibadge-sm tone-amber" aria-hidden="true"><ShieldCheck class="size-3.5" /></span>Built-in rules <span class="font-normal text-muted-foreground">· on for every site; switch one off or edit its threshold</span></h3>
<div class="divide-y rounded-xl border bg-card" style="border-color:var(--border)">{#each builtin as r (r.id)}{@render ruleRow(r)}{/each}</div>

<h3 class="mt-6 mb-2 flex items-center gap-2 text-sm font-medium"><span class="ibadge ibadge-sm tone-blue" aria-hidden="true"><Sliders class="size-3.5" /></span>Custom alerts <span class="font-normal text-muted-foreground">· {custom.length} of 20; watch part of the site</span></h3>
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
{#if !custom.length && !adding}<p class="mb-3 text-xs text-muted-foreground">None yet. <button type="button" class="text-link hover:underline" onclick={() => (adding = true)}>Add one</button> to watch a folder, a set of searches, a keyword bucket or a page group.</p>{/if}
{#if adding}
<form id="new-alert" method="POST" action="?/addRule" use:enhance={() => async ({ result, update }) => { await update(); if (result.type === 'success') adding = false; }} class="card flex scroll-mt-20 flex-wrap items-end gap-3 border-[color:var(--link)]/40 p-4">
	<div class="flex w-full items-center gap-2 text-sm font-medium"><span class="ibadge ibadge-sm tone-blue" aria-hidden="true"><Bell class="size-3.5" /></span>New alert</div>
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
	<button class="btn btn-primary"><Plus class="size-3.5" />Add alert</button>
	<button type="button" class="btn btn-ghost" onclick={() => (adding = false)}>Cancel</button>
	<p class="w-full text-xs text-muted-foreground">{k.rule.replace('{t}', 'N')}. Buckets and page groups are made on the Groups tab.</p>
</form>
{/if}

<h3 id="where" class="mt-6 mb-2 flex scroll-mt-20 items-center gap-2 text-sm font-medium"><span class="ibadge ibadge-sm tone-violet" aria-hidden="true"><Send class="size-3.5" /></span>Where alerts go</h3>
<div class="card p-4 text-sm">
	<div class="mb-3 flex flex-wrap gap-2">
		<StatusPill tone="info">In the app</StatusPill>
		<StatusPill tone={data.webhook.site || data.webhook.global ? 'good' : 'muted'}>{data.webhook.site ? 'Own webhook' : data.webhook.global ? 'Default webhook' : 'No webhook'}</StatusPill>
		<StatusPill tone={data.email.configured ? 'good' : 'muted'}>{data.email.configured ? 'Email on' : 'Email not set up'}</StatusPill>
	</div>
	<p class="mb-2 flex items-center gap-1.5 text-muted-foreground"><Webhook class="size-3.5 shrink-0" />
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
		<div class="mt-4 border-t pt-3" style="border-color:var(--border)">
			{#if data.email.configured}
				<form method="POST" action="?/emails" use:enhance class="flex flex-wrap items-center gap-2">
					<input class="input w-[min(32rem,100%)] text-xs" name="emails" value={data.email.site} placeholder={data.email.defaults ? `Empty = the ${data.email.defaults} default address${data.email.defaults === 1 ? '' : 'es'} (ALERT_EMAIL_TO)` : 'you@example.com, team@example.com'} aria-label="Email this site's alerts to" />
					<button class="btn">Save emails</button>
				</form>
				<p class="mt-1 text-xs text-muted-foreground">Alerts are also emailed, one message per site per check, up to 10 addresses.</p>
			{:else}
				<p class="text-xs text-muted-foreground">Email alerts need SMTP_URL and ALERT_EMAIL_FROM in .env; then you can choose recipients here.</p>
			{/if}
		</div>
	{:else}<p class="text-xs text-muted-foreground">An admin can send this site's alerts to its own Slack channel or Discord.</p>{/if}
</div>

