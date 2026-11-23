<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import Chart from '$lib/components/Chart.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import SectionTabs from '$lib/components/SectionTabs.svelte';
	import { ago, fmtInt } from '$lib/format';
	import { enhance } from '$app/forms';
	import { noKeyEventsText } from '$lib/keyeventtext';
	let { data, form } = $props();
	let rtBusy = $state(false);
	let view = $state('');
	const TIME_TIP = 'Average engagement time per session: how long the page was in front of the visitor. Kept for the 7d, 28d, 3m, 6m and 16m periods.';
	// Present only once the value report has synced for this period; revenue only when some session earned any.
	const values = $derived(data.linked && data.values.linked && data.values.status === 'ok' ? data.values : null);
	const money = $derived(values?.hasRevenue ? [{ key: 'revenue', label: 'Revenue', title: 'GA4 total revenue: purchases, subscriptions and ad revenue.', type: 'money' as const, currency: values.currency }] : []);
	const timeCol = $derived(values ? [{ key: 'avgTime', label: 'Avg. time', title: TIME_TIP, type: 'dur' as const }] : []);
	const cols = $derived([
		{ key: 'channel', label: 'Channel group', type: 'text' as const },
		{ key: 'sessions', label: 'Sessions', type: 'int' as const },
		{ key: 'sessionsDelta', label: 'Δ sessions', type: 'delta' as const },
		{ key: 'engagementRate', label: 'Engaged', type: 'pct' as const },
		...timeCol,
		{ key: 'users', label: 'Users', title: 'Unique users over the whole period, as GA4 reports Total users. Appears after the next GA4 sync.', type: 'int' as const },
		{ key: 'keyEvents', label: 'Key events', type: 'int' as const },
		...money,
		{ key: 'pageviews', label: 'Views', type: 'int' as const }
	]);
	const valueCols = (label: string) => [
		{ key: 'key', label, type: 'text' as const, pii: true },
		{ key: 'sessions', label: 'Sessions', type: 'int' as const, bar: true },
		{ key: 'engagementRate', label: 'Engaged', type: 'pct' as const },
		{ key: 'avgEngagementSec', label: 'Avg. time', title: TIME_TIP, type: 'dur' as const },
		{ key: 'keyEvents', label: 'Key events', type: 'int' as const },
		{ key: 'keyEventRate', label: 'Key event rate', title: 'Key events per session.', type: 'pct' as const },
		...(values?.hasRevenue
			? [
					{ key: 'revenue', label: 'Revenue', type: 'money' as const, currency: values.currency },
					{ key: 'transactions', label: 'Transactions', type: 'int' as const },
					{ key: 'revenuePerSession', label: 'Per session', title: 'Revenue divided by sessions.', type: 'money' as const, currency: values.currency }
				]
			: [])
	];
</script>

