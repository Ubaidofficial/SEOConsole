<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { BellOff, Check, X, RotateCcw, Send, Mail } from '@lucide/svelte';
	import { ago, fmtPos } from '$lib/format';
	import { pagePath } from '$lib/rules';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusPill from '$lib/components/StatusPill.svelte';
	import SiteAvatar from '$lib/components/SiteAvatar.svelte';
	import type { AlertCard, AlertEvidence, AlertTrend } from '$lib/server/alerts';

	type Alert = { id: number; siteId: number; site: string; kind: string; positive: boolean; title: string; detail: string | null; openedAt: number; updatedAt: number; active: boolean; status: string; closedAt: number | null; closedBy: string | null; delivery: string; deliveryMessage: string | null };
	let { alerts, showSite = true, empty = 'No alerts.', cards = {} }: { alerts: Alert[]; showSite?: boolean; empty?: string; cards?: Record<number, AlertCard> } = $props();
	const STATUS: Record<string, string> = { resolved: 'Resolved', dismissed: 'Dismissed', cleared: 'Ended by itself' };
	const DELIVERY: Record<string, string> = { sent: 'Sent to the webhook', failed: 'Webhook delivery failed', none: 'Shown here only (no webhook)' };

	const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
	const int = (n: number) => Math.round(n).toLocaleString('en-US');
	const pct = (p: number | null) => (p == null ? '' : `${p > 0 ? '+' : '−'}${Math.abs(p).toFixed(0)}%`);
	const keyText = (k: string, dim: 'query' | 'page') => (dim === 'page' ? pagePath(k) : k);

	/** A line over the window before (faint) and the window the rule compared (coloured). Position: 1 is the top, so smaller is drawn higher. */
	function spark(values: (number | null)[], split: number, lowerIsBetter: boolean, W: number, H: number) {
		const vals = values.map((v) => (v == null || !Number.isFinite(v) ? null : v));
		const nums = vals.filter((v): v is number => v != null);
		if (nums.length < 2) return null;
		let lo = Math.min(...nums);
		let hi = Math.max(...nums);
		if (hi === lo) (hi += 1), (lo -= 1);
		const pad = Math.min(4, H / 8);
		const x = (i: number) => (i / Math.max(1, vals.length - 1)) * W;
		const y = (v: number) => (lowerIsBetter ? pad + ((v - lo) / (hi - lo)) * (H - 2 * pad) : H - pad - ((v - lo) / (hi - lo)) * (H - 2 * pad));
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
		return { before: path(0, split), after: path(split, vals.length - 1), splitX: x(split), avgBefore: avg(0, split), avgAfter: avg(split, vals.length) };
	}
	const fmtAvg = (t: AlertTrend, v: number | null) => (v == null ? '–' : t.label === 'Click rate' ? `${(v * 100).toFixed(1)}%` : t.label === 'Average position' ? v.toFixed(1) : int(v));

	/** Daily clicks of one page as a filled area: the window before in grey, the window the rule compared in red. */
	const AW = 200;
	const AH = 44;
	function area(values: number[], split: number) {
		const n = values.length;
		if (n < 2) return null;
		const max = Math.max(1, ...values);
		const x = (i: number) => (i / (n - 1)) * AW;
		const y = (v: number) => AH - 2 - (v / max) * (AH - 6);
		const line = (a: number, b: number) => values.slice(a, b + 1).map((v, j) => `${j ? 'L' : 'M'}${x(a + j).toFixed(1)},${y(v).toFixed(1)}`).join('');
		const fill = (a: number, b: number) => `${line(a, b)}L${x(b).toFixed(1)},${AH}L${x(a).toFixed(1)},${AH}Z`;
		return { before: line(0, split), after: line(split, n - 1), beforeArea: fill(0, split), afterArea: fill(split, n - 1), splitX: x(split) };
	}

	/** Where each URL's drop sits between the start and the end of the rule's window, 0 to 100 %. */
	const at = (e: Extract<AlertEvidence, { type: 'index' }>, ms: number) => Math.min(100, Math.max(0, ((ms - e.from) / Math.max(1, e.to - e.from)) * 100));
	const TITLE: Record<string, string> = { top10_lost: 'Searches that left the top 10', top3_new: 'Searches that reached the top 3' };
	/** The fix link opens the tab on the period this page shows, as the app's own tab links do. */
	const withDays = (href: string) => {
		const d = page.url.searchParams.get('days');
		return d && !/[?&]days=/.test(href) ? `${href}${href.includes('?') ? '&' : '?'}days=${encodeURIComponent(d)}` : href;
	};
