<script lang="ts">
	import { ago, fmtInt, fmtSigned } from '$lib/format';
	type Hour = { hour: string; label: string; clicks: number; impressions: number; recent: boolean };
	type Totals = { clicks: number; impressions: number; position: number | null; hours: number };
	let {
		data,
		pagesHref
	}: {
		data: { fetchedAt: number; empty: true } | { fetchedAt: number; empty: false; through: string; last24: Totals; prev24: Totals | null; hours: Hour[]; pages: { page: string; clicks: number; impressions: number }[] | null };
		pagesHref: string;
	} = $props();
	const max = $derived(data.empty ? 1 : Math.max(1, ...data.hours.map((h) => h.clicks)));
	const change = (a: number, b: number | undefined) => (b ? a / b - 1 : null);
	const path = (u: string) => u.replace(/^https?:\/\/[^/]+/, '') || '/';
</script>

<section class="mb-5 rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="hourly-h">
	<div class="mb-3 flex flex-wrap items-baseline justify-between gap-3">
		<h2 id="hourly-h" class="text-base font-semibold tracking-tight">Last 24 hours</h2>
		<p class="text-xs text-muted-foreground">Google Search, hour by hour on Google's clock (Pacific). Hourly data is preliminary and trails by a few hours · read {ago(data.fetchedAt)}</p>
	</div>
	{#if data.empty}
		<p class="text-sm text-muted-foreground">Google returned no hourly data for this property yet.</p>
	{:else}
		{@const c = change(data.last24.clicks, data.prev24?.clicks)}
		{@const i = change(data.last24.impressions, data.prev24?.impressions)}
		<div class="tnum mb-4 flex flex-wrap gap-x-8 gap-y-2">
			<div><span class="text-2xl font-semibold">{fmtInt(data.last24.clicks)}</span> <span class="text-xs text-muted-foreground">clicks</span>{#if c != null} <span class="text-xs font-medium {c >= 0 ? 'text-good' : 'text-bad'}">{fmtSigned(c)}</span>{/if}</div>
			<div><span class="text-2xl font-semibold">{fmtInt(data.last24.impressions)}</span> <span class="text-xs text-muted-foreground">impressions</span>{#if i != null} <span class="text-xs font-medium {i >= 0 ? 'text-good' : 'text-bad'}">{fmtSigned(i)}</span>{/if}</div>
			<div class="self-end text-xs text-muted-foreground">through {data.through.slice(0, 10)} {data.hours.at(-1)?.label}{data.prev24 ? ' · change against the 24 hours before' : ''}</div>
		</div>
		<div class="flex h-20 items-end gap-px" role="img" aria-label="Clicks per hour over the last 48 hours; the newer 24 are darker">
			{#each data.hours as h}
				<div class="flex-1 rounded-t-sm" style="height:{Math.max(2, (h.clicks / max) * 100)}%;background:{h.recent ? 'var(--chart-1)' : 'var(--muted-foreground)'};opacity:{h.recent ? 1 : 0.3}" title="{h.label}: {fmtInt(h.clicks)} clicks, {fmtInt(h.impressions)} impressions"></div>
			{/each}
		</div>
		<div class="mt-1 flex justify-between text-[11px] text-muted-foreground"><span>{data.hours[0]?.label}</span><span>{data.hours[24]?.label}</span><span>{data.hours.at(-1)?.label}</span></div>
		{#if data.pages && data.pages.length}
			<h3 class="mt-4 mb-1 text-sm font-medium">Pages with the most clicks in these 24 hours</h3>
			<ul class="tnum divide-y text-sm">
				{#each data.pages.slice(0, 5) as p}
					<li class="flex items-baseline justify-between gap-3 py-1"><span class="pii truncate" title={p.page}>{path(p.page)}</span><span class="shrink-0 text-xs text-muted-foreground"><b class="text-foreground">{fmtInt(p.clicks)}</b> clicks · {fmtInt(p.impressions)} impr.</span></li>
				{/each}
			</ul>
			<p class="mt-1 text-[11px] text-muted-foreground"><a class="underline" href={pagesHref}>All pages</a> (daily data)</p>
		{/if}
	{/if}
</section>