{#if !data.linked}
	<div class="card p-6 text-center"><p class="mb-3">No GA4 property is linked to this site yet.</p><a class="btn btn-primary" href="/connect">Connect GA4</a></div>
{:else}
	<p class="mb-2 text-xs text-muted-foreground">Property: <b class="pii">{data.property}</b> · {data.status.state === 'error' ? data.status.message : 'synced ' + ago(data.status.lastSync)}</p>
	<div class="card mb-4 p-4"><Chart data={data.series} hide={['position']} labels={{ clicks: 'GA4 organic sessions', impressions: 'Google Search clicks' }} /></div>
	<Explainer lead="GA4 sessions and Search Console clicks are different measurements, so expect them close, not equal.">
	<p>GA4 organic sessions and Search Console clicks are different measurements (sessions vs. clicks, consent-mode gaps, other search engines count as organic in GA4), so expect them to move together but not match. A divergence is a prompt to look, not proof of a problem.</p>
</Explainer>
	<DataTable rows={data.channels} {cols} sortKey="sessions" filterable={false} />
	<section class="mt-6">
		<h2 class="mb-1 font-medium">Right now</h2>
		<form method="POST" action="?/realtime" use:enhance={() => { rtBusy = true; return async ({ update }) => { await update({ reset: false }); rtBusy = false; }; }} class="mb-2 flex items-center gap-2">
			<button class="btn text-xs" disabled={rtBusy}>{rtBusy ? 'Asking GA4…' : 'Show the last 30 minutes'}</button>
			<span class="text-xs text-muted-foreground">GA4 Realtime, read live: who is on the site, and whether a new tag sends its event.</span>
		</form>
		{#if form?.realtime}
			{@const rt = form.realtime}
			{#if !rt.linked}<p class="text-xs text-muted-foreground">No GA4 property is linked.</p>
			{:else if !rt.ok}<p class="text-xs text-warn">GA4 Realtime could not be read: {rt.error}</p>
			{:else}
				{#if rt.users}
					{@const u = rt.users}
					{@const top = Math.max(1, ...u.minutes.map((m) => m.users))}
					<div class="card mb-3 p-4">
						<div class="flex flex-wrap items-baseline gap-x-6 gap-y-1">
							<div><span class="tnum text-3xl font-semibold">{fmtInt(u.total)}</span> <span class="text-xs text-muted-foreground">active users, last 30 minutes</span></div>
							{#if u.devices.length}<div class="tnum text-xs text-muted-foreground">{u.devices.map((x) => `${x.device} ${fmtInt(x.users)}`).join(' · ')}</div>{/if}
						</div>
						{#if u.minutes.length}
							<div class="mt-3 flex h-12 items-end gap-px" role="img" aria-label="Active users per minute, oldest on the left">
								{#each Array.from({ length: 30 }, (_, i) => 29 - i) as ago (ago)}
									{@const m = u.minutes.find((x) => x.minutesAgo === ago)}
									<div class="flex-1 rounded-t-sm" style="height:{Math.max(3, ((m?.users ?? 0) / top) * 100)}%;background:var(--chart-1);opacity:{m?.users ? 1 : 0.2}" title="{ago === 0 ? 'this minute' : `${ago} min ago`}: {m?.users ?? 0} users"></div>
								{/each}
							</div>
							<div class="mt-1 flex justify-between text-[11px] text-muted-foreground"><span>30 min ago</span><span>now</span></div>
						{/if}
						<div class="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
							<DataTable rows={u.pages} cols={[{ key: 'title', label: 'Page title', type: 'text', pii: true }, { key: 'users', label: 'Active users', type: 'int', bar: true }, { key: 'views', label: 'Views', type: 'int' }]} sortKey="users" filterable={false} pageSize={8} empty="Nobody on the site right now." />
							<DataTable rows={u.countries} cols={[{ key: 'country', label: 'Country', type: 'text' }, { key: 'users', label: 'Active users', type: 'int', bar: true }]} sortKey="users" filterable={false} pageSize={8} empty="Nobody on the site right now." />
						</div>
						<p class="mt-2 text-[11px] text-muted-foreground">GA4 Realtime names pages by title, not address. One visitor can count under several pages.</p>
					</div>
				{:else if rt.usersError}
					<p class="mb-2 text-xs text-warn">Active users could not be read: {rt.usersError}</p>
				{/if}
				{#if !rt.events.length}<p class="text-xs text-muted-foreground">No events in the last 30 minutes.</p>
				{:else}
				<DataTable rows={rt.events} cols={[{ key: 'event', label: 'Event (last 30 min)', type: 'text' }, { key: 'count', label: 'Count', type: 'int', bar: true }]} sortKey="count" filterable={false} pageSize={10} />
				{/if}
				{#if rt.demo}<p class="mt-1 text-xs text-muted-foreground">Demo data.</p>{/if}
			{/if}
		{/if}
	</section>
	<section class="mt-6" aria-label="GA4 details">
		<SectionTabs bind:value={view} label="GA4 details" tabs={[
			{ id: 'sources', label: 'Traffic sources' },
			{ id: 'landing', label: 'Landing pages' },
			{ id: 'campaigns', label: 'Campaigns' },
			{ id: 'events', label: 'Key events' },
			{ id: 'search', label: 'Site search' },
			{ id: 'ai', label: 'AI assistants' }
		]} />
	{#if view === 'sources'}
	{#if data.sources.linked}
		<section>
			<h2 class="sr-only">Traffic sources</h2>
			{#if data.sources.status === 'pending'}
				<p class="text-xs text-muted-foreground">Appears after the next GA4 sync.</p>
			{:else if data.sources.status === 'failed'}
				<p class="text-xs text-warn">GA4 could not return traffic sources on the last sync; it will be retried. {data.sources.error}</p>
			{:else if data.sources.status === 'no-window'}
				<p class="text-xs text-muted-foreground">Traffic sources are kept for the 7d, 28d, 3m, 6m and 16m periods. Pick one of those to see them.</p>
			{:else}
				<Explainer lead="Which sites, apps and campaigns sent sessions, {data.sources.window.start} to {data.sources.window.end}.">
					<p>Sessions by the source and medium GA4 recorded.{#if data.sources.rows.length > 15} Type a site's name in the filter to find it.{/if} Links opened from apps and email often arrive without a referrer and count as <b>(direct) / (none)</b>; tag your links with <code>utm_source</code> to see them by name.{#if data.sources.truncated} Very small sources past GA4's row limit are not shown.{/if}</p>
				</Explainer>
				{#if data.sources.staleError}<p class="mb-2 text-xs text-warn">The last refresh failed, so this is from {data.sources.window.end}: {data.sources.staleError}</p>{/if}
				<DataTable
					rows={data.sources.rows}
					cols={[
						{ key: 'source', label: 'Source', type: 'text', pii: true },
						{ key: 'medium', label: 'Medium', type: 'text' },
						{ key: 'channel', label: 'Channel group', type: 'text' },
						{ key: 'sessions', label: 'Sessions', type: 'int', bar: true },
						{ key: 'sessionsDelta', label: 'Δ sessions', title: data.sources.previousWindow ? `Against ${data.sources.previousWindow.start} to ${data.sources.previousWindow.end}. Empty for a source with no sessions then.` : 'GA4 no longer keeps the whole previous period.', type: 'delta' },
						{ key: 'engagementRate', label: 'Engaged', type: 'pct' },
						{ key: 'keyEvents', label: 'Key events', type: 'int' }
					]}
					sortKey="sessions"
					pageSize={15}
				/>
			{/if}
		</section>
	{/if}
	{/if}
	{#if view === 'landing'}
	{#if data.landing.linked}
		<section>
			<h2 class="sr-only">Landing pages, every channel</h2>
			{#if data.landing.status === 'pending'}
				<p class="text-xs text-muted-foreground">Appears after the next GA4 sync.</p>
			{:else if data.landing.status === 'failed'}
				<p class="text-xs text-warn">GA4 could not return landing pages on the last sync; it will be retried. {data.landing.error}</p>
			{:else if data.landing.status === 'no-window'}
				<p class="text-xs text-muted-foreground">Landing pages are kept for the 7d, 28d, 3m, 6m and 16m periods. Pick one of those to see them.</p>
			{:else}
				<Explainer lead="Where sessions start, from every channel, {data.landing.window.start} to {data.landing.window.end}.">
					<p>Sessions that began on each page, whatever brought them: search, direct, referral, social, email. "Main channel" is the channel that brought the most of them, and "From organic" the share from Organic Search, so a page that lives on referral or social traffic stands out. Query strings are dropped, so /page?ref=x counts as /page.{#if data.landing.truncated} Very small pages past GA4's row limit are not shown.{/if}</p>
				</Explainer>
				{#if data.landing.staleError}<p class="mb-2 text-xs text-warn">The last refresh failed, so this is from {data.landing.window.end}: {data.landing.staleError}</p>{/if}
				<DataTable
					rows={data.landing.rows}
					cols={[
						{ key: 'page', label: 'Landing page', type: 'text', pii: true },
						{ key: 'sessions', label: 'Sessions', type: 'int', bar: true },
						{ key: 'sessionsDelta', label: 'Δ sessions', title: data.landing.previousWindow ? `Against ${data.landing.previousWindow.start} to ${data.landing.previousWindow.end}. Empty for a page with no sessions then.` : 'GA4 no longer keeps the whole previous period.', type: 'delta' },
						{ key: 'topChannel', label: 'Main channel', type: 'text' },
						{ key: 'organicShare', label: 'From organic', type: 'pct' },
						{ key: 'engagementRate', label: 'Engaged', type: 'pct' },
						...timeCol,
						{ key: 'keyEvents', label: 'Key events', type: 'int' },
						...money
					]}
					sortKey="sessions"
					pageSize={15}
				/>
			{/if}
		</section>
	{/if}
	{/if}
	{#if view === 'campaigns'}
	{#if data.values.linked}
		<section>
			<h2 class="sr-only">Campaigns</h2>
			{#if data.values.status === 'pending'}
				<p class="text-xs text-muted-foreground">Appears after the next GA4 sync.</p>
			{:else if data.values.status === 'failed'}
				<p class="text-xs text-warn">GA4 could not return campaigns on the last sync; it will be retried. {data.values.error}</p>
			{:else if data.values.status === 'no-window'}
				<p class="text-xs text-muted-foreground">Campaigns, engagement time and revenue are kept for the 7d, 28d, 3m, 6m and 16m periods. Pick one of those to see them.</p>
			{:else}
				<Explainer lead="Sessions by utm_campaign, {data.values.window.start} to {data.values.window.end}.">
					<p>Each campaign's sessions, how long visitors stayed and what they did. GA4 puts untagged traffic under names in brackets, such as <b>(organic)</b>, <b>(direct)</b> and <b>(referral)</b>. Tag newsletter and ad links with <code>utm_campaign</code> to see them by name.{#if data.values.truncated.includes('campaign')} Very small campaigns past GA4's row limit are not shown.{/if}</p>
				</Explainer>
				{#if data.values.staleError}<p class="mb-2 text-xs text-warn">The last refresh failed, so this is from {data.values.window.end}: {data.values.staleError}</p>{/if}
				{#if !data.values.hasRevenue}<p class="mb-2 text-xs text-muted-foreground">No revenue recorded in this period, so revenue columns are hidden. GA4 records revenue from purchase events with a value.</p>{/if}
				<DataTable rows={data.values.campaigns} cols={valueCols('Campaign')} sortKey="sessions" pageSize={15} />
			{/if}
		</section>
	{/if}
	{/if}
	{#if view === 'events'}
	{#if data.keyEvents.linked}
		<section>
			<h2 class="sr-only">Key events by name</h2>
			{#if data.keyEvents.status === 'pending'}
				<p class="text-xs text-muted-foreground">Appears after the next GA4 sync.</p>
			{:else if data.keyEvents.status === 'failed'}
				<p class="text-xs text-warn">GA4 could not return key events on the last sync; it will be retried. {data.keyEvents.error}</p>
			{:else if data.keyEvents.status === 'none'}
				<p class="text-xs text-muted-foreground">{noKeyEventsText(data.keyEvents.marked)}</p>
			{:else}
				<p class="mb-2 text-xs text-muted-foreground">{data.keyEvents.window.start} to {data.keyEvents.window.end}, GA4's newest days. Only events marked as key events in GA4 are counted.</p>
				{#if data.keyEvents.staleError}<p class="mb-2 text-xs text-warn">The last refresh failed, so recent days may be missing: {data.keyEvents.staleError}</p>{/if}
				<DataTable rows={data.keyEvents.events} cols={[{ key: 'event', label: 'Event', type: 'text' }, { key: 'keyEvents', label: 'Key events', type: 'int', bar: true }, { key: 'keyEventsDelta', label: 'Δ', title: 'Change against the same number of days just before.', type: 'delta' }, { key: 'prevKeyEvents', label: 'Before', type: 'int' }]} sortKey="keyEvents" filterable={false} pageSize={15} />
			{/if}
		</section>
	{/if}
	{/if}
	{#if view === 'search'}
	{#if data.values.linked}
		{#if data.values.status === 'ok'}
			<section>
				<h2 class="sr-only">Site search</h2>
				{#if !data.values.searchTerms.length}
					<p class="text-xs text-muted-foreground">No site searches recorded in this period. GA4 counts them when enhanced measurement's site search is on and the results page keeps the term in its address, such as <code>?q=</code> or <code>?s=</code>.</p>
				{:else}
					<Explainer lead="What visitors typed into your own search box, {data.values.window.start} to {data.values.window.end}.">
						<p>Terms searched often but missing from your menu or content are pages worth adding. Terms are lower-cased, so "Shipping" and "shipping" count together.</p>
					</Explainer>
					<DataTable rows={data.values.searchTerms} cols={[{ key: 'term', label: 'Search term', type: 'text', pii: true }, { key: 'searches', label: 'Searches', type: 'int', bar: true }, { key: 'users', label: 'Users', type: 'int' }]} sortKey="searches" pageSize={15} />
				{/if}
			</section>
		{/if}
	{/if}
	{/if}
	{#if view === 'ai'}
	{#if data.ai.linked}
		<section>
			<h2 class="sr-only">AI assistants</h2>
			{#if data.ai.status === 'pending'}
				<p class="text-xs text-muted-foreground">Appears after the next GA4 sync.</p>
			{:else if data.ai.status === 'failed'}
				<p class="text-xs text-warn">The AI-assistant report could not be fetched from GA4 on the last sync and will be retried. Nothing is shown rather than a misleading zero.</p>
			{:else if !data.ai.sessions}
				<p class="text-xs text-muted-foreground">No sessions from ChatGPT, Perplexity, Gemini, Claude or Copilot in this period. Assistants that send no referrer show up as Direct and cannot be counted.</p>
			{:else}
				<p class="mb-2 text-xs text-muted-foreground">
					<b>{data.ai.sessions.toLocaleString('en-US')}</b> sessions arrived from AI assistants in the {data.days} days to {data.ai.window.end}{data.ai.shareOfAllSessions != null ? ` (${(data.ai.shareOfAllSessions * 100).toFixed(1)}% of all sessions)` : ''}, found by the referrer GA4 recorded. A floor, not a total: assistants that strip the referrer land in Direct.
				</p>
				<div class="grid grid-cols-1 gap-4 2xl:grid-cols-2">
					<DataTable rows={data.ai.assistants} cols={[{ key: 'assistant', label: 'Assistant', type: 'text' }, { key: 'sessions', label: 'Sessions', type: 'int', bar: true }, { key: 'engaged', label: 'Engaged', type: 'int' }, { key: 'keyEvents', label: 'Key events', type: 'int' }, { key: 'pages', label: 'Pages', type: 'int' }]} sortKey="sessions" filterable={false} />
					<DataTable rows={data.ai.pages} cols={[{ key: 'page', label: 'Landing page', type: 'text', pii: true }, { key: 'assistant', label: 'From', type: 'text' }, { key: 'sessions', label: 'Sessions', type: 'int' }, { key: 'keyEvents', label: 'Key events', type: 'int' }]} sortKey="sessions" pageSize={10} filterable={false} />
				</div>
			{/if}
		</section>
	{/if}
	{/if}
	</section>
{/if}
