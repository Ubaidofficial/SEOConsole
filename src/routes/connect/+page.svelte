<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import { Check, Pencil, Plus } from '@lucide/svelte';
	import SiteSetup from '$lib/components/SiteSetup.svelte';
	import { privacy } from '$lib/privacy.svelte';
	import { enhance } from '$app/forms';
	import { ago } from '$lib/format';

	let { data, form } = $props();
	const cards = ['google', 'bing', 'ga4', 'gtm', 'clarity', 'openseo'] as const;
	const label: Record<string, string> = { google: 'Search Console', bing: 'Bing', ga4: 'GA4', gtm: 'Tag Manager', clarity: 'Clarity', openseo: 'OpenSEO' };
	const done = $derived({ google: data.total, ...data.progress });
	let busy = $state<string | null>(null);
	const submit = (name: string) => () => {
		busy = name;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			busy = null;
		};
	};
	const msgFor = (s: string) => (form?.section === s ? form : null);
	let editing = $state(false);
	/** A source whose setup is finished folds down to one line; it opens again on click, and stays open while it has a message to show. */
	const full = (k: keyof typeof done) => data.total > 0 && done[k] === data.total;
	const complete = $derived({
		google: data.accounts.length > 0 && !msgFor('google'),
		bing: full('bing') && !msgFor('bing'),
		ga4: full('ga4') && !msgFor('ga4'),
		gtm: full('gtm') && !msgFor('gtm'),
		clarity: full('clarity') && !msgFor('clarity'),
		openseo: !!data.openseo && !msgFor('openseo'),
		crux: !!data.crux && !msgFor('crux'),
		ahrefs: !!data.ahrefs && !data.ahrefs.rejected && !msgFor('ahrefs'),
		moz: !!data.moz && !data.moz.rejected && !msgFor('moz')
	});
	const statusOf = $derived({
		google: data.accounts.length ? `✓ ${data.accounts.length} account(s) · ${data.total} site(s)` : 'Not connected',
		bing: `${done.bing ? '✓ ' : ''}${done.bing}/${data.total} sites`,
		ga4: `${done.ga4 ? '✓ ' : ''}${done.ga4}/${data.total} sites`,
		gtm: `${done.gtm ? '✓ ' : ''}${done.gtm}/${data.total} sites`,
		clarity: `${done.clarity ? '✓ ' : ''}${done.clarity}/${data.total} sites`,
		openseo: data.openseo ? `✓ ${data.openseo.linked} site(s)` : 'Optional, not connected',
		crux: data.crux ? '✓ connected' : 'Optional, not connected',
		ahrefs: data.ahrefs ? (data.ahrefs.rejected ? 'Key rejected: replace it' : `✓ ${data.ahrefs.withDr}/${data.ahrefs.total} sites`) : 'Optional, not connected',
		moz: data.moz ? (data.moz.rejected ? 'Credentials rejected: replace them' : `✓ ${data.moz.withDa}/${data.moz.total} sites`) : 'Optional, not connected'
	});
</script>

<h1 class="mb-1 text-lg font-semibold">Connect your data</h1>
<p class="mb-4 text-sm text-muted-foreground">Each step is optional and independent. Sites are matched by domain automatically; whatever can't be matched is listed so you can link it by hand.</p>

