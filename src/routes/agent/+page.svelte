<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusPill from '$lib/components/StatusPill.svelte';
	import { Compass, Play, Check, X } from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import { ago } from '$lib/format';
	let { data, form } = $props();
	let busy = $state(false);
	const args = (a: Record<string, unknown>) =>
		Object.entries(a)
			.filter(([k]) => k !== 'site')
			.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
			.join(' · ');
</script>

<PageHeader page="/agent" title="Agent" lead="A daily brief for each site, written by a model from your own data. It proposes changes; you approve them.">
	<p>Once a day per site it picks the specialists the open findings call for (Technical, Performance, Keyword, Content, AI visibility) and each writes a short brief from your data.</p>
	<p>It changes nothing itself. A change it wants waits below until someone approves it, and then runs as that person, audited like any other change.</p>
	<p>It uses the Ask chat's provider, so runs are billed there: at most <code>AGENT_RUNS_PER_DAY</code> runs a day and <code>AGENT_MAX_ROUNDS</code> model calls per run.</p>
	{#snippet meta()}<StatusPill tone={data.enabled ? 'good' : 'muted'}>{data.enabled ? 'on' : 'off'}</StatusPill>{/snippet}
	{#snippet actions()}
		<form method="POST" action="?/toggle" use:enhance><input type="hidden" name="on" value={data.enabled ? '0' : '1'} /><button class="btn btn-sm {data.enabled ? '' : 'btn-primary'}" disabled={!!data.setupProblem}>{data.enabled ? 'Switch off' : 'Switch on'}</button></form>
	{/snippet}
</PageHeader>
{#if form?.ok}<p class="mb-3 text-sm text-good">{form.ok}</p>{/if}{#if form?.error}<p class="mb-3 text-sm text-bad">{form.error}</p>{/if}
{#if data.setupProblem}<p class="mb-3 text-sm text-warn">{data.setupProblem}</p>{/if}

<section class="card mb-4 flex flex-wrap items-center gap-3 p-4 text-sm">
	<span>Runs today: <b>{data.budget.usedToday}</b> of {data.budget.perDay}</span>
	<span class="text-muted-foreground">Daily runs start at {String(data.budget.hourUtc).padStart(2, '0')}:00 UTC, up to {data.budget.perSite} specialists per site</span>
	{#if data.sites.length}
		<form method="POST" action="?/run" use:enhance={() => { busy = true; return async ({ update }) => { await update(); busy = false; }; }} class="ml-auto flex items-center gap-2">
			<select class="input pii !h-8 !py-0 text-sm" name="siteId" aria-label="Site">{#each data.sites as s}<option value={s.id}>{s.name} · today: {s.today.join(', ')}</option>{/each}</select>
			<select class="input !h-8 !py-0 text-sm" name="specialist" aria-label="Specialist"><option value="auto">Picked from findings</option>{#each data.specialists as sp}<option value={sp.key}>{sp.name}</option>{/each}<option value="all">All-round</option></select>
			<button class="btn btn-sm" disabled={busy || !!data.setupProblem}><Play class="size-3.5" />{busy ? 'Writing…' : 'Run now'}</button>
		</form>
	{/if}
</section>

<h2 class="mb-2 font-medium">Waiting for you ({data.proposals.length})</h2>
{#if data.proposals.length}
	<div class="mb-6 space-y-2">
		{#each data.proposals as p (p.id)}
			<div class="card p-3 text-sm">
				<div class="flex flex-wrap items-center gap-2"><span class="pii font-medium">{p.site}</span><code class="text-xs">{p.tool}</code><span class="text-xs text-muted-foreground">{ago(p.createdAt)}</span>
					<span class="ml-auto flex gap-1">
						<form method="POST" action="?/approve" use:enhance><input type="hidden" name="id" value={p.id} /><button class="btn btn-primary btn-xs"><Check class="size-3.5" />Approve</button></form>
						<form method="POST" action="?/decline" use:enhance><input type="hidden" name="id" value={p.id} /><button class="btn btn-xs"><X class="size-3.5" />Decline</button></form>
					</span></div>
				<p class="pii mt-1">{p.reason}</p>
				<p class="pii mt-1 text-xs break-all text-muted-foreground">{args(p.args)}</p>
			</div>
		{/each}
	</div>
{:else}
	<p class="mb-6 text-sm text-muted-foreground">Nothing is waiting.</p>
{/if}

<h2 class="mb-2 font-medium">Briefs</h2>
{#if data.runs.length}
	<div class="space-y-3">
		{#each data.runs as r (r.id)}
			<details class="card p-4" open={r === data.runs[0]}>
				<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 text-sm [&::-webkit-details-marker]:hidden"><span class="pii font-medium">{r.site}</span><span class="chip">{r.specialist ?? 'All-round'}</span><span class="text-xs text-muted-foreground">{new Date(r.startedAt).toLocaleString()} · {r.trigger}</span>
					<StatusPill tone={r.status === 'done' ? 'good' : r.status === 'running' ? 'info' : 'bad'}>{r.status}</StatusPill>
					<span class="ml-auto text-xs text-muted-foreground">{r.rounds} model calls · {r.toolCalls} tool calls · {(r.inputTokens + r.outputTokens).toLocaleString()} tokens</span></summary>
				{#if r.html}<div class="md pii mt-3 text-sm">{@html r.html}</div>{:else if r.error}<p class="mt-2 text-sm text-bad">{r.error}</p>{/if}
			</details>
		{/each}
	</div>
{:else}
	<EmptyState icon={Compass} tone="blue" title="No briefs yet." text="Switch the agent on, or run it once for a site." />
{/if}

{#if data.decided.length}
	<details class="mt-6">
		<summary class="cursor-pointer text-sm font-medium">Decided proposals ({data.decided.length})</summary>
		<ul class="mt-2 space-y-1 text-xs">{#each data.decided as p (p.id)}<li><span class="pii">{p.site}</span> · <code>{p.tool}</code> · <b>{p.status}</b>{p.decidedBy ? ` by ${p.decidedBy}` : ''}{p.result && p.status === 'failed' ? `: ${p.result}` : ''}</li>{/each}</ul>
	</details>
{/if}
