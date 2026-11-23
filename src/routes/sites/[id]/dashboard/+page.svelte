<script lang="ts">
	import Delta from '$lib/components/Delta.svelte';
	import Explainer from '$lib/components/Explainer.svelte';
	import BarList from '$lib/components/viz/BarList.svelte';
	import SegBar from '$lib/components/viz/SegBar.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import { fmtInt, fmtPct, fmtPos } from '$lib/format';
	import { noKeyEventsText } from '$lib/keyeventtext';
	let { data } = $props();
	const g = $derived(data.dash.gsc);
	const b = $derived(data.dash.bing);
	const a = $derived(data.dash.ga4);
	const c = $derived(data.dash.clarity);
	const range = (w: { start: string; end: string }) => (w.start === w.end ? w.end : `${w.start} → ${w.end}`);

	// One colour per device whichever source names it (identity, not rank), so the three bars read the same way.
	const DEVICE: Record<string, [string, string, number]> = { mobile: ['Phone', 'var(--chart-1)', 0], desktop: ['Desktop', 'var(--chart-2)', 1], pc: ['Desktop', 'var(--chart-2)', 1], tablet: ['Tablet', 'var(--chart-3)', 2] };
	const devParts = (rows: { key: string; value: number }[]) =>
		[...rows]
			.map((r) => ({ d: DEVICE[r.key.toLowerCase()] ?? [r.key, 'var(--muted-foreground)', 9], value: r.value }))
			.sort((x, y) => x.d[2] - y.d[2])
			.map((r) => ({ label: r.d[0], color: r.d[1], value: r.value }));
	// The palette has three series colours: the three biggest channels get them, the rest share one muted "Other" (all are in the table below).
	const CHANNEL_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'];
	const channelParts = (rows: { key: string; sessions: number }[]) => {
		const top = rows.slice(0, 3).map((r, i) => ({ label: r.key, value: r.sessions, color: CHANNEL_COLORS[i] }));
		const rest = rows.slice(3).reduce((s, r) => s + r.sessions, 0);
		return rest ? [...top, { label: 'Other', value: rest, color: 'var(--muted-foreground)' }] : top;
	};
	const VISITOR: Record<string, string> = { new: 'New', returning: 'Returning', '(not set)': 'Not set' };
	const secs = (n: number | null) => (n == null ? '–' : n >= 60 ? `${Math.floor(n / 60)}m ${Math.round(n % 60)}s` : `${Math.round(n)}s`);
	const path = (u: string) => {
		try {
			const x = new URL(u);
			return x.pathname + x.search || '/';
		} catch {
			return u;
		}
	};
</script>

