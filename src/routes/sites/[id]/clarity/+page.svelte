<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { fmtInt, ago } from '$lib/format';
	import ClarityInstall from '$lib/components/ClarityInstall.svelte';
	import SectionTabs from '$lib/components/SectionTabs.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusPill from '$lib/components/StatusPill.svelte';
	import { ExternalLink, MousePointerClick, RefreshCw, CircleCheck, Hourglass } from '@lucide/svelte';
	let { data, form } = $props();

	type Metric = { metricName: string; information: Record<string, string | number>[] };
	const pretty = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2');
	const fmt = (v: string | number) => (typeof v === 'number' ? (Number.isInteger(v) ? fmtInt(v) : v.toFixed(2)) : /^-?\d+(\.\d+)?$/.test(v) ? fmtInt(Number(v)) : v);
	const keysOf = (m: Metric) => [...new Set(m.information.flatMap((r) => Object.keys(r)))];
	type Snap = { day: string; metrics: Metric[] } | null;
	const sections = $derived(data.linked ? ([['Totals', data.totals], ['By page (URL)', data.byUrl], ['By device', data.byDevice]] as [string, Snap][]) : []);
	const headline = $derived.by(() => {
		const t = (data.linked && data.totals?.metrics.find((m: Metric) => m.metricName === 'Traffic')?.information) || [];
		const sum = (k: string) => t.reduce((a: number, x: Record<string, string | number>) => a + Number(x[k] ?? 0), 0);
		return { sessions: sum('totalSessionCount'), bots: sum('totalBotSessionCount'), users: sum('distinctUserCount') || sum('distantUserCount') };
	});
	let view = $state('');
	// Once Clarity is installed, connected and recording, the setup checklist folds to one line.
	const recording = $derived(data.linked && ['on-page', 'via-gtm', 'unseen'].includes(data.install.state) && headline.sessions > 0 && !data.install.findings.some((f: { severity: string }) => f.severity !== 'info') && !form);
	const behaviourCols = (label: string) => [
		{ key: 'value', label, type: 'text' as const },
		{ key: 'sessions', label: 'Sessions', type: 'int' as const, bar: true },
		{ key: 'rageClicks', label: 'Rage clicks', title: 'Share of sessions with rage clicks', type: 'pct' as const },
		{ key: 'deadClicks', label: 'Dead clicks', title: 'Share of sessions with clicks that did nothing', type: 'pct' as const },
		{ key: 'quickBacks', label: 'Quick backs', title: 'Share of sessions that left a page and came straight back', type: 'pct' as const },
		{ key: 'scrollDepth', label: 'Scroll depth', type: 'pct' as const },
		{ key: 'activeTime', label: 'Active time', type: 'dur' as const }
	];
</script>

