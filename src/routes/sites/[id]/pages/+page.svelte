<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import { page } from '$app/state';
	import DataTable from '$lib/components/DataTable.svelte';
	import Chart from '$lib/components/Chart.svelte';
	import SectionTabs from '$lib/components/SectionTabs.svelte';
	import SavedViews from '$lib/components/SavedViews.svelte';
	import { goto } from '$app/navigation';
	let { data } = $props();
	let open = $state<string | null>(null);
	let history = $state<any[]>([]);
	async function toggle(row: { url: string; gClicks: number | null }) {
		if (row.gClicks == null) return; // the full-history chart is Search Console's
		if (open === row.url) return (open = null);
		open = row.url;
		history = await fetch(`/sites/${page.params.id}/history?kind=page&value=${encodeURIComponent(row.url)}&days=480`).then((r) => r.json());
	}
	// One header band and tint per source.
	// Colours follow the dashboard's sources: Google green, GA4 orange, Bing blue.
	const T = { group: 'GA4 · all traffic', groupColor: '#ea580c' };
	const G = { group: 'Google', groupColor: '#16a34a' };
	const B = { group: 'Bing', groupColor: '#0284c7' };
	const A = { group: 'GA4 · Google organic', groupColor: '#ea580c' };
	const AI = { group: 'AI assistants · GA4', groupColor: '#6366f1' };
	const C = { group: 'Clarity · last 24 h', groupColor: '#7c3aed' };
	let view = $state('');
	const allCols = $derived([
		{ key: 'path', label: 'Page', type: 'link' as const, href: (r: { url: string }) => r.url, display: (r: { path: string }) => r.path },
		// Views work for any period (stored by day); sessions and top channel only for the preset lengths GA4 landing pages are pulled for.
		...(data.sources.views.hasData
			? [
					{ key: 'tViews', label: 'Views', type: 'int' as const, bar: true, deltaKey: 'tViewsD', title: 'GA4 page views: every view of this page from any channel, not only the visits that started on it, with the change against the previous period', ...T },
					{ key: 'title', label: 'Page title', type: 'text' as const, title: 'The title GA4 recorded most often for this page over the last 28 days', ...T }
				]
			: []),
		...(data.sources.all.hasData
			? [
					{ key: 'tSessions', label: 'Sessions', type: 'int' as const, bar: !data.sources.views.hasData, deltaKey: 'tSessionsD', title: 'Every GA4 session that landed on this page, from any channel (search, direct, social, referral, email, AI assistants…), with the change against the previous window', ...T },
					{ key: 'tTop', label: 'Top channel', type: 'text' as const, title: 'The GA4 channel group that sent the most sessions to this page', ...T }
				]
			: []),
		{ key: 'gClicks', label: 'Clicks', type: 'int' as const, bar: true, deltaKey: 'gClicksD', title: 'Google clicks, with the change against the previous period of the same length', ...G },
		{ key: 'gImpr', label: 'Impr.', type: 'int' as const, deltaKey: 'gImprD', title: 'Google impressions and their change', ...G },
		{ key: 'gCtr', label: 'CTR', type: 'pct' as const, ...G },
		{ key: 'gPos', label: 'Pos', type: 'pos' as const, title: 'Average Google position, weighted by impressions', ...G },
		...(data.sources.bing.hasData
			? [
					{ key: 'bClicks', label: 'Clicks', type: 'int' as const, deltaKey: 'bClicksD', title: 'Bing clicks, with the change against the previous period', ...B },
					{ key: 'bImpr', label: 'Impr.', type: 'int' as const, deltaKey: 'bImprD', ...B },
					{ key: 'bPos', label: 'Pos', type: 'pos' as const, title: 'Average Bing impression position', ...B }
				]
			: []),
		...(data.sources.ga4.hasData
			? [
					{ key: 'aSessions', label: 'Sessions', type: 'int' as const, deltaKey: 'aSessionsD', title: 'GA4 sessions that landed on this page from Google organic search', ...A },
					{ key: 'aEngaged', label: 'Engaged', type: 'pct' as const, title: 'Share of those sessions that were engaged', ...A },
					{ key: 'aKeyEvents', label: 'Key events', type: 'int' as const, deltaKey: 'aKeyEventsD', title: 'GA4 key events (conversions) from those sessions', ...A }
				]
			: []),
		...(data.sources.ai.hasData
			? [
					{ key: 'aiSessions', label: 'Sessions', type: 'int' as const, deltaKey: 'aiSessionsD', title: 'GA4 sessions that came from an AI assistant (ChatGPT, Perplexity, Gemini, Claude, Copilot) and landed on this page, with the change against the previous period', ...AI },
					{ key: 'aiEngaged', label: 'Engaged', type: 'pct' as const, title: 'Share of those AI-assistant sessions that GA4 counted as engaged', ...AI },
					{ key: 'aiTop', label: 'Top assistant', type: 'text' as const, title: 'The assistant that sent the most sessions to this page', ...AI }
				]
			: []),
		...(data.sources.clarity.hasData
			? [
					{ key: 'cSessions', label: 'Sessions', type: 'int' as const, title: 'Clarity sessions on this page in its latest 24-hour snapshot', ...C },
					{ key: 'cRage', label: 'Rage clicks', type: 'int' as const, title: 'Sessions with rage clicks (rapid repeated clicking) on this page', ...C },
					{ key: 'cDead', label: 'Dead clicks', type: 'int' as const, title: 'Sessions with dead clicks (clicks that did nothing) on this page', ...C }
				]
			: [])
	]);
	/** One source's columns at a time (plus a cross-source overview), instead of one table too wide to read. */
	type Col = (typeof allCols)[number];
	const has = $derived({ ga4: data.sources.views.hasData || data.sources.all.hasData || data.sources.ga4.hasData, bing: data.sources.bing.hasData, ai: data.sources.ai.hasData, clarity: data.sources.clarity.hasData });
	const views = $derived([
		{ id: 'overview', label: 'Overview' },
		{ id: 'google', label: 'Google' },
		...(has.ga4 ? [{ id: 'ga4', label: 'GA4' }] : []),
		...(has.bing ? [{ id: 'bing', label: 'Bing' }] : []),
		...(has.ai ? [{ id: 'ai', label: 'AI assistants' }] : []),
		...(has.clarity ? [{ id: 'clarity', label: 'Clarity' }] : [])
	]);
	const pick = (keys: string[]) => keys.map((k) => allCols.find((c: Col) => c.key === k)).filter((c): c is Col => !!c);
	const cols = $derived.by(() => {
		const page = ['path'];
		switch (view) {
			case 'google': return pick([...page, 'gClicks', 'gImpr', 'gCtr', 'gPos']);
			case 'ga4': return pick([...page, 'tViews', 'title', 'tSessions', 'tTop', 'aSessions', 'aEngaged', 'aKeyEvents']);
			case 'bing': return pick([...page, 'bClicks', 'bImpr', 'bPos']);
			case 'ai': return pick([...page, 'aiSessions', 'aiEngaged', 'aiTop']);
			case 'clarity': return pick([...page, 'cSessions', 'cRage', 'cDead']);
			default: return pick([...page, 'tViews', 'tSessions', 'gClicks', 'gPos', 'bClicks', 'aKeyEvents', 'aiSessions']);
		}
	});
	const sortFor = $derived(view === 'google' ? 'gClicks' : view === 'bing' ? 'bClicks' : view === 'ai' ? 'aiSessions' : view === 'clarity' ? 'cSessions' : data.sources.views.hasData ? 'tViews' : 'gClicks');
	const notes = $derived(
		[
			!data.sources.google.comparable ? 'Google: the previous period is still downloading, so no changes are shown.' : '',
			data.sources.bing.linked && !data.sources.bing.hasData ? (data.sources.bing.synced ? 'Bing: no page data for this period.' : 'Bing is linked: its pages appear after the first Bing sync.') : data.sources.bing.hasData && !data.sources.bing.comparable ? 'Bing: stored history does not reach the previous period, so no Bing changes are shown.' : '',
			// Per-page GA4 sessions exist only for the preset lengths; another length is "not pulled", not "none" (the note below says so).
			data.sources.ga4.linked && !data.sources.ga4.hasData && !data.allPeriod ? '' : data.sources.ga4.linked && !data.sources.ga4.hasData ? (data.sources.ga4.synced ? 'GA4 Google organic: no landing sessions from Google organic search in this period.' : 'GA4 is linked: sessions per page appear after the first GA4 sync.') : data.sources.ga4.hasData && !data.sources.ga4.comparable ? 'GA4: the previous period is pulled with the next daily sync, so changes appear then.' : '',
			// AI-assistant pages are pulled with the same preset windows, so another length is "not pulled", not "no AI sessions".
			!data.allPeriod ? '' : data.sources.ai.status === 'failed' ? 'AI assistants: the last pull of the AI report from GA4 failed and will be retried, so no AI columns are shown (zeros would not be real).' : data.sources.ai.status === 'ok' && !data.sources.ai.hasData ? 'AI assistants: GA4 reported no sessions from ChatGPT, Perplexity, Gemini, Claude or Copilot in this period.' : data.sources.ai.hasData && !data.sources.ai.comparable ? 'AI assistants: no previous-period AI sessions are stored (the previous window arrives with the next daily GA4 pull, or it had none), so no AI changes are shown.' : '',
			data.sources.views.hasData && data.sources.views.window ? `GA4 views cover ${data.sources.views.window.start} to ${data.sources.views.window.end} (GA4's newest complete days)${data.sources.views.comparable ? '' : '; the previous period is not stored yet, so no view changes are shown'}${data.sources.views.truncated ? '. The first download hit GA4\'s row limit, so the oldest days are missing' : ''}.` : '',
			data.sources.all.hasData && data.sources.all.window ? `GA4 all traffic covers ${data.sources.all.window.start} to ${data.sources.all.window.end} (GA4's own newest days)${data.sources.all.comparable ? '' : '; the previous window is not stored yet, so no changes are shown'}.` : data.sources.all.linked && !data.allPeriod ? `GA4 sessions per page (all traffic, Google organic and AI assistants) are pulled for ${data.periods.join(', ')}-day periods only; pick one of those to see them. Views work for any period.` : '',
			data.sources.clarity.hasData ? `Clarity covers only the last 24 hours (snapshot of ${data.sources.clarity.day}), not the selected period.` : ''
		].filter(Boolean)
	);
