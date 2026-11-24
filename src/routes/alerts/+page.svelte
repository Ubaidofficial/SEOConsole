<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { CheckCheck, RefreshCw } from '@lucide/svelte';
	import AlertList from '$lib/components/AlertList.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	let { data } = $props();
	let checking = $state(false);
	const href = (o: Record<string, string>) => `?${new URLSearchParams({ show: data.show, ...(data.site ? { site: String(data.site) } : {}), ...o })}`;
	const tabs = [['open', 'Open'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed'], ['cleared', 'Ended by itself']] as const;
	const EMPTY = { open: 'No open alerts.', resolved: 'No resolved alerts yet.', dismissed: 'No dismissed alerts.', cleared: 'No alerts have ended by themselves yet.' };
	const openIds = $derived(data.alerts.filter((a) => a.status === 'open').map((a) => a.id));
</script>

<PageHeader page="/alerts" level={1} title="Alerts" lead="Each site's alert rules, checked every hour against the stored data. Thresholds and custom alerts are on each site's Alerts tab.">
	<p>An alert opens when a rule's condition starts to hold and is sent once, to the site's own Slack or Discord webhook if it has one, else to DIGEST_WEBHOOK_URL. While the condition holds the same alert is updated rather than repeated, and it ends by itself when the condition stops.</p>
	<p>Resolve means you dealt with it; dismiss means it was not relevant. Either way the rule stays quiet until the condition has ended and starts again. Alerts are also emailed when SMTP is set up in .env.</p>
	{#snippet actions()}
		{#if data.show === 'open' && openIds.length > 1}
			<form method="POST" action="?/resolve" use:enhance>{#each openIds as id}<input type="hidden" name="id" value={id} />{/each}<button class="btn btn-sm"><CheckCheck class="size-3.5" />Resolve all shown</button></form>
		{/if}
		<form method="POST" action="?/check" use:enhance={() => { checking = true; return async ({ update }) => { await update(); checking = false; }; }}><button class="btn btn-primary btn-sm" disabled={checking}><RefreshCw class="size-3.5 {checking ? 'animate-spin' : ''}" />{checking ? 'Checking…' : 'Check now'}</button></form>
	{/snippet}
</PageHeader>

<div class="mb-4 flex flex-wrap items-center gap-3">
	<nav class="seg" aria-label="Which alerts">
		{#each tabs as [key, label] (key)}
			{#if key !== 'cleared' || data.counts.cleared || data.show === 'cleared'}
				<a class="seg-item {data.show === key ? 'seg-on' : ''}" aria-current={data.show === key ? 'page' : undefined} href={href({ show: key })}>{label} · <span class="tnum">{data.counts[key]}</span></a>
			{/if}
		{/each}
	</nav>
	{#if data.sites.length > 1}
		<select class="input" aria-label="Site" value={data.site ? String(data.site) : ''} onchange={(e) => { const u = new URL(page.url); const v = e.currentTarget.value; v ? u.searchParams.set('site', v) : u.searchParams.delete('site'); goto(u.pathname + u.search); }}>
			<option value="">All sites</option>
			{#each data.sites as s}<option value={String(s.id)} class="pii">{s.name}</option>{/each}
		</select>
	{/if}
</div>

<AlertList alerts={data.alerts} cards={data.cards} empty={EMPTY[data.show]} />