{#snippet connect(name: string)}
	<p class="text-sm text-muted-foreground">{name} is not linked to this site. <a class="underline" href="/connect">Connect it</a> to see it here.</p>
{/snippet}
{#snippet kpi(label: string, value: string, delta: number | null | undefined, sub: string, href: string | null = null)}
	<div class="card px-3 py-2">
		<div class="text-xs text-muted-foreground">{label}</div>
		<div class="tnum text-xl font-semibold">{#if href}<a class="hover:underline" {href}>{value}</a>{:else}{value}{/if}</div>
		{#if delta !== undefined}<Delta value={delta} why="Nothing in the period before to compare with" />{/if}
		<div class="truncate text-[11px] text-muted-foreground" title={sub}>{sub}</div>
	</div>
{/snippet}

<Explainer lead="Search Console, GA4, Bing and Clarity side by side. Each card shows the dates its source covers.">
	<p>Sources report on different clocks: Search Console runs about two days behind, GA4 about a day, and Clarity only exposes the last 1 to 3 days (shown from the newest stored snapshot). So "24h" here is each source's newest day, and the figures are not meant to add up across sources. Clicks are counted by the search engine; sessions and users by the tags on your pages, which miss visitors who block them.</p>
	<p>Countries and devices from Search Console come from the searches Google lists, so they can total less than all clicks. Changes (▲/▼) are against the period of the same length just before.</p>
</Explainer>

<!-- Headline numbers, one source per tile -->
<div class="stagger mt-3 mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
	{@render kpi('Google clicks', fmtInt(g.clicks), g.clicksDelta, `Search Console · ${range(g.window)}`, `queries?days=${data.days}`)}
	{@render kpi('Google impressions', fmtInt(g.impressions), g.impressionsDelta, `CTR ${fmtPct(g.ctr)} · position ${fmtPos(g.position)}`)}
	{#if b}{@render kpi('Bing clicks', fmtInt(b.clicks), b.clicksDelta, `Bing · ${range(b.window)}`, `bing?days=${data.days}`)}{:else}{@render kpi('Bing clicks', '–', undefined, data.dash.linked.bing ? 'Bing: not synced yet' : 'Bing: not linked')}{/if}
	{#if a?.synced}
		{@render kpi('Sessions (all channels)', fmtInt(a.sessions), a.sessionsDelta, a.users ? `${fmtInt(a.users.activeUsers)} users (${fmtInt(a.users.newUsers)} new) · GA4 · ${range(a.window)}` : `GA4 · ${range(a.window)}`, `analytics?days=${data.days}`)}
		{@render kpi('Key events', fmtInt(a.keyEvents), a.keyEventsDelta, `GA4 · engaged ${fmtPct(a.engagementRate)}`)}
	{:else}
		{@render kpi('Sessions (all channels)', '–', undefined, a ? 'GA4: first sync running' : 'GA4: not linked')}
		{@render kpi('Key events', '–', undefined, a ? 'GA4: first sync running' : 'GA4: not linked')}
	{/if}
	{#if c?.synced}{@render kpi('Real visitors', fmtInt(c.humans), undefined, `Clarity · ~24h to ${c.day} · ${fmtInt(c.bots)} bots left out`, 'clarity')}{:else}{@render kpi('Real visitors', '–', undefined, c ? 'Clarity: not synced yet' : 'Clarity: not linked')}{/if}
</div>

<!-- Where traffic comes from -->
<div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
	<section class="card p-4">
		<h2 class="mb-1 text-sm font-medium">Traffic by channel <span class="font-normal text-muted-foreground">· GA4</span></h2>
		{#if !a}{@render connect('GA4')}
		{:else if !a.synced}<p class="text-sm text-muted-foreground">Appears after the first GA4 sync.</p>
		{:else if !a.channels.length}<p class="text-sm text-muted-foreground">No sessions in {range(a.window)}.</p>
		{:else}
			<p class="mb-3 text-xs text-muted-foreground">{range(a.window)}</p>
			<SegBar title="Sessions by channel" format={(v) => `${v.toLocaleString('en-US')} sessions`} parts={channelParts(a.channels)} />
			<div class="mt-3"><DataTable rows={a.channels} cols={[{ key: 'key', label: 'Channel', type: 'text' }, { key: 'sessions', label: 'Sessions', type: 'int' }, { key: 'share', label: 'Share', type: 'pct' }, { key: 'sessionsDelta', label: 'Δ sessions', type: 'delta' }, { key: 'engagementRate', label: 'Engaged', type: 'pct' }, { key: 'keyEvents', label: 'Key events', type: 'int' }]} sortKey="sessions" filterable={false} pageSize={8} /></div>
		{/if}
	</section>
	<section class="card p-4">
		<h2 class="mb-1 text-sm font-medium">Top sources <span class="font-normal text-muted-foreground">· GA4 source / medium</span></h2>
		{#if !a}{@render connect('GA4')}
		{:else if !a.synced}<p class="text-sm text-muted-foreground">Appears after the first GA4 sync.</p>
		{:else if !a.sources}<p class="text-sm text-muted-foreground">Sources are kept for the 7d, 28d, 3m, 6m and 16m periods; pick one of those (or they appear after the next GA4 sync).</p>
		{:else}
			<p class="mb-3 text-xs text-muted-foreground">{range(a.sources.window)} · <a class="underline" href="analytics?days={data.days}&section=sources">all sources</a></p>
			<BarList limit={10} items={a.sources.rows.map((r) => ({ label: r.source, note: r.medium, value: r.sessions, pii: true }))} unit="sessions" />
		{/if}
		{#if c?.synced && c.referrers.length}
			<h3 class="mt-4 mb-2 text-xs font-medium text-muted-foreground">Referring pages · Clarity, ~24h to {c.day}</h3>
			<BarList limit={5} color="var(--chart-2)" items={c.referrers.map((r) => ({ label: r.name, value: r.sessions, pii: true }))} unit="sessions" />
		{/if}
	</section>
</div>

<!-- Who: countries, devices, new vs returning -->
<section class="card mb-4 p-4">
	<h2 class="mb-3 text-sm font-medium">Top countries</h2>
	<div class="grid grid-cols-1 gap-6 md:grid-cols-3">
		<div>
			<h3 class="mb-2 text-xs font-medium text-muted-foreground">Google clicks · {range(g.window)}</h3>
			{#if g.countries.length}<BarList limit={8} items={g.countries.map((r) => ({ label: r.key, value: r.clicks }))} />{:else}<p class="text-sm text-muted-foreground">No clicks in this period.</p>{/if}
		</div>
		<div>
			<h3 class="mb-2 text-xs font-medium text-muted-foreground">GA4 sessions{#if a?.synced} · {range(a.window)}{/if}</h3>
			{#if !a}{@render connect('GA4')}
			{:else if !a.synced || !a.breakdowns}<p class="text-sm text-muted-foreground">{a.synced && a.breakdownsError ? `Could not be fetched on the last sync (will retry): ${a.breakdownsError}` : 'Appears after the next GA4 sync.'}</p>
			{:else if a.breakdowns.countries.length}<BarList limit={8} color="var(--chart-2)" items={a.breakdowns.countries.map((r) => ({ label: r.key, value: r.sessions }))} />
			{:else}<p class="text-sm text-muted-foreground">No sessions in this period.</p>{/if}
		</div>
		<div>
			<h3 class="mb-2 text-xs font-medium text-muted-foreground">Clarity sessions{#if c?.synced} · ~24h to {c.day}{/if}</h3>
			{#if !c}{@render connect('Clarity')}
			{:else if !c.synced}<p class="text-sm text-muted-foreground">Appears after the first Clarity sync.</p>
			{:else if c.countries.length}<BarList limit={8} color="var(--chart-3)" items={c.countries.map((r) => ({ label: r.name, value: r.sessions }))} />
			{:else}<p class="text-sm text-muted-foreground">No sessions in the snapshot.</p>{/if}
		</div>
	</div>
</section>

<section class="card mb-4 p-4">
	<h2 class="mb-3 text-sm font-medium">Devices and visitors</h2>
	<div class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
		<div>
			<h3 class="mb-2 text-xs font-medium text-muted-foreground">Google clicks</h3>
			{#if g.devices.length}<SegBar title="Google clicks by device" parts={devParts(g.devices.map((r) => ({ key: r.key, value: r.clicks })))} />{:else}<p class="text-sm text-muted-foreground">No clicks.</p>{/if}
		</div>
		<div>
			<h3 class="mb-2 text-xs font-medium text-muted-foreground">GA4 sessions</h3>
			{#if a?.synced && a.breakdowns?.devices.length}<SegBar title="GA4 sessions by device" parts={devParts(a.breakdowns.devices.map((r) => ({ key: r.key, value: r.sessions })))} />{:else}<p class="text-sm text-muted-foreground">{a ? 'Appears after the next GA4 sync.' : 'GA4 not linked.'}</p>{/if}
		</div>
		<div>
			<h3 class="mb-2 text-xs font-medium text-muted-foreground">Clarity sessions</h3>
			{#if c?.synced && c.devices.length}<SegBar title="Clarity sessions by device" parts={devParts(c.devices.map((r) => ({ key: r.name, value: r.sessions })))} />{:else}<p class="text-sm text-muted-foreground">{c ? 'Appears after the first Clarity sync.' : 'Clarity not linked.'}</p>{/if}
		</div>
		<div>
			<h3 class="mb-2 text-xs font-medium text-muted-foreground">New vs returning · GA4</h3>
			{#if a?.synced && a.breakdowns?.visitors.length}<SegBar title="GA4 sessions, new vs returning" parts={a.breakdowns.visitors.map((r, i) => ({ label: VISITOR[r.key] ?? r.key, value: r.sessions, color: CHANNEL_COLORS[i] ?? 'var(--muted-foreground)' }))} />{:else}<p class="text-sm text-muted-foreground">{a ? 'Appears after the next GA4 sync.' : 'GA4 not linked.'}</p>{/if}
		</div>
	</div>
</section>

<!-- What: pages and searches -->
<div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
	<section class="card p-4">
		<h2 class="mb-1 text-sm font-medium">Top pages <span class="font-normal text-muted-foreground">· Google clicks</span></h2>
		<p class="mb-3 text-xs text-muted-foreground">{range(g.window)} · <a class="underline" href="pages?days={data.days}">every page, all sources</a></p>
		{#if g.pages.length}<BarList limit={10} items={g.pages.map((r) => ({ label: path(r.page), value: r.clicks, note: `pos ${fmtPos(r.position)}`, pii: true }))} unit="clicks" />{:else}<p class="text-sm text-muted-foreground">No clicks in this period.</p>{/if}
		{#if c?.synced && c.pages.length}
			<h3 class="mt-4 mb-2 text-xs font-medium text-muted-foreground">Most visited · Clarity, ~24h to {c.day}</h3>
			<BarList limit={5} color="var(--chart-3)" items={c.pages.map((r) => ({ label: path(r.name), value: r.sessions, pii: true }))} unit="visits" />
		{/if}
	</section>
	<section class="card p-4">
		<h2 class="mb-1 text-sm font-medium">Top searches <span class="font-normal text-muted-foreground">· Google clicks</span></h2>
		<p class="mb-3 text-xs text-muted-foreground">{range(g.window)} · <a class="underline" href="queries?days={data.days}">all searches</a></p>
		{#if g.queries.length}<BarList limit={10} items={g.queries.map((r) => ({ label: r.query, value: r.clicks, note: `pos ${fmtPos(r.position)}`, pii: true }))} unit="clicks" />{:else}<p class="text-sm text-muted-foreground">No listed searches with clicks in this period.</p>{/if}

	</section>
</div>

<!-- Where visits land, and what they convert into (GA4) -->
<div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
	<section class="card p-4">
		<h2 class="mb-1 text-sm font-medium">Landing pages <span class="font-normal text-muted-foreground">· GA4 sessions, every channel</span></h2>
		{#if !a}{@render connect('GA4')}
		{:else if !a.synced}<p class="text-sm text-muted-foreground">Appears after the first GA4 sync.</p>
		{:else if !a.landing}<p class="text-sm text-muted-foreground">Landing pages are kept for the 7d, 28d, 3m, 6m and 16m periods; pick one of those (or they appear after the next GA4 sync).</p>
		{:else if !a.landing.rows.length}<p class="text-sm text-muted-foreground">No sessions in {range(a.landing.window)}.</p>
		{:else}
			<p class="mb-3 text-xs text-muted-foreground">{range(a.landing.window)} · the note is each page's biggest channel · <a class="underline" href="analytics?days={data.days}&section=landing">all landing pages</a></p>
			<BarList limit={10} color="var(--chart-2)" items={a.landing.rows.map((r) => ({ label: r.page, value: r.sessions, note: `${r.topChannel} ${fmtPct(r.channels[0]?.sessions / r.sessions, 0)}`, pii: true }))} unit="sessions" />
		{/if}
	</section>
	<section class="card p-4">
		<h2 class="mb-1 text-sm font-medium">Key events <span class="font-normal text-muted-foreground">· GA4, by event name</span></h2>
		{#if !a}{@render connect('GA4')}
		{:else if !a.synced || !a.keyEventsByName || a.keyEventsByName.status === 'pending'}<p class="text-sm text-muted-foreground">Appears after the next GA4 sync.</p>
		{:else if a.keyEventsByName.status === 'failed'}<p class="text-sm text-warn">Could not be fetched on the last sync (will retry): {a.keyEventsByName.error}</p>
		{:else if a.keyEventsByName.status === 'none'}<p class="text-sm text-muted-foreground">{noKeyEventsText(a.keyEventsByName.marked)}</p>
		{:else if !a.keyEventsByName.events.length}<p class="text-sm text-muted-foreground">No key events in {range(a.keyEventsByName.window)}.</p>
		{:else}
			<p class="mb-3 text-xs text-muted-foreground">{range(a.keyEventsByName.window)} · {fmtInt(a.keyEventsByName.total)} in all</p>
			<BarList limit={8} color="var(--chart-3)" items={a.keyEventsByName.events.map((e) => ({ label: e.event, value: e.keyEvents, note: e.keyEventsDelta == null ? '' : `${e.keyEventsDelta >= 0 ? '+' : ''}${fmtPct(e.keyEventsDelta, 0)}` }))} />
		{/if}
	</section>
</div>

<!-- How visitors behave -->
<section class="card mb-4 p-4">
	<h2 class="mb-1 text-sm font-medium">How visitors behave <span class="font-normal text-muted-foreground">· Clarity</span></h2>
	{#if !c}{@render connect('Clarity')}
	{:else if !c.synced}<p class="text-sm text-muted-foreground">Appears after the first Clarity sync.</p>
	{:else}
		<p class="mb-3 text-xs text-muted-foreground">~24h to {c.day} · {fmtInt(c.sessions)} sessions, {fmtInt(c.users)} distinct users · <a class="underline" href="clarity">Clarity tab</a></p>
		<div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
			{@render kpi('Dead clicks', fmtPct(c.deadClicks), undefined, 'of sessions had one')}
			{@render kpi('Rage clicks', fmtPct(c.rageClicks), undefined, 'of sessions had one')}
			{@render kpi('Quick backs', fmtPct(c.quickBacks), undefined, 'of sessions went straight back')}
			{@render kpi('Script errors', fmtPct(c.scriptErrors), undefined, 'of sessions had one')}
			{@render kpi('Scroll depth', fmtPct(c.scrollDepth, 0), undefined, 'average, as Clarity reports it')}
			{@render kpi('Active time', secs(c.activeTime), undefined, `of ${secs(c.totalTime)} on the page, as Clarity reports it`)}
		</div>
		{#if c.history.length > 1}
			<h3 class="mt-4 mb-2 text-xs font-medium text-muted-foreground">Real visitors per stored snapshot</h3>
			<div class="tnum flex gap-4 overflow-x-auto text-xs">{#each c.history as h}<div><div class="text-muted-foreground">{h.day.slice(5)}</div><div class="font-medium">{fmtInt(h.humans)}</div></div>{/each}</div>
		{/if}
	{/if}
</section>
