<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { fmtInt, ago } from '$lib/format';
	import ClarityInstall from '$lib/components/ClarityInstall.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
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
</script>

<ClarityInstall install={data.install} scan={data.scan} gtm={data.gtm} readOnly={data.readOnly} connected={data.linked} sessions={data.linked && data.totals ? headline.sessions : null} form={form ?? null} />

{#if !data.linked}
	<div class="card p-5 text-sm"><p class="mb-1 font-medium">Connect Clarity's data</p><p class="mb-3 text-muted-foreground">The script records visits; an API token lets SEOConsole read them (Clarity: <b>Settings → Data Export → Generate new API token</b>). Then rage clicks, dead clicks and scroll depth show next to your search data.</p><a class="btn btn-primary" href="/connect">Paste the token on Connect</a></div>
{:else}
	<div class="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
		<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Sessions (last 24h at snapshot)</div><div class="tnum text-xl font-semibold">{fmtInt(headline.sessions)}</div></div>
		<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">of which bots</div><div class="tnum text-xl font-semibold">{fmtInt(headline.bots)}</div></div>
		<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Distinct users</div><div class="tnum text-xl font-semibold">{fmtInt(headline.users)}</div></div>
		<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">API calls left today</div><div class="tnum text-xl font-semibold">{data.callsLeft}<span class="text-sm text-muted-foreground"> / 10</span></div>
			<form method="POST" action="/connect?/resync" use:enhance><input type="hidden" name="siteId" value={page.params.id} /><input type="hidden" name="kind" value="clarity" /><button class="btn btn-ghost btn-xs">refresh now (uses calls)</button></form></div>
	</div>
	<p class="mb-3 text-xs text-muted-foreground">Snapshot {data.totals?.day ?? '–'} · {data.status.state === 'error' ? data.status.message : 'synced ' + ago(data.status.lastSync)}. Clarity allows 10 API calls a day and shows only 1–3 days, so this refreshes every 8½ hours (9 calls, one kept for you), alternating the device and channel breakdowns, and keeps a daily history. Columns are as Clarity returns them.</p>

	{#if data.history.length > 1}
		<section class="card mb-4 p-4"><h2 class="mb-2 font-medium">Stored daily snapshots</h2>
			<div class="tnum flex gap-4 overflow-x-auto text-xs">{#each data.history as h}<div><div class="text-muted-foreground">{h.day.slice(5)}</div><div class="font-medium">{fmtInt(h.sessions)}</div></div>{/each}</div>
		</section>
	{/if}

	<div class="mb-4 flex flex-wrap items-center gap-3">
		<a class="btn btn-sm" href={data.clarityUrl} target="_blank" rel="noopener noreferrer">Open in Clarity ↗</a>
		<span class="text-xs text-muted-foreground">Recordings and heatmaps stay in Clarity. To watch one page, open Recordings and add the filter <b>Visited URL</b> with its address.</span>
	</div>

	{#if data.channels}
		<section class="mb-5">
			<h2 class="mb-1 font-medium">Behaviour by traffic channel</h2>
			<p class="mb-2 text-xs text-muted-foreground">Snapshot {data.channels.day}. Do search visitors struggle more than others? A channel with far more rage or dead clicks points at a landing page that does not match what it promised.</p>
			<DataTable
				rows={data.channels.rows}
				cols={[
					{ key: 'value', label: 'Channel', type: 'text' },
					{ key: 'sessions', label: 'Sessions', type: 'int', bar: true },
					{ key: 'rageClicks', label: 'Rage clicks', title: 'Share of sessions with rage clicks', type: 'pct' },
					{ key: 'deadClicks', label: 'Dead clicks', title: 'Share of sessions with clicks that did nothing', type: 'pct' },
					{ key: 'quickBacks', label: 'Quick backs', title: 'Share of sessions that left a page and came straight back', type: 'pct' },
					{ key: 'scrollDepth', label: 'Scroll depth', type: 'pct' },
					{ key: 'activeTime', label: 'Active time', type: 'dur' }
				]}
				sortKey="sessions"
				filterable={false}
			/>
		</section>
	{:else}
		<p class="mb-5 text-xs text-muted-foreground">Behaviour by traffic channel appears after the next Clarity refresh (it alternates with the device breakdown to stay inside Clarity's 10 calls a day).</p>
	{/if}

	{#if data.frustrated.length}
		<section class="mb-5">
			<h2 class="mb-1 font-medium">Pages to watch in Clarity</h2>
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
		</section>
	{/if}

	{#each sections as [title, snap]}
		{#if snap}
			<h2 class="mt-5 mb-2 font-medium">{title}</h2>
			{#each snap.metrics as m}
				{@const keys = keysOf(m)}
				<div class="card mb-3 overflow-x-auto">
					<div class="border-b px-3 py-2 text-sm font-medium" style="border-color:var(--border)">{pretty(m.metricName)}</div>
					<table class="w-full">
						<thead><tr>{#each keys as k}<th class="th">{pretty(k)}</th>{/each}</tr></thead>
						<tbody>{#each m.information.slice(0, 15) as r}<tr>{#each keys as k}<td class="td tnum">{r[k] === undefined ? '' : fmt(r[k])}</td>{/each}</tr>{/each}</tbody>
					</table>
				</div>
			{/each}
		{/if}
	{/each}
{/if}