</script>

{#snippet evidence(a: Alert, e: AlertEvidence)}
	{#if e.type === 'pages'}
		<div class="mb-2 flex items-baseline justify-between gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"><span>{e.dim === 'page' ? 'Pages' : 'Searches'} that lost clicks</span>{#if e.total > e.items.length}<span class="tnum normal-case">{e.items.length} of {e.total}</span>{/if}</div>
		<div class="grid gap-3 sm:grid-cols-2">
			{#each e.items as it (it.key)}
				{@const g = area(it.values, it.split)}
				<div class="min-w-0">
					<div class="pii truncate font-mono text-xs" title={keyText(it.key, e.dim)}>{keyText(it.key, e.dim)}</div>
					<div class="text-[11px] text-muted-foreground tnum">{int(it.now)} clicks <span class="text-bad font-medium">{pct(it.pct)}</span> <span class="opacity-75">from {int(it.before)}</span></div>
					{#if g}
						<svg viewBox="0 0 {AW} {AH}" preserveAspectRatio="none" class="mt-1 block h-11 w-full" role="img" aria-label="Daily clicks for {keyText(it.key, e.dim)}: {int(it.before)} in the window before, {int(it.now)} in the window the rule compared ({pct(it.pct)})">
							<path d={g.beforeArea} fill="var(--muted-foreground)" opacity="0.12" />
							<path d={g.afterArea} fill="var(--bad)" opacity="0.16" />
							<line x1={g.splitX} x2={g.splitX} y1="0" y2={AH} stroke="var(--axis)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke" />
							<path d={g.before} fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" opacity="0.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
							<path d={g.after} fill="none" stroke="var(--bad)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
						</svg>
					{/if}
				</div>
			{/each}
		</div>
	{:else if e.type === 'index'}
		<div class="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">When each URL changed</div>
		<div class="relative h-6" role="img" aria-label="{e.total} page{e.total === 1 ? '' : 's'} dropped out of Google’s index between {day(e.from)} and {day(e.to)}: {e.urls.map((u) => day(u.at)).join(', ')}">
			<div class="absolute inset-x-0 top-1/2 h-px" style="background:var(--axis)"></div>
			{#each e.urls as u (u.url)}<span class="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card" style="left:{at(e, u.at)}%;background:{u.back ? 'var(--good)' : 'var(--bad)'}" aria-hidden="true"></span>{/each}
		</div>
		<div class="mb-2 flex justify-between text-[10px] text-muted-foreground tnum" aria-hidden="true"><span>{day(e.from)}</span><span>{day(e.to)}</span></div>
		<ul class="flex flex-col gap-1.5">
			{#each e.urls as u (u.url)}
				<li class="flex min-w-0 items-center gap-2 text-xs">
					<span class="pii min-w-0 flex-1 truncate font-mono" title={pagePath(u.url)}>{pagePath(u.url)}</span>
					<span class="shrink-0 text-[11px] text-muted-foreground tnum">{day(u.at)}</span>
					<StatusPill tone={u.back ? 'good' : 'bad'}>{u.state}</StatusPill>
				</li>
			{/each}
		</ul>
		{#if e.total > e.urls.length}<div class="mt-1.5 text-[11px] text-muted-foreground">and {e.total - e.urls.length} more</div>{/if}
	{:else if e.type === 'searches'}
		<div class="mb-2 flex items-baseline justify-between gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"><span>{e.dim === 'page' ? (a.kind === 'top3_new' ? 'Pages that reached the top 3' : 'Pages that left the top 10') : (TITLE[a.kind] ?? 'Searches')}</span><span class="shrink-0 whitespace-nowrap normal-case">before → now</span></div>
		<ul class="flex flex-col gap-1.5">
			{#each e.items as it (it.key)}
				<li class="flex min-w-0 items-center gap-2 text-xs">
					<span class="pii min-w-0 flex-1 truncate" title={keyText(it.key, e.dim)}>{keyText(it.key, e.dim)}</span>
					<span class="shrink-0 tnum text-muted-foreground">{it.before == null ? 'not shown' : fmtPos(it.before)} → <b class="font-semibold {a.positive ? 'text-good' : 'text-bad'}">{it.now == null ? 'not shown' : fmtPos(it.now)}</b></span>
				</li>
			{/each}
		</ul>
		{#if e.total > e.items.length}<div class="mt-1.5 text-[11px] text-muted-foreground">and {e.total - e.items.length} more</div>{/if}
	{:else if e.type === 'tracked'}
		<div class="mb-2 flex items-baseline justify-between gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"><span>Tracked searches that fell</span><span class="shrink-0 whitespace-nowrap normal-case">before → now</span></div>
		<ul class="flex flex-col gap-1.5">
			{#each e.items as it (it.key)}
				{@const s = spark(it.values, it.split, true, 80, 20)}
				<li class="flex min-w-0 items-center gap-2 text-xs">
					<span class="pii min-w-0 flex-1 truncate" title={it.key}>{it.key}</span>
					{#if s}
						<svg viewBox="0 0 80 20" preserveAspectRatio="none" class="h-5 w-20 shrink-0" role="img" aria-label="Daily Google position for {it.key}: {fmtPos(it.before)} before, {it.now == null ? 'not shown' : fmtPos(it.now)} now">
							<line x1={s.splitX} x2={s.splitX} y1="0" y2="20" stroke="var(--axis)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke" />
							<path d={s.before} fill="none" stroke="var(--muted-foreground)" stroke-width="1.25" opacity="0.6" vector-effect="non-scaling-stroke" />
							<path d={s.after} fill="none" stroke="var(--bad)" stroke-width="1.75" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
						</svg>
					{/if}
					<span class="w-24 shrink-0 text-right tnum text-muted-foreground">{fmtPos(it.before)} → <b class="font-semibold text-bad">{it.now == null ? 'not shown' : fmtPos(it.now)}</b></span>
				</li>
			{/each}
		</ul>
		{#if e.total > e.items.length}<div class="mt-1.5 text-[11px] text-muted-foreground">and {e.total - e.items.length} more</div>{/if}
	{:else if e.type === 'trend'}
		{@const t = e.trend}
		{@const sp = spark(t.values, t.split, t.lowerIsBetter, 220, 44)}
		<div class="mb-1 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground tnum">
			<span><span class="font-medium tracking-wide uppercase">{t.label}, daily</span> · <span class="pii">{e.scope}</span></span>
			{#if sp}<span>avg {fmtAvg(t, sp.avgBefore)} → <b class="font-semibold {a.positive ? 'text-good' : 'text-bad'}">{fmtAvg(t, sp.avgAfter)}</b></span>{/if}
		</div>
		{#if sp}
			<svg viewBox="0 0 220 44" preserveAspectRatio="none" class="block h-16 w-full" role="img" aria-label="{t.label} by day ({e.scope}): average {fmtAvg(t, sp.avgBefore)} before, {fmtAvg(t, sp.avgAfter)} in the window the rule compared">
				<rect x={sp.splitX} y="0" width={220 - sp.splitX} height="44" fill={a.positive ? 'var(--good)' : 'var(--bad)'} opacity="0.07" />
				<line x1={sp.splitX} x2={sp.splitX} y1="0" y2="44" stroke="var(--axis)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke" />
				<path d={sp.before} fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" opacity="0.55" vector-effect="non-scaling-stroke" />
				<path d={sp.after} fill="none" stroke={a.positive ? 'var(--good)' : 'var(--bad)'} stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
			</svg>
			<div class="mt-0.5 flex justify-between text-[10px] text-muted-foreground" aria-hidden="true"><span>window before</span><span>window compared</span></div>
		{/if}
	{/if}
{/snippet}

{#if alerts.length}
	<ul class="stagger grid gap-3">
		{#each alerts as a (a.id)}
			{@const c = cards[a.id]}
			{@const e = c?.evidence ?? null}
			<li class="card p-4 {a.status !== 'open' ? 'opacity-75' : ''}">
				<div class="grid gap-4 {e ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]' : ''}">
					<div class="flex min-w-0 flex-col gap-2.5">
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
							{#if showSite}<a class="pii inline-flex items-center gap-1.5 text-muted-foreground hover:underline" href="/sites/{a.siteId}/alerts"><SiteAvatar name={a.site} siteId={a.siteId} class="!size-4 !rounded !text-[9px]" />{a.site}</a><span class="text-muted-foreground" aria-hidden="true">·</span>{/if}
							{#if c}<span class="font-medium text-foreground">{c.group}</span>{/if}
							{#if a.status === 'open'}
								{#if !a.active}<StatusPill tone="muted">No longer true</StatusPill>
								{:else if a.positive}<StatusPill tone="good">Good news</StatusPill>
								{:else}<StatusPill tone="bad" pulse>Needs a look</StatusPill>{/if}
							{:else}
								<StatusPill tone="muted">{STATUS[a.status] ?? a.status}</StatusPill>
							{/if}
							<span class="ml-auto text-[11px] text-muted-foreground tnum" title="Opened {ago(a.openedAt)}">Since {day(a.openedAt)}</span>
						</div>
						<div class="text-[15px] leading-snug font-semibold"><span class="pii">{a.title}</span></div>
						{#if a.detail}<div class="pii text-[13px] leading-snug text-muted-foreground {e ? 'line-clamp-1' : 'line-clamp-3'}">{a.detail}</div>{/if}
						{#if c?.facts.length}
							<dl class="flex flex-wrap gap-x-6 gap-y-1.5">
								{#each c.facts as f (f.label)}
									<div class="min-w-0"><dt class="text-[11px] text-muted-foreground">{f.label}</dt><dd class="text-[13px] font-medium tnum">{f.value}</dd></div>
								{/each}
							</dl>
						{/if}
						<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
							{#if a.status !== 'open' && a.closedAt}<span>Closed {ago(a.closedAt)}{#if a.closedBy} by <span class="pii">{a.closedBy}</span>{/if}</span>{:else if a.updatedAt > a.openedAt + 60_000}<span>Still true {ago(a.updatedAt)}</span>{/if}
							<span class="inline-flex items-center gap-1 {a.delivery === 'failed' ? 'text-bad' : ''}" title={a.deliveryMessage ?? undefined}>{#if a.delivery === 'sent'}<Send class="size-3" />{:else if a.delivery === 'failed'}<BellOff class="size-3" />{:else}<Mail class="size-3 opacity-60" />{/if}{DELIVERY[a.delivery] ?? a.delivery}</span>
						</div>
						<div class="mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-2 pt-1">
							{#if c}<a class="btn btn-sm font-semibold" href={withDays(c.fix.href)}>{c.fix.label} <span aria-hidden="true">→</span></a>{/if}
							{#if a.status === 'open'}
								<form method="POST" action="?/resolve" use:enhance><input type="hidden" name="id" value={a.id} /><button class="btn btn-ghost btn-xs" title="Dealt with: close it. The rule stays quiet until this ends and starts again."><Check class="size-3.5" />Resolve</button></form>
								<form method="POST" action="?/dismiss" use:enhance><input type="hidden" name="id" value={a.id} /><button class="btn btn-ghost btn-xs" title="Not relevant: close it. The rule stays quiet until this ends and starts again."><X class="size-3.5" />Dismiss</button></form>
							{:else if a.active && (a.status === 'resolved' || a.status === 'dismissed')}
								<form method="POST" action="?/reopen" use:enhance><input type="hidden" name="id" value={a.id} /><button class="btn btn-ghost btn-xs" title="Put it back on the open list"><RotateCcw class="size-3.5" />Reopen</button></form>
							{/if}
							{#if c?.rule}<a class="pii ml-auto max-w-[16rem] truncate text-[11px] text-muted-foreground hover:text-foreground hover:underline" href={c.rule.href} title="The rule behind this alert">{c.rule.name}</a>{/if}
						</div>
					</div>
					{#if e}
						<div class="min-w-0 rounded-lg bg-muted/40 p-3" role="group" aria-label="Evidence">
							{@render evidence(a, e)}
						</div>
					{/if}
				</div>
			</li>
		{/each}
	</ul>
{:else}
	<EmptyState icon={Check} tone="green" title={empty} text="Rules are checked every hour; anything that crosses a threshold shows up here." />
{/if}