{#if data.demo}<p class="card mb-4 p-3 text-sm">Demo mode: type <code>demo</code> as the key/token in any step to connect synthetic data.</p>{/if}
{#if form?.ok && !form.section}<p class="mb-3 text-sm text-good">{form.ok}</p>{/if}
{#if data.flash}<p class="mb-3 text-sm text-muted-foreground" role="status">{data.flash}</p>{/if}

{#if data.setupSite}<SiteSetup site={data.setupSite} plan={data.setup} choices={data.choices} onSite={data.setupOnSite} readOnly={data.readOnly} form={form?.section === 'setup' ? form : null} />{/if}

<!-- Automation: the per-site switches that are off until someone turns them on, set for every site at once -->
<section class="card mb-6 p-4">
	<h2 class="font-medium">Automation for all sites</h2>
	<Explainer lead="Switch each of these on for all {data.automation.total} sites at once, and choose what a site found later starts with.">
		<p>Each one runs on a site only once it is switched on, and normally has its own switch on that site's Indexing or Request page. Nothing changes until you choose. Reading Search Console, sitemaps and robots.txt already runs on its own for every site.</p>
	</Explainer>
	{#if msgFor('automation')}<p class="mb-2 text-sm {msgFor('automation')?.error ? 'text-bad' : 'text-good'}" role="status">{msgFor('automation')?.error ?? msgFor('automation')?.ok}</p>{/if}
	<ul class="divide-y">
		{#each data.automation.switches as w (w.key)}
			<li class="flex flex-wrap items-start gap-x-4 gap-y-2 py-3">
				<div class="min-w-0 flex-1 basis-80">
					<div class="text-sm font-medium">{w.label} <span class="tnum ml-1 text-xs font-normal text-muted-foreground">on for {w.on} of {data.automation.total} sites</span></div>
					<p class="mt-0.5 text-xs text-muted-foreground">{w.what}</p>
					<p class="mt-0.5 text-xs text-muted-foreground">{w.cost}</p>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<form method="POST" action="?/automationApply" use:enhance={submit('apply-' + w.key)}>
						<input type="hidden" name="key" value={w.key} /><input type="hidden" name="on" value="1" />
						<button class="btn btn-sm" disabled={!w.available || w.on === data.automation.total || busy === 'apply-' + w.key} title={w.available ? 'Switch it on for every site shown on the dashboard' : 'Needs write access to Search Console'}>Turn on for all</button>
					</form>
					<form method="POST" action="?/automationApply" use:enhance={submit('apply-off-' + w.key)}>
						<input type="hidden" name="key" value={w.key} /><input type="hidden" name="on" value="0" />
						<button class="btn btn-sm" disabled={w.on === 0 || busy === 'apply-off-' + w.key}>Turn off for all</button>
					</form>
					<form method="POST" action="?/automationDefault" use:enhance={submit('def-' + w.key)}>
						<input type="hidden" name="key" value={w.key} /><input type="hidden" name="on" value={w.newSites ? '0' : '1'} />
						<button class="chip !h-8 cursor-pointer text-xs {w.newSites ? 'chip-on' : ''}" aria-pressed={w.newSites} disabled={busy === 'def-' + w.key} title="What a site found from now on starts with. Existing sites are not changed.">New sites: {w.newSites ? 'on' : 'off'}</button>
					</form>
				</div>
			</li>
		{/each}
	</ul>
</section>

<!-- Matrix: status at a glance; the controls only show while editing -->
<section class="mb-6">
	<div class="mb-2 flex flex-wrap items-center gap-2"><h2 class="font-medium">Connections by site</h2>
		<span class="text-xs text-muted-foreground">{editing ? 'Unlink (✕) or refresh a source, then press Done.' : 'Press + Link in an empty cell to connect a source by hand; Edit links to unlink or refresh.'}</span>
		{#if !data.readOnly}<button type="button" class="btn btn-sm ml-auto {editing ? 'btn-primary' : ''}" aria-pressed={editing} onclick={() => (editing = !editing)}>{#if editing}<Check class="size-3.5" />Done editing{:else}<Pencil class="size-3.5" />Edit links{/if}</button>{/if}</div>
	<div class="card overflow-x-auto">
		<table class="w-full">
			<thead><tr><th class="th">Site</th><th class="th"><img src="/logos/search-console.svg" alt="" width="14" height="14" class="mr-1.5 inline-block size-3.5 align-[-2px] object-contain" />Google</th><th class="th"><img src="/logos/bing.svg" alt="" width="14" height="14" class="mr-1.5 inline-block size-3.5 align-[-2px] object-contain" />Bing</th><th class="th"><img src="/logos/ga4.svg" alt="" width="14" height="14" class="mr-1.5 inline-block size-3.5 align-[-2px] object-contain" />GA4</th><th class="th"><img src="/logos/tag-manager.svg" alt="" width="14" height="14" class="mr-1.5 inline-block size-3.5 align-[-2px] object-contain" />GTM</th><th class="th"><img src="/logos/clarity.png" alt="" width="14" height="14" class="mr-1.5 inline-block size-3.5 align-[-2px] object-contain" />Clarity</th><th class="th">OpenSEO</th></tr></thead>
			<tbody>
				{#each data.rows as r (r.id)}
					<tr>
						<td class="td whitespace-nowrap"><a class="pii hover:underline" href="/sites/{r.id}">{r.name}</a><div class="pii text-[11px] text-muted-foreground">{r.account}</div>
							{#if r.needsSetup && !data.readOnly}<a class="mt-1 inline-block text-[11px] underline" href="/connect?setup={r.id}#setup">Set up GA4 &amp; Tag Manager</a>{/if}</td>
						<td class="td {r.google === 'synced' ? 'text-good' : 'text-muted-foreground'}">{r.google === 'synced' ? '✓' : r.google}</td>
						{#each ['bing', 'ga4', 'gtm', 'clarity', 'openseo'] as const as k}
							{@const l = r.links[k]}
							<td class="td text-xs">
								{#if l}
									<div class="flex items-center gap-1">
										<span class={l.status === 'error' ? 'text-bad' : 'text-good'}>{l.status === 'error' ? '⚠' : '✓'}</span>
										<span class="pii max-w-[11rem] truncate" title={privacy.on ? undefined : (l.label ?? l.id)}>{l.label ?? l.id}</span>
										{#if editing}<form method="POST" action="?/unlink" use:enhance><input type="hidden" name="siteId" value={r.id} /><input type="hidden" name="kind" value={k} /><button class="text-muted-foreground hover:text-[color:var(--bad)]" title="Unlink" aria-label="Unlink {k}">✕</button></form>{/if}
									</div>
									<div class="text-[11px] text-muted-foreground">{k === 'openseo' ? 'linked by domain' : l.status === 'running' || l.status === 'queued' ? '⟳ ' + l.status : l.status === 'error' ? l.message : 'synced ' + ago(l.lastSync)}
										{#if editing && k !== 'openseo'}<form method="POST" action="?/resync" use:enhance class="inline"><input type="hidden" name="siteId" value={r.id} /><input type="hidden" name="kind" value={k} /> <button class="btn btn-ghost btn-xs !h-6 align-middle">refresh</button></form>{/if}</div>
								{:else if (k === 'ga4' || k === 'gtm') && r.candidates[k].length && !data.readOnly}
									<!-- Several matched equally well: a choice, shown without "Edit links" because it is waiting on a decision. -->
									<form method="POST" action="?/pick" use:enhance class="flex flex-col gap-1"><input type="hidden" name="siteId" value={r.id} /><input type="hidden" name="kind" value={k} />
										<span class="text-[11px] text-warn">{r.candidates[k].length} matches, pick one</span>
										<span class="flex gap-1"><select class="input pii w-40 !py-0.5 text-xs" name="externalId" aria-label="Choose the {k === 'ga4' ? 'GA4 property' : 'Tag Manager container'} for {r.name}">{#each r.candidates[k] as c}<option value={c.id}>{c.label}</option>{/each}</select><button class="btn btn-xs">Link</button></span></form>
								{:else if !data.readOnly && (k === 'bing' || k === 'ga4' || k === 'gtm')}
									<!-- Always offered in an empty cell (no edit mode needed): linking by hand is the usual fix when automatic matching cannot. -->
									<details class="group/link">
										<summary class="btn btn-xs inline-flex cursor-pointer list-none gap-1 [&::-webkit-details-marker]:hidden"><Plus class="size-3.5" />Link {k === 'ga4' ? 'GA4' : k === 'gtm' ? 'container' : 'Bing'}</summary>
										<form method="POST" action="?/manual" use:enhance class="mt-1.5 flex flex-col gap-1"><input type="hidden" name="siteId" value={r.id} /><input type="hidden" name="kind" value={k} />
											<span class="flex gap-1"><input class="input w-44 !py-0.5 text-xs" name="externalId" aria-label={k === 'bing' ? 'Bing site address' : k === 'gtm' ? 'Tag Manager container ID' : 'GA4 property'} placeholder={k === 'bing' ? 'https://www.site.com/' : k === 'gtm' ? 'GTM-ABC1234' : 'properties/123456'} /><button class="btn btn-xs btn-primary">Link</button></span>
											<span class="text-[11px] text-muted-foreground">{k === 'ga4' ? 'GA4 → Admin → Property details → Property ID, as properties/<ID>' : k === 'gtm' ? 'The GTM-… ID at the top of Tag Manager' : 'The site address exactly as Bing Webmaster lists it'}</span></form>
									</details>
									{#if r.skipped.includes(k)}<div class="mt-1 text-[11px] text-muted-foreground" title="Unlinked on purpose: automatic matching leaves it alone. Linking it by hand undoes that.">unlinked on purpose</div>{/if}
								{:else if r.skipped.includes(k)}<span class="text-muted-foreground" title="Unlinked on purpose: automatic matching leaves it alone.">– unlinked</span>
								{:else}<span class="text-muted-foreground">–</span>{/if}
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>

<h2 class="mb-2 font-medium">Sources</h2>
<div class="stagger flex flex-col gap-4">
	<!-- 1 Google -->
	<details class="card p-4 [&[open]>summary]:mb-2" open={!complete.google}>
		<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 select-none [&::-webkit-details-marker]:hidden"><h2 class="font-medium"><img src="/logos/search-console.svg" alt="" width="18" height="18" class="mr-2 inline-block size-[18px] align-[-3px] object-contain" />1 · Google Search Console <span class="chip ml-1">+ GA4 &amp; Tag Manager access</span></h2><span class="ml-auto text-xs {complete.google ? 'text-good' : 'text-muted-foreground'}">{statusOf.google}</span></summary>
		<p class="mb-3 text-xs text-muted-foreground">One Google sign-in grants Search Console, GA4 and Tag Manager (read-only) together. Repeat for each Google account.</p>
		<ul class="mb-3 space-y-1 text-sm">
			{#each data.accounts as a}
				<li class="flex items-center gap-2">
					<span class="pii">{a.email}</span>
					{#if a.status === 'revoked'}<span class="chip text-bad">revoked</span>{/if}
					{#if a.ga4}<span class="chip text-good">GA4 ✓</span>{:else}<span class="chip text-warn" title="Reconnect to grant GA4 access">GA4 not granted</span>{/if}
					{#if a.gtm}<span class="chip text-good">GTM ✓</span>{:else}<span class="chip text-warn" title="Reconnect to grant Tag Manager access">GTM not granted</span>{/if}
				</li>
			{:else}<li class="text-muted-foreground">No accounts yet.</li>{/each}
		</ul>
		<a class="btn btn-primary" href="/accounts">Manage / connect accounts</a>
		{#if data.accounts.some((a) => !a.ga4 && !a.demo)}<p class="mt-2 text-xs text-warn">Some accounts connected before GA4 was added: use “Connect Google account” again on the Accounts page to grant it.</p>{/if}
	</details>

	<!-- 2 Bing -->
	<details class="card p-4 [&[open]>summary]:mb-2" open={!complete.bing}>
		<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 select-none [&::-webkit-details-marker]:hidden"><h2 class="font-medium"><img src="/logos/bing.svg" alt="" width="18" height="18" class="mr-2 inline-block size-[18px] align-[-3px] object-contain" />2 · Bing Webmaster Tools</h2><span class="ml-auto text-xs {complete.bing ? 'text-good' : 'text-muted-foreground'}">{statusOf.bing}</span></summary>
		<ol class="mb-3 ml-4 list-decimal space-y-0.5 text-xs text-muted-foreground">
			<li>Sign in at <a class="underline" href="https://www.bing.com/webmasters" target="_blank" rel="noreferrer noopener">bing.com/webmasters</a> and make sure your sites are added and verified.</li>
			<li><b>Settings</b> (top right) → <b>API Access</b> → accept the terms → <b>API Key</b> → <b>Generate API Key</b>.</li>
			<li>Paste it below. One key covers every site in that Bing account.</li>
		</ol>
		<form method="POST" action="?/bingKey" use:enhance={submit('bing')} class="flex flex-wrap gap-2">
			<input class="input w-44" name="label" aria-label="Label" placeholder="Label (optional)" />
			<input class="input min-w-0 flex-1" name="apiKey" type="password" autocomplete="off" aria-label="Bing API key" placeholder="Bing API key" required />
			<button class="btn btn-primary" disabled={busy === 'bing'}>{busy === 'bing' ? 'Checking…' : 'Connect'}</button>
		</form>
		{#if data.bingOAuth}<a class="btn mt-2" href="/auth/bing/connect">Or sign in with Bing (OAuth)</a>{/if}
		{#if msgFor('bing')?.ok}<p class="mt-2 text-sm text-good">{msgFor('bing')?.ok}</p>{/if}
		{#if msgFor('bing')?.error}<p class="mt-2 text-sm text-bad">{msgFor('bing')?.error}</p>{/if}
		{#each data.bing as b}
			<div class="mt-3 flex items-center gap-2 text-sm">
				<span>{b.label}</span><span class="chip">{b.auth === 'oauth' ? 'OAuth' : 'API key'}</span><span class="text-xs text-muted-foreground">{b.sites} site(s)</span>
				{#if b.status !== 'active'}<span class="chip text-bad">{b.status}</span>{/if}
				<form method="POST" action="?/bingRemove" use:enhance class="ml-auto"><input type="hidden" name="id" value={b.id} /><button class="btn btn-danger">Remove</button></form>
			</div>
		{/each}
	</details>

	<!-- 3 GA4 -->
	<details class="card p-4 [&[open]>summary]:mb-2" open={!complete.ga4}>
		<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 select-none [&::-webkit-details-marker]:hidden"><h2 class="font-medium"><img src="/logos/ga4.svg" alt="" width="18" height="18" class="mr-2 inline-block size-[18px] align-[-3px] object-contain" />3 · Google Analytics 4</h2><span class="ml-auto text-xs {complete.ga4 ? 'text-good' : 'text-muted-foreground'}">{statusOf.ga4}</span></summary>
		<p class="mb-3 text-xs text-muted-foreground">Needs the <b>Analytics Admin API</b> and <b>Analytics Data API</b> enabled in your Google Cloud project. Properties are matched to sites by the website address of their web data stream.</p>
		<form method="POST" action="?/ga4Auto" use:enhance={submit('ga4')}><button class="btn btn-primary" disabled={busy === 'ga4'}>{busy === 'ga4' ? 'Matching…' : 'Find & link GA4 properties'}</button></form>
		{#if msgFor('ga4')?.ok}<p class="mt-2 text-sm text-good">{msgFor('ga4')?.ok}</p>{/if}
		{#if msgFor('ga4')?.error}<p class="mt-2 text-sm text-bad">{msgFor('ga4')?.error}</p>{/if}
	</details>

</div>

<!-- 4 Tag Manager -->
<details class="card mt-4 p-4 [&[open]>summary]:mb-2" open={!complete.gtm}>
		<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 select-none [&::-webkit-details-marker]:hidden"><h2 class="font-medium"><img src="/logos/tag-manager.svg" alt="" width="18" height="18" class="mr-2 inline-block size-[18px] align-[-3px] object-contain" />4 · Google Tag Manager <span class="chip ml-1">read-only, plus optional one-click setup and Clarity install</span></h2><span class="ml-auto text-xs {complete.gtm ? 'text-good' : 'text-muted-foreground'}">{statusOf.gtm}</span></summary>
	<p class="mb-3 text-xs text-muted-foreground">
		Reads each site's <b>published</b> container and checks it against GA4 and Search Console (Tag Manager tab). Needs the <b>Tag Manager API</b> enabled in your Google Cloud project. SEOConsole only changes a container when you ask: through a site's <b>Set up GA4 &amp; Tag Manager</b> button (links or creates the GA4 property and container and adds the Google tag) or the Clarity install, each after showing the change and with a separate permission.
	</p>
	<form method="POST" action="?/gtmAuto" use:enhance={submit('gtm')}><button class="btn btn-primary" disabled={busy === 'gtm'}>{busy === 'gtm' ? 'Matching…' : 'Find & link containers'}</button></form>
	{#if msgFor('gtm')?.ok}<p class="mt-2 text-sm text-good">{msgFor('gtm')?.ok}</p>{/if}
	{#if msgFor('gtm')?.error}<p class="mt-2 text-sm text-bad">{msgFor('gtm')?.error}</p>{/if}
</details>

<!-- 5 Clarity -->
<details class="card mt-4 p-4 [&[open]>summary]:mb-2" open={!complete.clarity}>
		<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 select-none [&::-webkit-details-marker]:hidden"><h2 class="font-medium"><img src="/logos/clarity.png" alt="" width="18" height="18" class="mr-2 inline-block size-[18px] align-[-3px] object-contain" />5 · Microsoft Clarity</h2><span class="ml-auto text-xs {complete.clarity ? 'text-good' : 'text-muted-foreground'}">{statusOf.clarity}</span></summary>
	<p class="mb-3 text-xs text-muted-foreground">
		One token per project: Clarity → <b>Settings</b> → <b>Data Export</b> → <b>Generate new API token</b>. Clarity allows <b>10 API calls per project per day</b> and shows only the last 1–3 days, so SEOConsole refreshes the day's snapshot three times a day (every 8½ hours) (9 calls a day) and keeps one call for you.
		The token only reads data: Clarity's <b>script</b> must also be on the site to record anything. Each site's <b>Clarity</b> tab checks the pages for it and can add it through Tag Manager.
	</p>
	{#if msgFor('clarity')?.ok}<p class="mb-2 text-sm text-good">{msgFor('clarity')?.ok}</p>{/if}
	{#if msgFor('clarity')?.error}<p class="mb-2 text-sm text-bad">{msgFor('clarity')?.error}</p>{/if}
	<div class="overflow-x-auto">
		<table class="w-full">
			<tbody>
				{#each data.rows as r (r.id)}
					<tr>
						<td class="td pii whitespace-nowrap">{r.name}</td>
						<td class="td">
							{#if r.links.clarity}
								<span class="text-good">✓ connected</span> <span class="text-xs text-muted-foreground">· {r.clarityCallsLeft} calls left today</span>
							{:else}
								<form method="POST" action="?/clarity" use:enhance={submit('c' + r.id)} class="flex gap-2">
									<input type="hidden" name="siteId" value={r.id} />
									<input class="input min-w-0 flex-1" name="token" type="password" autocomplete="off" aria-label="Clarity API token" placeholder="Clarity API token" />
									<button class="btn" disabled={busy === 'c' + r.id}>Connect</button>
								</form>
							{/if}
						</td>
						<td class="td w-px">
							{#if r.links.clarity}<form method="POST" action="?/unlink" use:enhance><input type="hidden" name="siteId" value={r.id} /><input type="hidden" name="kind" value="clarity" /><button class="btn btn-danger">Unlink</button></form>{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</details>

<!-- 5 OpenSEO -->
<details class="card mt-4 p-4 [&[open]>summary]:mb-2" open={!complete.openseo}>
		<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 select-none [&::-webkit-details-marker]:hidden"><h2 class="font-medium">6 · OpenSEO <span class="chip ml-1">optional</span></h2><span class="ml-auto text-xs {complete.openseo ? 'text-good' : 'text-muted-foreground'}">{statusOf.openseo}</span></summary>
	<p class="mb-3 text-xs text-muted-foreground">Links each site to its OpenSEO project (matched by domain) so an AI agent can combine OpenSEO's keyword/rank/audit data with this first-party data. Use an API key from OpenSEO → Settings.</p>
	{#if data.openseo}
		<div class="mb-2 flex items-center gap-2 text-sm"><span class="pii">{data.openseo.baseUrl}</span><span class="text-xs text-muted-foreground">{data.openseo.linked} site(s) linked</span>
			<form method="POST" action="?/openseoRemove" use:enhance class="ml-auto"><button class="btn btn-danger">Disconnect</button></form></div>
	{/if}
	<form method="POST" action="?/openseo" use:enhance={submit('openseo')} class="flex flex-wrap gap-2">
		<input class="input min-w-0 flex-1" name="baseUrl" aria-label="OpenSEO address" placeholder="https://your-openseo.example.com" value={data.openseo?.baseUrl ?? ''} required />
		<input class="input w-56" name="apiKey" type="password" autocomplete="off" aria-label="OpenSEO API key" placeholder="oseo_… API key" required />
		<button class="btn btn-primary" disabled={busy === 'openseo'}>{busy === 'openseo' ? 'Checking…' : data.openseo ? 'Reconnect' : 'Connect'}</button>
	</form>
	{#if msgFor('openseo')?.ok}<p class="mt-2 text-sm text-good">{msgFor('openseo')?.ok}</p>{/if}
	{#if msgFor('openseo')?.error}<p class="mt-2 text-sm text-bad">{msgFor('openseo')?.error}</p>{/if}
</details>

<!-- 6 Core Web Vitals -->
<details class="card mt-4 p-4 [&[open]>summary]:mb-2" open={!complete.crux}>
		<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 select-none [&::-webkit-details-marker]:hidden"><h2 class="font-medium"><img src="/logos/chrome.svg" alt="" width="18" height="18" class="mr-2 inline-block size-[18px] align-[-3px] object-contain" />7 · Core Web Vitals <span class="chip ml-1">optional</span></h2><span class="ml-auto text-xs {complete.crux ? 'text-good' : 'text-muted-foreground'}">{statusOf.crux}</span></summary>
	<Explainer lead="Real-user page speed from Google's Chrome UX Report.">
	<p>Real-user speed data (LCP, INP, CLS and more) from Google's Chrome UX Report, saved once a day per site. It needs a free API key: in Google Cloud Console enable the <b>Chrome UX Report API</b>, then create an API key under Credentials. Sites with too little Chrome traffic have no data, which is normal.</p>
</Explainer>
	{#if data.crux}
		<div class="mb-2 flex items-center gap-2 text-sm"><span>Connected</span><span class="text-xs text-muted-foreground">data for {data.crux.sites} site(s) so far</span>
			<form method="POST" action="?/cruxRemove" use:enhance class="ml-auto"><button class="btn btn-danger">Disconnect</button></form></div>
	{/if}
	<form method="POST" action="?/crux" use:enhance={submit('crux')} class="flex flex-wrap gap-2">
		<input class="input min-w-0 flex-1" name="apiKey" type="password" autocomplete="off" aria-label="Google API key" placeholder="Google API key" required />
		<button class="btn btn-primary" disabled={busy === 'crux'}>{busy === 'crux' ? 'Checking…' : data.crux ? 'Replace key' : 'Connect'}</button>
	</form>
	{#if msgFor('crux')?.ok}<p class="mt-2 text-sm text-good">{msgFor('crux')?.ok}</p>{/if}
	{#if msgFor('crux')?.error}<p class="mt-2 text-sm text-bad">{msgFor('crux')?.error}</p>{/if}
</details>

<!-- 8 Ahrefs Domain Rating -->
<details class="card mt-4 p-4 [&[open]>summary]:mb-2" open={!complete.ahrefs}>
	<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 select-none [&::-webkit-details-marker]:hidden"><h2 class="font-medium">8 · Ahrefs Domain Rating <span class="chip ml-1">optional</span></h2><span class="ml-auto text-xs {complete.ahrefs ? 'text-good' : data.ahrefs?.rejected ? 'text-bad' : 'text-muted-foreground'}">{statusOf.ahrefs}</span></summary>
	<Explainer lead="Shows Ahrefs' Domain Rating (DR, 0 to 100) next to each site's name, free.">
		<p>It uses Ahrefs' free Domain Rating endpoint, which costs no API units and needs no paid plan: create a key under Account settings, API keys, in a free Ahrefs account. One request a week carries every site's domain, and nothing else about your sites is sent. Ahrefs' <a class="underline" href="http://ahrefs.com/legal/domain-rating-license" target="_blank" rel="noopener">Domain Rating License</a> asks for the credit "Domain Rating by Ahrefs" next to the number: the circle links to Ahrefs and the credit is written out once on each page that shows it. The key is stored encrypted. Checked once against the live service; expect small fixes.</p>
	</Explainer>
	{#if data.ahrefs}
		<div class="mb-2 flex flex-wrap items-center gap-2 text-sm"><span>{data.ahrefs.rejected ? 'Key rejected' : 'Connected'}</span><span class="text-xs text-muted-foreground">DR for {data.ahrefs.withDr} of {data.ahrefs.total} site(s)</span>
			<form method="POST" action="?/ahrefsRefresh" use:enhance={submit('ahrefs-refresh')} class="ml-auto"><button class="btn" disabled={data.ahrefs.rejected || busy === 'ahrefs-refresh'} title="Looks every site up again now (free)">Refresh now</button></form>
			<form method="POST" action="?/ahrefsRemove" use:enhance><button class="btn btn-danger">Disconnect</button></form></div>
		{#if data.ahrefs.lastError}<p class="mb-2 text-xs text-bad">Last problem: {data.ahrefs.lastError}</p>{/if}
	{/if}
	<form method="POST" action="?/ahrefsKey" use:enhance={submit('ahrefs')} class="flex flex-wrap gap-2">
		<input class="input min-w-0 flex-1" name="apiKey" type="password" autocomplete="off" aria-label="Ahrefs API key" placeholder="Ahrefs API v3 key" required />
		<button class="btn btn-primary" disabled={busy === 'ahrefs'}>{busy === 'ahrefs' ? 'Checking…' : data.ahrefs ? 'Replace key' : 'Connect'}</button>
	</form>
	{#if msgFor('ahrefs')?.ok}<p class="mt-2 text-sm text-good">{msgFor('ahrefs')?.ok}</p>{/if}
	{#if msgFor('ahrefs')?.error}<p class="mt-2 text-sm text-bad">{msgFor('ahrefs')?.error}</p>{/if}
</details>

<!-- 9 Moz Domain Authority -->
<details class="card mt-4 p-4 [&[open]>summary]:mb-2" open={!complete.moz}>
	<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 select-none [&::-webkit-details-marker]:hidden"><h2 class="font-medium">9 · Moz Domain Authority <span class="chip ml-1">optional</span></h2><span class="ml-auto text-xs {complete.moz ? 'text-good' : data.moz?.rejected ? 'text-bad' : 'text-muted-foreground'}">{statusOf.moz}</span></summary>
	<Explainer lead="Shows Moz's Domain Authority (DA, 0 to 100) next to each site's name. Optional: it may not work with new Moz accounts.">
		<p>This uses Moz's older Links API, which signs in with an Access ID and a Secret Key. Moz's current documentation describes a newer API with a single token and says it is moving between versions, so a new Moz account, including a free trial one, may not be given an Access ID and Secret Key, and Moz may ask for a paid plan. If you cannot get them, skip this step: DA is optional, the Ahrefs Domain Rating above covers the same need, and nothing else depends on it.</p>
		<p>If you do have an Access ID and Secret Key: Moz limits plans by monthly rows, so the app looks each site up once a month, never spends more than a monthly budget of rows (40 by default, <code>MOZ_MONTHLY_ROWS</code>), and spaces requests 10 seconds apart. Connecting uses one row to check the credentials. The credentials are stored encrypted, and only domain names are sent. This was written from third-party descriptions of Moz's API and has never been run against the live service: expect fixes, and check Moz's current limits and its attribution rules.</p>
	</Explainer>
	{#if data.moz}
		<div class="mb-2 flex flex-wrap items-center gap-2 text-sm"><span>{data.moz.rejected ? 'Credentials rejected' : 'Connected'}</span><span class="text-xs text-muted-foreground">DA for {data.moz.withDa} of {data.moz.total} site(s) · rows used this month {data.moz.rowsUsed} of {data.moz.rowBudget}</span>
			<form method="POST" action="?/mozRefresh" use:enhance={submit('moz-refresh')} class="ml-auto"><button class="btn" disabled={data.moz.rejected || busy === 'moz-refresh'} title="Looks the sites up again now, which uses Moz rows">Refresh now</button></form>
			<form method="POST" action="?/mozRemove" use:enhance><button class="btn btn-danger">Disconnect</button></form></div>
		{#if data.moz.lastError}<p class="mb-2 text-xs text-bad">Last problem: {data.moz.lastError}</p>{/if}
	{/if}
	<form method="POST" action="?/mozKeys" use:enhance={submit('moz')} class="flex flex-wrap gap-2">
		<input class="input min-w-0 flex-1 basis-48" name="accessId" type="text" autocomplete="off" aria-label="Moz Access ID" placeholder="Moz Access ID" required />
		<input class="input min-w-0 flex-1 basis-48" name="secretKey" type="password" autocomplete="off" aria-label="Moz Secret Key" placeholder="Moz Secret Key" required />
		<button class="btn btn-primary" disabled={busy === 'moz'}>{busy === 'moz' ? 'Checking…' : data.moz ? 'Replace' : 'Connect'}</button>
	</form>
	{#if msgFor('moz')?.ok}<p class="mt-2 text-sm text-good">{msgFor('moz')?.ok}</p>{/if}
	{#if msgFor('moz')?.error}<p class="mt-2 text-sm text-bad">{msgFor('moz')?.error}</p>{/if}
</details>

