<script lang="ts">
	import { enhance } from '$app/forms';
	import { ArrowDownRight, ArrowUpRight, Check, X, RotateCcw } from '@lucide/svelte';
	import { ago } from '$lib/format';

	type Alert = { id: number; siteId: number; site: string; positive: boolean; title: string; detail: string | null; openedAt: number; updatedAt: number; active: boolean; status: string; closedAt: number | null; closedBy: string | null; delivery: string; deliveryMessage: string | null };
	let { alerts, showSite = true, empty = 'No alerts.' }: { alerts: Alert[]; showSite?: boolean; empty?: string } = $props();
	const STATUS: Record<string, string> = { resolved: 'resolved', dismissed: 'dismissed', cleared: 'ended by itself' };
	const DELIVERY: Record<string, string> = { sent: 'sent to the webhook', failed: 'webhook delivery failed', none: 'shown here only (no webhook)' };
</script>

{#if alerts.length}
	<ul class="divide-y rounded-xl border bg-card" style="border-color:var(--border)">
		{#each alerts as a (a.id)}
			<li class="flex flex-wrap items-start gap-3 px-4 py-3 {a.status !== 'open' ? 'opacity-70' : ''}">
				<span class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-muted {a.positive ? 'text-good' : 'text-bad'}" aria-label={a.positive ? 'Good news' : 'Problem'}>
					{#if a.positive}<ArrowUpRight class="size-3.5" />{:else}<ArrowDownRight class="size-3.5" />{/if}
				</span>
				<div class="min-w-0 flex-1 basis-64">
					<div class="text-sm font-medium">
						{#if showSite}<a class="pii hover:underline" href="/sites/{a.siteId}/alerts">{a.site}</a> · {/if}<span class="pii">{a.title}</span>
					</div>
					{#if a.detail}<div class="pii text-[13px] text-muted-foreground">{a.detail}</div>{/if}
					<div class="mt-0.5 text-[11px] text-muted-foreground">
						opened {ago(a.openedAt)}{#if a.updatedAt > a.openedAt + 60_000 && a.status === 'open'} · still true {ago(a.updatedAt)}{/if}
						{#if a.status !== 'open'} · {STATUS[a.status] ?? a.status}{#if a.closedBy} by <span class="pii">{a.closedBy}</span>{/if}{#if a.closedAt} {ago(a.closedAt)}{/if}{/if}
						· <span title={a.deliveryMessage ?? undefined}>{DELIVERY[a.delivery] ?? a.delivery}</span>
					</div>
				</div>
				<div class="flex shrink-0 items-center gap-1.5">
					{#if a.status === 'open'}
						<form method="POST" action="?/resolve" use:enhance><input type="hidden" name="id" value={a.id} /><button class="btn btn-sm" title="Dealt with: close it. The rule stays quiet until this ends and starts again."><Check class="size-3.5" />Resolve</button></form>
						<form method="POST" action="?/dismiss" use:enhance><input type="hidden" name="id" value={a.id} /><button class="btn btn-sm text-muted-foreground" title="Not relevant: close it. The rule stays quiet until this ends and starts again."><X class="size-3.5" />Dismiss</button></form>
					{:else if a.active && (a.status === 'resolved' || a.status === 'dismissed')}
						<form method="POST" action="?/reopen" use:enhance><input type="hidden" name="id" value={a.id} /><button class="btn btn-sm text-muted-foreground" title="Put it back on the open list"><RotateCcw class="size-3.5" />Reopen</button></form>
					{/if}
				</div>
			</li>
		{/each}
	</ul>
{:else}
	<p class="rounded-xl border bg-card px-4 py-6 text-center text-sm text-muted-foreground" style="border-color:var(--border)">{empty}</p>
{/if}
