<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { Toaster, toast } from 'svelte-sonner';
	import { Bell, Bot, ChartLine, ChevronDown, LayoutDashboard, LayoutGrid, Sparkles, Layers, ListChecks, Map as MapIcon, Plug, RefreshCw, UserCog, Users } from '@lucide/svelte';
	import PrivacyToggle from '$lib/components/privacy-toggle.svelte';
	import ThemeToggle from '$lib/components/theme-toggle.svelte';
	import { pageTitle } from '$lib/titles';
	import { privacy } from '$lib/privacy.svelte';
	import { theme } from '$lib/theme.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	let mac = $state(true);
	onMount(() => {
		privacy.init();
		theme.init();
		mac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
	});
	/** ⌘J (Ctrl+J elsewhere) opens Ask from any page; on a site's pages the question starts with that site's name. */
	function shortcut(e: KeyboardEvent) {
		if (!data.authed || e.key.toLowerCase() !== 'j' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
		e.preventDefault();
		if (page.url.pathname.startsWith('/chat')) return void document.querySelector<HTMLTextAreaElement>('textarea')?.focus();
		const site = (page.data as { site?: { name?: string } }).site?.name;
		goto(site ? `/chat?draft=${encodeURIComponent(`About ${site}: `)}` : '/chat');
	}

	let { data, children } = $props();
	/**
	 * The bar keeps the four places people go every day: their sites, the to-do list, alerts and Ask. Everything set up once and
	 * visited now and then (portfolio, sitemaps, connections, agents, accounts, team) sits in the Workspace menu, each with a line on
	 * what it is for, as onsite.so and Plausible do.
	 */
	const links = [
		['/', 'Dashboard', LayoutDashboard],
		['/actions', 'Actions', ListChecks],
		['/alerts', 'Alerts', Bell],
		['/chat', 'Ask', Sparkles]
	] as const;
	const workspace = [
		['/portfolio', 'Portfolio', Layers, 'Every site side by side, groups and cross-site findings'],
		['/sitemaps', 'Sitemaps', MapIcon, 'All sitemaps across your sites, with their health'],
		['/updates', 'Google updates', ChartLine, 'Ranking updates, marked on every chart'],
		['/connect', 'Connect', Plug, 'Link GA4, Bing, Tag Manager, Clarity and more'],
		['/agents', 'MCP', Bot, 'Let Claude, ChatGPT or Cursor read your data'],
		['/accounts', 'Accounts', Users, 'The Google accounts that sync your sites'],
		['/team', 'Team', UserCog, 'Who can see and change what']
	] as const;
	// Someone limited to some sites gets only the pages that show nothing from other sites (the server refuses the rest).
	const SCOPED_LINKS = new Set(['/', '/chat', '/alerts', '/team']);
	const shown = $derived(data.user?.scoped ? links.filter(([href]) => SCOPED_LINKS.has(href)) : links);
	const menu = $derived(data.user?.scoped ? workspace.filter(([href]) => SCOPED_LINKS.has(href)) : workspace);
	const inMenu = $derived(menu.find(([href]) => page.url.pathname.startsWith(href)) ?? null);
	let wsOpen = $state(false);
	let wsBox = $state<HTMLDetailsElement>();
	$effect(() => {
		void page.url.pathname;
		wsOpen = false;
	});
	const active = (href: string) => (href === '/' ? page.url.pathname === '/' || page.url.pathname.startsWith('/sites') : page.url.pathname.startsWith(href));

	// One place turns every form-action result into a toast, so no action finishes silently.
	let seen: unknown = null;
	$effect(() => {
		const f = page.form as Record<string, unknown> | null;
		if (!f || f === seen) return;
		seen = f;
		if (typeof f.error === 'string') toast.error(f.error);
		else if (typeof f.ok === 'string') toast.success(f.ok);
		else if (typeof f.summary === 'string') toast.success(f.summary);
		else if (typeof f.queued === 'number') {
			const q = f as { queued: number; removed?: number; listError?: string | null };
			if (q.listError) toast.error('Could not refresh the property list from Google', { description: q.listError });
			if (q.removed) toast.success(`${q.removed} propert${q.removed === 1 ? 'y' : 'ies'} removed in Search Console no longer show here`);
			if (q.queued === 0) toast('Nothing to queue: every site is already syncing or has no access');
			else toast.success(`Queued ${q.queued} site${q.queued === 1 ? '' : 's'} for sync`);
		}
		else if (typeof f.hidden === 'number') toast.success(`Hid ${f.hidden} duplicate propert${f.hidden === 1 ? 'y' : 'ies'}`);
		else if (typeof f.newKey === 'string') toast.success('API key created. Copy it now; it is shown once.');
	});
</script>

<svelte:head><title>{pageTitle(page.url.pathname)}</title></svelte:head>
<svelte:window onkeydown={(e) => { shortcut(e); if (e.key === 'Escape') wsOpen = false; }} onclick={(e) => wsOpen && wsBox && !wsBox.contains(e.target as Node) && (wsOpen = false)} />

<Toaster theme={theme.dim ? 'dark' : 'light'} richColors closeButton position="bottom-right" />

<header class="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
	<div class="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
		<a href="/" class="flex items-center gap-2 font-semibold tracking-tight whitespace-nowrap">
			<img src="/brand/mark-glyph.svg" alt="" width="24" height="24" class="size-6 dark:hidden" />
			<img src="/brand/mark-dark.svg" alt="" width="24" height="24" class="hidden size-6 dark:block" />
			SEOConsole
		</a>
		{#if data.authed}<nav class="order-last flex w-full gap-0.5 overflow-x-auto sm:order-none sm:w-auto sm:overflow-visible" aria-label="Main">
			{#each shown as [href, label, Icon]}
				<a
					{href}
					aria-current={active(href) ? 'page' : undefined}
					class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors {active(href) ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"
				>
					<Icon class="size-3.5" />{label}{#if href === '/chat'}<kbd class="ml-0.5 hidden rounded border px-1 font-sans text-[10px] text-muted-foreground lg:inline" title="Open Ask from any page">{mac ? '⌘J' : 'Ctrl J'}</kbd>{/if}{#if href === '/alerts' && data.alerts.open}<span class="ml-0.5 inline-grid min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold {data.alerts.problems ? 'bg-[color:var(--bad)] text-white' : 'bg-muted text-muted-foreground'}" title="{data.alerts.open} open alert{data.alerts.open === 1 ? '' : 's'}">{data.alerts.open}</span>{/if}
				</a>
			{/each}
			{#if menu.length}
				<details class="relative" bind:open={wsOpen} bind:this={wsBox}>
					<summary class="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap select-none [&::-webkit-details-marker]:hidden {inMenu ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"><LayoutGrid class="size-3.5" />{inMenu ? inMenu[1] : 'Workspace'}<ChevronDown class="size-3 opacity-60" /></summary>
					<div class="fixed inset-x-3 top-full z-50 mt-1 grid gap-0.5 rounded-xl border bg-card p-1.5 shadow-lg sm:absolute sm:inset-x-auto sm:top-full sm:left-0 sm:mt-1.5 sm:w-80" role="menu">
						{#each menu as [href, label, Icon, about]}
							<a {href} role="menuitem" aria-current={page.url.pathname.startsWith(href) ? 'page' : undefined} class="flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent {page.url.pathname.startsWith(href) ? 'bg-accent' : ''}">
								<span class="ibadge ibadge-sm tone-gray mt-0.5" aria-hidden="true"><Icon class="size-3.5" /></span>
								<span class="min-w-0"><span class="block text-[13px] font-medium">{label}</span><span class="block text-xs leading-snug text-muted-foreground">{about}</span></span>
							</a>
						{/each}
					</div>
				</details>
			{/if}
		</nav>{/if}
		<div class="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
			{#if data.queue.active + data.queue.waiting > 0}
				<span class="inline-flex items-center gap-1.5 rounded-md border px-2 py-1" title="Background syncs running"><RefreshCw class="size-3 animate-spin" />{data.queue.active + data.queue.waiting} syncing</span>
			{/if}
			{#if data.demo}<span class="chip">demo data</span>{/if}
			{#if data.readOnly}<span class="chip">read-only</span>{/if}
			{#if data.hasPassword && data.user}
				<a href="/profile" class="inline-flex max-w-48 items-center gap-1.5 truncate rounded-md px-2 py-1 hover:bg-accent hover:text-accent-foreground" title={data.user.email ? `Signed in as ${data.user.name} (${data.user.email}), ${data.user.roleLabel}. Open your account.` : `Signed in as the owner. Open your account.`}>
					<span class="truncate"><span class="pii">{data.user.name}</span></span><span class="chip">{data.user.roleLabel}</span>
				</a>
				<form method="POST" action="/logout"><button class="rounded-md px-2 py-1 hover:bg-accent hover:text-accent-foreground">Sign out</button></form>
			{/if}
			<ThemeToggle />
			<PrivacyToggle />
		</div>
	</div>
</header>
{#if data.user?.role === 'viewer'}
	<div class="border-b bg-accent/40 px-4 py-1.5 text-center text-xs text-muted-foreground">You have view-only access: buttons that change something will be refused.</div>
{/if}
{#if data.revoked}
	<div class="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
		{data.revoked} Google account(s) lost access. <a class="font-medium underline" href="/accounts">Reconnect</a> to resume syncing.
	</div>
{/if}
<main class="mx-auto max-w-[1400px] px-4 py-6">{#key page.url.pathname.split('/').slice(1, 3).join('/')}<div class="page-in">{@render children()}</div>{/key}</main>
<footer class="mx-auto max-w-[1400px] px-4 pb-8 text-xs text-muted-foreground"><a class="hover:underline" href="/compare">Compare</a> · <a class="hover:underline" href="/privacy">Privacy policy</a> · <a class="hover:underline" href="/terms">Terms of service</a></footer>