</script>

<Explainer lead="Every source side by side, joined on the page. Arrows show the change against the previous period; a dash means no data.">
	<p>Every source side by side, joined on the page's path (so www, http and https variants count as one page). Arrows show the change against the previous period; a dash means that source has nothing for the page. The first group, GA4 all traffic, shows page views (every view of the page from any channel, for any period) with the page's title in GA4, and, for the 7, 28, 90, 180 and 480-day periods, the sessions that landed on the page and the channel that sent most of them. The second GA4 group counts Google-organic sessions only: sessions and clicks are different measurements, so expect them close, not equal. The AI group counts GA4 sessions whose referrer is an AI assistant; an assistant that sends no referrer shows up as Direct and is not counted, so treat it as a floor. It does not include citations or bot crawls.</p>
</Explainer>
{#if notes.length}
	<details class="mb-3 text-xs text-muted-foreground">
		<summary class="cursor-pointer select-none hover:text-foreground">Date ranges and data notes ({notes.length})</summary>
		{#each notes as n}<p class="mt-1">{n}</p>{/each}
	</details>
{/if}
{#if data.pageGroups.length || data.views.length}
	<div class="mb-2 flex flex-wrap items-center gap-2">
		{#if data.pageGroups.length}<select class="input" aria-label="Page group" value={data.group ? String(data.group) : ''} onchange={(e) => { const u = new URL(page.url); const v = e.currentTarget.value; v ? u.searchParams.set('group', v) : u.searchParams.delete('group'); goto(u.pathname + u.search, { keepFocus: true, noScroll: true }); }}><option value="">All pages</option>{#each data.pageGroups as g}<option value={String(g.id)}>{g.name}</option>{/each}</select>{/if}
		{#if data.groupMissing}<span class="text-xs text-bad">That page group no longer exists.</span>{/if}
	</div>
{/if}
<SavedViews views={data.views} canSave={page.data.user?.role !== 'viewer'} />
<div class="flex flex-wrap items-start justify-between gap-2"><SectionTabs bind:value={view} label="Columns" tabs={views} /><a class="btn" href="/sites/{page.params.id}/export?dim=page&days={page.url.searchParams.get('days') ?? 28}">Export CSV</a></div>
{#key view}<DataTable rows={data.rows} {cols} sortKey={sortFor} onRowClick={toggle} empty="No page data yet." />{/key}
{#if open}
	<div class="card mt-3 p-4">
		<div class="pii mb-2 truncate font-medium">{open}</div>
		<Chart data={history} defaultMetrics={['clicks', 'position']} height={220} />
	</div>
{/if}
