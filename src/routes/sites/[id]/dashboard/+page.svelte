<script lang="ts">
	import Delta from '$lib/components/Delta.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { Plug, RefreshCw, Inbox, TriangleAlert, CalendarRange, Waypoints, Share2, Globe, Smartphone, FileText, Search, DoorOpen, Flag, MousePointerClick } from '@lucide/svelte';
	import type { Icon } from '$lib/icons';
	import BarList from '$lib/components/viz/BarList.svelte';
	import SegBar from '$lib/components/viz/SegBar.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import SectionTabs from '$lib/components/SectionTabs.svelte';
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
	let view = $state('');
</script>

{#snippet connect(name: string)}
	<EmptyState compact icon={Plug} tone="violet" title="{name} is not linked to this site." text="Connect it to see it here.">
		<a class="btn btn-primary btn-sm" href="/connect"><Plug class="size-3.5" aria-hidden="true" />Connect {name}</a>
	</EmptyState>
{/snippet}
{#snippet pending(text: string)}<EmptyState compact icon={RefreshCw} title={text} />{/snippet}
{#snippet nothing(text: string, icon: Icon = Inbox)}<EmptyState compact {icon} title={text} />{/snippet}
{#snippet failed(text: string)}<EmptyState compact icon={TriangleAlert} tone="red" title="Could not be fetched on the last sync (will retry)." {text} />{/snippet}
{#snippet heading(icon: Icon, tone: string, title: string, note: string = '')}
	{@const G = icon}
	<h3 class="mb-1 flex items-center gap-2 text-sm font-medium"><span class="ibadge ibadge-sm tone-{tone}" aria-hidden="true"><G class="size-3.5" /></span><span>{title}{#if note} <span class="font-normal text-muted-foreground">· {note}</span>{/if}</span></h3>
{/snippet}
{#snippet kpi(label: string, value: string, delta: number | null | undefined, sub: string, href: string | null = null)}
	<div class="card px-3 py-2">
		<div class="text-xs text-muted-foreground">{label}</div>
		<div class="tnum text-xl font-semibold">{#if href}<a class="hover:underline" {href}>{value}</a>{:else}{value}{/if}</div>
		{#if delta !== undefined}<Delta value={delta} why="Nothing in the period before to compare with" />{/if}
		<div class="truncate text-[11px] text-muted-foreground" title={sub}>{sub}</div>
	</div>
{/snippet}

<PageHeader tab="/dashboard" title="All sources" lead="Search Console, GA4, Bing and Clarity side by side. Each card shows the dates its source covers.">
	<p>Sources report on different clocks: Search Console runs about two days behind, GA4 about a day, and Clarity only exposes the last 1 to 3 days (shown from the newest stored snapshot). So "24h" here is each source's newest day, and the figures are not meant to add up across sources. Clicks are counted by the search engine; sessions and users by the tags on your pages, which miss visitors who block them.</p>
	<p>Countries and devices from Search Console come from the searches Google lists, so they can total less than all clicks. Changes (▲/▼) are against the period of the same length just before.</p>
	{#snippet actions()}<a class="btn btn-sm" href="/connect"><Plug class="size-3.5" aria-hidden="true" />Connect sources</a>{/snippet}
</PageHeader>

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

<SectionTabs bind:value={view} label="All sources details" tabs={[
	{ id: 'traffic', label: 'Traffic' },
	{ id: 'audience', label: 'Countries & devices' },
	{ id: 'content', label: 'Pages & searches' },
	{ id: 'conversions', label: 'Landing pages & key events' },
	{ id: 'behaviour', label: 'Behaviour' }
]} />
{#if view === 'traffic'}
<div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
	<section class="card p-4">
		{@render heading(Waypoints, 'violet', 'Traffic by channel', 'GA4')}
		{#if !a}{@render connect('GA4')}
		{:else if !a.synced}{@render pending('Appears after the first GA4 sync.')}
		{:else if !a.channels.length}{@render nothing(`No sessions in ${range(a.window)}.`)}
		{:else}
			<p class="mb-3 text-xs text-muted-foreground">{range(a.window)}</p>
			<SegBar title="Sessions by channel" format={(v) => `${v.toLocaleString('en-US')} sessions`} parts={channelParts(a.channels)} />
			<div class="mt-3"><DataTable rows={a.channels} cols={[{ key: 'key', label: 'Channel', type: 'text' }, { key: 'sessions', label: 'Sessions', type: 'int' }, { key: 'share', label: 'Share', type: 'pct' }, { key: 'sessionsDelta', label: 'Δ sessions', type: 'delta' }, { key: 'engagementRate', label: 'Engaged', type: 'pct' }, { key: 'keyEvents', label: 'Key events', type: 'int' }]} sortKey="sessions" filterable={false} pageSize={8} /></div>
		{/if}
	</section>
	<section class="card p-4">
		{@render heading(Share2, 'violet', 'Top sources', 'GA4 source / medium')}
		{#if !a}{@render connect('GA4')}
		{:else if !a.synced}{@render pending('Appears after the first GA4 sync.')}
		{:else if !a.sources}{@render nothing('Sources are kept for the 7d, 28d, 3m, 6m and 16m periods; pick one of those (or they appear after the next GA4 sync).', CalendarRange)}
		{:else}
			<p class="mb-3 text-xs text-muted-foreground">{range(a.sources.window)} · <a class="underline" href="analytics?days={data.days}&section=sources">all sources</a></p>
			<BarList limit={10} items={a.sources.rows.map((r) => ({ label: r.source, note: r.medium, value: r.sessions, pii: true }))} unit="sessions" />
		{/if}
		{#if c?.synced && c.referrers.length}
			<h4 class="mt-4 mb-2 text-xs font-medium text-muted-foreground">Referring pages · Clarity, ~24h to {c.day}</h4>
			<BarList limit={5} color="var(--chart-2)" items={c.referrers.map((r) => ({ label: r.name, value: r.sessions, pii: true }))} unit="sessions" />
		{/if}
	</section>
</div>
{:else if view === 'audience'}
<section class="card mb-4 p-4">
	<div class="mb-3">{@render heading(Globe, 'violet', 'Top countries')}</div>
	<div class="grid grid-cols-1 gap-6 md:grid-cols-3">
		<div>
			<h4 class="mb-2 text-xs font-medium text-muted-foreground">Google clicks · {range(g.window)}</h4>
			{#if g.countries.length}<BarList limit={8} items={g.countries.map((r) => ({ label: r.key, value: r.clicks }))} />{:else}{@render nothing('No clicks in this period.')}{/if}
		</div>
		<div>
			<h4 class="mb-2 text-xs font-medium text-muted-foreground">GA4 sessions{#if a?.synced} · {range(a.window)}{/if}</h4>
			{#if !a}{@render connect('GA4')}
			{:else if !a.synced || !a.breakdowns}{#if a.synced && a.breakdownsError}{@render failed(a.breakdownsError)}{:else}{@render pending('Appears after the next GA4 sync.')}{/if}
			{:else if a.breakdowns.countries.length}<BarList limit={8} color="var(--chart-2)" items={a.breakdowns.countries.map((r) => ({ label: r.key, value: r.sessions }))} />
			{:else}{@render nothing('No sessions in this period.')}{/if}
		</div>
		<div>
			<h4 class="mb-2 text-xs font-medium text-muted-foreground">Clarity sessions{#if c?.synced} · ~24h to {c.day}{/if}</h4>
			{#if !c}{@render connect('Clarity')}
			{:else if !c.synced}{@render pending('Appears after the first Clarity sync.')}
			{:else if c.countries.length}<BarList limit={8} color="var(--chart-3)" items={c.countries.map((r) => ({ label: r.name, value: r.sessions }))} />
			{:else}{@render nothing('No sessions in the snapshot.')}{/if}
		</div>
	</div>
</section>

<section class="card mb-4 p-4">
	<div class="mb-3">{@render heading(Smartphone, 'violet', 'Devices and visitors')}</div>
	<div class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
		<div>
			<h4 class="mb-2 text-xs font-medium text-muted-foreground">Google clicks</h4>
			{#if g.devices.length}<SegBar title="Google clicks by device" parts={devParts(g.devices.map((r) => ({ key: r.key, value: r.clicks })))} />{:else}{@render nothing('No clicks.')}{/if}
		</div>
		<div>
			<h4 class="mb-2 text-xs font-medium text-muted-foreground">GA4 sessions</h4>
			{#if a?.synced && a.breakdowns?.devices.length}<SegBar title="GA4 sessions by device" parts={devParts(a.breakdowns.devices.map((r) => ({ key: r.key, value: r.sessions })))} />{:else if a}{@render pending('Appears after the next GA4 sync.')}{:else}{@render nothing('GA4 not linked.', Plug)}{/if}
		</div>
		<div>
			<h4 class="mb-2 text-xs font-medium text-muted-foreground">Clarity sessions</h4>
			{#if c?.synced && c.devices.length}<SegBar title="Clarity sessions by device" parts={devParts(c.devices.map((r) => ({ key: r.name, value: r.sessions })))} />{:else if c}{@render pending('Appears after the first Clarity sync.')}{:else}{@render nothing('Clarity not linked.', Plug)}{/if}
		</div>
		<div>
			<h4 class="mb-2 text-xs font-medium text-muted-foreground">New vs returning · GA4</h4>
			{#if a?.synced && a.breakdowns?.visitors.length}<SegBar title="GA4 sessions, new vs returning" parts={a.breakdowns.visitors.map((r, i) => ({ label: VISITOR[r.key] ?? r.key, value: r.sessions, color: CHANNEL_COLORS[i] ?? 'var(--muted-foreground)' }))} />{:else if a}{@render pending('Appears after the next GA4 sync.')}{:else}{@render nothing('GA4 not linked.', Plug)}{/if}
		</div>
	</div>
</section>
{:else if view === 'content'}
<div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
	<section class="card p-4">
		{@render heading(FileText, 'violet', 'Top pages', 'Google clicks')}
		<p class="mb-3 text-xs text-muted-foreground">{range(g.window)} · <a class="underline" href="pages?days={data.days}">every page, all sources</a></p>
		{#if g.pages.length}<BarList limit={10} items={g.pages.map((r) => ({ label: path(r.page), value: r.clicks, note: `pos ${fmtPos(r.position)}`, pii: true }))} unit="clicks" />{:else}{@render nothing('No clicks in this period.')}{/if}
		{#if c?.synced && c.pages.length}
			<h4 class="mt-4 mb-2 text-xs font-medium text-muted-foreground">Most visited · Clarity, ~24h to {c.day}</h4>
			<BarList limit={5} color="var(--chart-3)" items={c.pages.map((r) => ({ label: path(r.name), value: r.sessions, pii: true }))} unit="visits" />
		{/if}
	</section>
	<section class="card p-4">
		{@render heading(Search, 'violet', 'Top searches', 'Google clicks')}
		<p class="mb-3 text-xs text-muted-foreground">{range(g.window)} · <a class="underline" href="queries?days={data.days}">all searches</a></p>
		{#if g.queries.length}<BarList limit={10} items={g.queries.map((r) => ({ label: r.query, value: r.clicks, note: `pos ${fmtPos(r.position)}`, pii: true }))} unit="clicks" />{:else}{@render nothing('No listed searches with clicks in this period.')}{/if}

	</section>
</div>
{:else if view === 'conversions'}
<div class="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
	<section class="card p-4">
		{@render heading(DoorOpen, 'violet', 'Landing pages', 'GA4 sessions, every channel')}
		{#if !a}{@render connect('GA4')}
		{:else if !a.synced}{@render pending('Appears after the first GA4 sync.')}
		{:else if !a.landing}{@render nothing('Landing pages are kept for the 7d, 28d, 3m, 6m and 16m periods; pick one of those (or they appear after the next GA4 sync).', CalendarRange)}
		{:else if !a.landing.rows.length}{@render nothing(`No sessions in ${range(a.landing.window)}.`)}
		{:else}
			<p class="mb-3 text-xs text-muted-foreground">{range(a.landing.window)} · the note is each page's biggest channel · <a class="underline" href="analytics?days={data.days}&section=landing">all landing pages</a></p>
			<BarList limit={10} color="var(--chart-2)" items={a.landing.rows.map((r) => ({ label: r.page, value: r.sessions, note: `${r.topChannel} ${fmtPct(r.channels[0]?.sessions / r.sessions, 0)}`, pii: true }))} unit="sessions" />
		{/if}
	</section>
	<section class="card p-4">
		{@render heading(Flag, 'violet', 'Key events', 'GA4, by event name')}
		{#if !a}{@render connect('GA4')}
		{:else if !a.synced || !a.keyEventsByName || a.keyEventsByName.status === 'pending'}{@render pending('Appears after the next GA4 sync.')}
		{:else if a.keyEventsByName.status === 'failed'}{@render failed(a.keyEventsByName.error ?? '')}
		{:else if a.keyEventsByName.status === 'none'}{@render nothing(noKeyEventsText(a.keyEventsByName.marked), Flag)}
		{:else if !a.keyEventsByName.events.length}{@render nothing(`No key events in ${range(a.keyEventsByName.window)}.`, Flag)}
		{:else}
			<p class="mb-3 text-xs text-muted-foreground">{range(a.keyEventsByName.window)} · {fmtInt(a.keyEventsByName.total)} in all</p>
			<BarList limit={8} color="var(--chart-3)" items={a.keyEventsByName.events.map((e) => ({ label: e.event, value: e.keyEvents, note: e.keyEventsDelta == null ? '' : `${e.keyEventsDelta >= 0 ? '+' : ''}${fmtPct(e.keyEventsDelta, 0)}` }))} />
		{/if}
	</section>
</div>
{:else}
<section class="card mb-4 p-4">
	{@render heading(MousePointerClick, 'violet', 'How visitors behave', 'Clarity')}
	{#if !c}{@render connect('Clarity')}
	{:else if !c.synced}{@render pending('Appears after the first Clarity sync.')}
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
			<h4 class="mt-4 mb-2 text-xs font-medium text-muted-foreground">Real visitors per stored snapshot</h4>
			<div class="tnum flex gap-4 overflow-x-auto text-xs">{#each c.history as h}<div><div class="text-muted-foreground">{h.day.slice(5)}</div><div class="font-medium">{fmtInt(h.humans)}</div></div>{/each}</div>
		{/if}
	{/if}
</section>
{/if}