<PageHeader tab="/clarity" title="Clarity" lead="Rage clicks, dead clicks and scroll depth from Microsoft Clarity, next to your search data.">
	<p>Microsoft Clarity snapshot, once linked. Clarity only exposes the last 1 to 3 days and 10 API calls a day, so the daily snapshot is refreshed every 8½ hours (9 calls a day), alternating the device and channel breakdowns, and kept.</p>
	{#snippet actions()}{#if data.linked}<a class="btn btn-sm" href={data.clarityUrl} target="_blank" rel="noopener noreferrer"><ExternalLink class="size-3.5" />Open in Clarity</a>{/if}{/snippet}
</PageHeader>

{#if recording}
	<details class="card mb-4 px-4 py-3">
		<summary class="cursor-pointer text-sm select-none"><StatusPill tone="good">Clarity is installed and recording</StatusPill> <span class="text-xs text-muted-foreground">· setup details</span></summary>
		<div class="mt-3"><ClarityInstall install={data.install} scan={data.scan} gtm={data.gtm} readOnly={data.readOnly} connected={data.linked} sessions={headline.sessions} form={form ?? null} /></div>
	</details>
{:else}
	<ClarityInstall install={data.install} scan={data.scan} gtm={data.gtm} readOnly={data.readOnly} connected={data.linked} sessions={data.linked && data.totals ? headline.sessions : null} form={form ?? null} />
{/if}

{#if !data.linked}
	<EmptyState icon={MousePointerClick} tone="violet" title="Connect Clarity's data" text="The script records visits; an API token lets SEOConsole read them (Clarity: Settings → Data Export → Generate new API token). Then rage clicks, dead clicks and scroll depth show next to your search data.">
		<a class="btn btn-primary btn-sm" href="/connect"><img src="/logos/clarity.png" alt="" width="14" height="14" class="size-3.5 object-contain" />Paste the token on Connect</a>
	</EmptyState>
{:else}
	<div class="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
		<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Sessions, last 24h</div><div class="tnum text-xl font-semibold">{fmtInt(headline.sessions)}</div><div class="text-xs text-muted-foreground">{fmtInt(headline.bots)} of them bots</div></div>
		<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Distinct users</div><div class="tnum text-xl font-semibold">{fmtInt(headline.users)}</div></div>
		<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Snapshot</div><div class="text-xl font-semibold">{data.totals?.day ?? '–'}</div><div class="truncate text-xs text-muted-foreground">{data.status.state === 'error' ? data.status.message : 'read ' + ago(data.status.lastSync)}</div></div>
		<div class="card px-3 py-2" title="Clarity allows 10 API calls a day and shows only 1 to 3 days, so SEOConsole refreshes every 8½ hours (9 calls, one kept for you), alternating the device and channel breakdowns, and keeps a daily history."><div class="text-xs text-muted-foreground">API calls left today</div><div class="tnum text-xl font-semibold">{data.callsLeft}<span class="text-sm text-muted-foreground"> / 10</span></div>
			<form method="POST" action="/connect?/resync" use:enhance><input type="hidden" name="siteId" value={page.params.id} /><input type="hidden" name="kind" value="clarity" /><button class="btn btn-ghost btn-xs"><RefreshCw class="size-3" />refresh now (uses calls)</button></form></div>
	</div>
	<p class="mb-4 text-xs text-muted-foreground">Recordings and heatmaps are in Clarity (<a class="underline" href={data.clarityUrl} target="_blank" rel="noopener noreferrer">open it</a>): filter Recordings by <b>Visited URL</b> to watch one page.</p>

	<SectionTabs bind:value={view} label="Clarity details" tabs={[
		{ id: 'pages', label: 'Pages to watch', count: data.frustrated.length || null },
		{ id: 'channel', label: 'By channel' },
		{ id: 'device', label: 'By device' },
		{ id: 'raw', label: 'Raw data' }
	]} />

	{#if view === 'pages'}
		{#if data.frustrated.length}
			<p class="mb-2 text-xs text-muted-foreground">Where the largest share of sessions hit rage or dead clicks in the latest snapshot. Watch a few recordings of the top ones.</p>
			<DataTable
				rows={data.frustrated}
				cols={[
					{ key: 'url', label: 'Page', type: 'text', pii: true },
					{ key: 'sessions', label: 'Sessions', type: 'int' },
					{ key: 'rageClicks', label: 'With rage clicks', type: 'int' },
					{ key: 'deadClicks', label: 'With dead clicks', type: 'int' },
					{ key: 'frustration', label: 'Share', title: 'Sessions with rage or dead clicks, as a share of the page\'s sessions (a session with both counts twice)', type: 'pct', bar: true }
				]}
				sortKey="frustration"
				filterable={false}
				pageSize={10}
			/>
		{:else}
			<EmptyState icon={CircleCheck} tone="green" title="No page had rage or dead clicks in the latest snapshot." />
		{/if}
	{:else if view === 'channel'}
		{#if data.channels}
			<p class="mb-2 text-xs text-muted-foreground">Snapshot {data.channels.day}. A channel with far more rage or dead clicks points at landing pages that do not match what they promised.</p>
			<DataTable rows={data.channels.rows} cols={behaviourCols('Channel')} sortKey="sessions" filterable={false} />
		{:else}
			<EmptyState icon={Hourglass} title="Appears after the next Clarity refresh." text="It alternates with the device breakdown to stay inside Clarity's 10 calls a day." />
		{/if}
	{:else if view === 'device'}
		{#if data.devices}
			<p class="mb-2 text-xs text-muted-foreground">Snapshot {data.devices.day}. Much worse numbers on mobile usually mean a layout or tap-target problem.</p>
			<DataTable rows={data.devices.rows} cols={behaviourCols('Device')} sortKey="sessions" filterable={false} />
		{:else}
			<EmptyState icon={Hourglass} title="Appears after the next Clarity refresh." text="It alternates with the channel breakdown to stay inside Clarity's 10 calls a day." />
		{/if}
	{:else}
		<p class="mb-3 text-xs text-muted-foreground">Every metric as Clarity's API returns it, for checking a number against Clarity itself.</p>
		{#if data.history.length > 1}
			<div class="card mb-3 p-3"><div class="mb-1 text-sm font-medium">Sessions per stored day</div>
				<div class="tnum flex gap-4 overflow-x-auto text-xs">{#each data.history as h}<div><div class="text-muted-foreground">{h.day.slice(5)}</div><div class="font-medium">{fmtInt(h.sessions)}</div></div>{/each}</div>
			</div>
		{/if}
		{#each sections as [title, snap]}
			{#if snap}
				<details class="card mb-3">
					<summary class="cursor-pointer px-3 py-2 text-sm font-medium select-none">{title} <span class="text-xs font-normal text-muted-foreground">· {snap.metrics.length} metrics</span></summary>
					{#each snap.metrics as m}
						{@const keys = keysOf(m)}
						<div class="overflow-x-auto border-t" style="border-color:var(--border)">
							<div class="px-3 pt-2 text-xs font-medium">{pretty(m.metricName)}</div>
							<table class="w-full">
								<thead><tr>{#each keys as k}<th class="th">{pretty(k)}</th>{/each}</tr></thead>
								<tbody>{#each m.information.slice(0, 15) as r}<tr>{#each keys as k}<td class="td tnum">{r[k] === undefined ? '' : fmt(r[k])}</td>{/each}</tr>{/each}</tbody>
							</table>
						</div>
					{/each}
				</details>
			{/if}
		{/each}
	{/if}
{/if}
