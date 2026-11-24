<script lang="ts">
	import { enhance } from '$app/forms';
	import { ArrowDownRight, ArrowUpRight, BellOff, Check, X, RotateCcw, Send, Mail } from '@lucide/svelte';
	import { ago } from '$lib/format';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusPill from '$lib/components/StatusPill.svelte';
	import SiteAvatar from '$lib/components/SiteAvatar.svelte';

	type Alert = { id: number; siteId: number; site: string; positive: boolean; title: string; detail: string | null; openedAt: number; updatedAt: number; active: boolean; status: string; closedAt: number | null; closedBy: string | null; delivery: string; deliveryMessage: string | null };
	type Trend = { label: string; values: (number | null)[]; split: number; lowerIsBetter: boolean };
	let { alerts, showSite = true, empty = 'No alerts.', trends = {} }: { alerts: Alert[]; showSite?: boolean; empty?: string; trends?: Record<number, Trend> } = $props();
	const STATUS: Record<string, string> = { resolved: 'Resolved', dismissed: 'Dismissed', cleared: 'Ended by itself' };
	const DELIVERY: Record<string, string> = { sent: 'Sent to the webhook', failed: 'Webhook delivery failed', none: 'Shown here only (no webhook)' };

	/** The alert's measure over the window before (faint) and the window it compared (coloured), as one small line. */
	const W = 220;
	const H = 44;
	function spark(t: Trend) {
		const vals = t.values.map((v) => (v == null || !Number.isFinite(v) ? null : v));
		const nums = vals.filter((v): v is number => v != null);
		if (nums.length < 3) return null;
		let lo = Math.min(...nums);
		let hi = Math.max(...nums);
		if (hi === lo) (hi += 1), (lo -= 1);
		const x = (i: number) => (i / Math.max(1, vals.length - 1)) * W;
		// position: 1 is the top, so a smaller number is drawn higher
		const y = (v: number) => (t.lowerIsBetter ? 4 + ((v - lo) / (hi - lo)) * (H - 8) : H - 4 - ((v - lo) / (hi - lo)) * (H - 8));
		const path = (from: number, to: number) => {
			let d = '';
			let pen = false;
			for (let i = from; i <= to; i++) {
				const v = vals[i];
				if (v == null) { pen = false; continue; }
				d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
				pen = true;
			}
			return d;
		};
		const avg = (a: number, b: number) => {
			const xs = vals.slice(a, b).filter((v): v is number => v != null);
			return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
		};
		return { before: path(0, t.split), after: path(t.split, vals.length - 1), splitX: x(t.split), avgBefore: avg(0, t.split), avgAfter: avg(t.split, vals.length) };
	}
	const fmtAvg = (t: Trend, v: number | null) => (v == null ? '–' : t.label === 'Click rate' ? `${(v * 100).toFixed(1)}%` : t.label === 'Average position' ? v.toFixed(1) : Math.round(v).toLocaleString('en-US'));
</script>

{#if alerts.length}
	<ul class="stagger grid gap-3 lg:grid-cols-2">
		{#each alerts as a (a.id)}
			{@const t = trends[a.id]}
			{@const sp = t ? spark(t) : null}
			<li class="card flex flex-col gap-3 p-4 {a.status !== 'open' ? 'opacity-75' : ''}">
				<div class="flex items-start gap-3">
					<span class="ibadge {a.positive ? 'tone-green' : 'tone-red'}" aria-label={a.positive ? 'Good news' : 'Problem'}>
						{#if a.positive}<ArrowUpRight class="size-4" />{:else}<ArrowDownRight class="size-4" />{/if}
					</span>
					<div class="min-w-0 flex-1">
						{#if showSite}<a class="pii inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:underline" href="/sites/{a.siteId}/alerts"><SiteAvatar name={a.site} siteId={a.siteId} class="!size-4 !rounded !text-[9px]" />{a.site}</a>{/if}
						<div class="text-sm font-medium"><span class="pii">{a.title}</span></div>
						{#if a.detail}<div class="pii mt-0.5 text-[13px] leading-snug text-muted-foreground">{a.detail}</div>{/if}
					</div>
					{#if a.status === 'open'}
						<StatusPill tone={a.positive ? 'good' : 'bad'} pulse={a.active}>{a.active ? 'Open' : 'Open · no longer true'}</StatusPill>
					{:else}
						<StatusPill tone="muted">{STATUS[a.status] ?? a.status}</StatusPill>
					{/if}
				</div>
				{#if sp && t}
					<div class="rounded-lg bg-muted/40 px-3 py-2">
						<div class="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground tnum">
							<span>{t.label}, daily</span>
							<span>avg {fmtAvg(t, sp.avgBefore)} → <b class="font-semibold {a.positive ? 'text-good' : 'text-bad'}">{fmtAvg(t, sp.avgAfter)}</b></span>
						</div>
						<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class="block h-11 w-full" role="img" aria-label="{t.label} by day: average {fmtAvg(t, sp.avgBefore)} before, {fmtAvg(t, sp.avgAfter)} in the window the rule compared">
							<rect x={sp.splitX} y="0" width={W - sp.splitX} height={H} fill={a.positive ? 'var(--good)' : 'var(--bad)'} opacity="0.07" />
							<line x1={sp.splitX} x2={sp.splitX} y1="0" y2={H} stroke="var(--axis)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke" />
							<path d={sp.before} fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" opacity="0.55" vector-effect="non-scaling-stroke" />
							<path d={sp.after} fill="none" stroke={a.positive ? 'var(--good)' : 'var(--bad)'} stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
						</svg>
					</div>
				{/if}
				<div class="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
					<span>Opened {ago(a.openedAt)}{#if a.updatedAt > a.openedAt + 60_000 && a.status === 'open'} · still true {ago(a.updatedAt)}{/if}{#if a.status !== 'open' && a.closedAt} · closed {ago(a.closedAt)}{#if a.closedBy} by <span class="pii">{a.closedBy}</span>{/if}{/if}</span>
					<span class="inline-flex items-center gap-1 {a.delivery === 'failed' ? 'text-bad' : ''}" title={a.deliveryMessage ?? undefined}>{#if a.delivery === 'sent'}<Send class="size-3" />{:else if a.delivery === 'failed'}<BellOff class="size-3" />{:else}<Mail class="size-3 opacity-60" />{/if}{DELIVERY[a.delivery] ?? a.delivery}</span>
					<div class="ml-auto flex items-center gap-1">
						{#if a.status === 'open'}
							<form method="POST" action="?/resolve" use:enhance><input type="hidden" name="id" value={a.id} /><button class="btn btn-xs" title="Dealt with: close it. The rule stays quiet until this ends and starts again."><Check class="size-3.5" />Resolve</button></form>
							<form method="POST" action="?/dismiss" use:enhance><input type="hidden" name="id" value={a.id} /><button class="btn btn-ghost btn-xs" title="Not relevant: close it. The rule stays quiet until this ends and starts again."><X class="size-3.5" />Dismiss</button></form>
						{:else if a.active && (a.status === 'resolved' || a.status === 'dismissed')}
							<form method="POST" action="?/reopen" use:enhance><input type="hidden" name="id" value={a.id} /><button class="btn btn-ghost btn-xs" title="Put it back on the open list"><RotateCcw class="size-3.5" />Reopen</button></form>
						{/if}
					</div>
				</div>
			</li>
		{/each}
	</ul>
{:else}
	<EmptyState icon={Check} tone="green" title={empty} text="Rules are checked every hour; anything that crosses a threshold shows up here." />
{/if}
