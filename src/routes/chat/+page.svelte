<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { goto, replaceState } from '$app/navigation';
	import { ArrowUp, Check, ChevronRight, History, KeyRound, LoaderCircle, MessageSquarePlus, ShieldCheck, Sparkles, Square, Trash2, X } from '@lucide/svelte';
	import ChatChart from '$lib/components/ChatChart.svelte';
	import { renderMarkdown } from '$lib/markdown';
	import type { ApprovalItem, ChatEvent, ChatItem, ToolActivity } from '$lib/chat';
	import { splitFollowUps } from '$lib/chat';

	let { data } = $props();

	type Item = ChatItem | { kind: 'error'; text: string };
	let items = $state<Item[]>([]);
	let approvals = $state<ApprovalItem[]>([]);
	let threadId = $state<number | null>(null);
	let threads = $state<{ id: number; title: string; updated_at: number }[]>([]);
	let sent = $state(0);
	let draft = $state('');
	let busy = $state(false);
	let historyOpen = $state(false);
	let openText = false;
	let controller: AbortController | null = null;
	let input = $state<HTMLTextAreaElement>();

	// A different conversation (or a fresh page) replaces what is shown; a running answer keeps its local state.
	$effect(() => {
		const d = data;
		if (untrack(() => busy)) return;
		items = structuredClone(d.items) as Item[];
		approvals = structuredClone(d.approvals);
		threadId = d.thread?.id ?? null;
		threads = d.threads;
		sent = d.usage.sent;
	});

	// Which provider and model answer: the person's pick from the menus, remembered in this browser (a convenience, never needed).
	let providerId = $state('');
	let modelId = $state('');
	let models = $state<string[]>([]);
	const current = $derived(data.providers.find((p) => p.id === providerId) ?? data.providers[0]);
	const modelOptions = $derived(modelId && !models.includes(modelId) ? [modelId, ...models] : models);
	const remember = (k: string, v: string) => {
		try {
			localStorage.setItem(k, v);
		} catch {
			/* private window or blocked storage: the pick just is not remembered */
		}
	};
	const recall = (k: string) => {
		try {
			return localStorage.getItem(k) ?? '';
		} catch {
			return '';
		}
	};
	async function loadModels(id: string) {
		models = [];
		const p = data.providers.find((x) => x.id === id);
		if (!p || data.locked) return;
		modelId = recall(`osc.chat.model.${id}`) || p.model;
		try {
			const res = await fetch(`/chat/models?provider=${encodeURIComponent(id)}`);
			if (!res.ok || providerId !== id) return;
			const d = (await res.json()) as { models: string[]; default: string };
			models = d.models;
			// A remembered model the provider no longer lists is dropped for its default (or the first it lists).
			if (d.models.length && modelId && !d.models.includes(modelId) && modelId !== d.default) modelId = d.default || d.models[0];
			else if (!modelId) modelId = d.default || d.models[0] || '';
		} catch {
			/* no list: the model set on the server still works */
		}
	}
	function pickProvider(id: string) {
		providerId = id;
		remember('osc.chat.provider', id);
		loadModels(id);
	}
	function pickModel(m: string) {
		modelId = m;
		remember(`osc.chat.model.${providerId}`, m);
	}
	const pick = () => (data.locked || !current ? {} : { provider: current.id, ...(modelId ? { model: modelId } : {}) });
	onMount(() => {
		const saved = recall('osc.chat.provider');
		pickProvider(data.providers.some((p) => p.id === saved) ? saved : (data.providers[0]?.id ?? ''));
	});

	const empty = $derived(items.length === 0 && !busy);
	const left = $derived(Math.max(0, data.usage.limit - sent));

	function nearBottom() {
		return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
	}
	async function follow(force = false) {
		const stick = force || nearBottom();
		await tick();
		if (stick) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: force ? 'smooth' : 'auto' });
	}

	function upsertTool(t: ToolActivity) {
		const at = items.findIndex((i) => i.kind === 'tool' && i.tool.id === t.id);
		if (at >= 0) items[at] = { kind: 'tool', tool: t };
		else items.push({ kind: 'tool', tool: t });
		openText = false;
	}

	function handle(e: ChatEvent) {
		switch (e.type) {
			case 'thread':
				threadId = e.id;
				threads = [{ id: e.id, title: e.title, updated_at: Date.now() }, ...threads.filter((t) => t.id !== e.id)];
				replaceState(`/chat?t=${e.id}`, {});
				break;
			case 'text': {
				const last = items[items.length - 1];
				if (openText && last?.kind === 'text') last.text += e.text;
				else items.push({ kind: 'text', text: e.text });
				openText = true;
				break;
			}
			case 'break':
				openText = false;
				break;
			case 'tool':
				upsertTool(e.tool);
				break;
			case 'chart':
				items.push({ kind: 'chart', chart: e.chart });
				openText = false;
				break;
			case 'approval':
				approvals = e.items;
				break;
			case 'error':
				items.push({ kind: 'error', text: e.message });
				openText = false;
				break;
			case 'done':
				break;
		}
		follow();
	}

	async function stream(body: Record<string, unknown>) {
		busy = true;
		openText = false;
		controller = new AbortController();
		try {
			const res = await fetch('/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
			if (!res.ok || !res.body) {
				items.push({ kind: 'error', text: (await res.text().catch(() => '')) || `The server answered ${res.status}.` });
				return;
			}
			const reader = res.body.getReader();
			const dec = new TextDecoder();
			let buf = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let nl: number;
				while ((nl = buf.indexOf('\n')) >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (line) handle(JSON.parse(line) as ChatEvent);
				}
			}
		} catch (err) {
			if ((err as Error).name !== 'AbortError') items.push({ kind: 'error', text: 'The connection dropped. What arrived so far is saved; ask again to continue.' });
		} finally {
			busy = false;
			controller = null;
			for (const i of items) if (i.kind === 'tool' && i.tool.status === 'running' && !approvals.some((a) => a.id === i.tool.id)) i.tool.status = 'error';
			threads = [...threads.filter((t) => t.id === threadId), ...threads.filter((t) => t.id !== threadId)];
			await tick();
			if (approvals.length) follow(true);
			input?.focus({ preventScroll: true });
		}
	}

	async function ask(text: string) {
		const t = text.trim();
		if (!t || busy || !data.ready) return;
		if (approvals.length) {
			// Writing instead of answering declines what was waiting (the server reports it to the model).
			for (const a of approvals) items.push({ kind: 'tool', tool: { id: a.id, name: a.name, label: a.label, status: 'declined' } });
			approvals = [];
		}
		items.push({ kind: 'user', text: t });
		sent++;
		draft = '';
		resize();
		await follow(true);
		await stream({ threadId, text: t, ...pick() });
	}

	async function decide(approve: boolean | 'each', each: Record<string, boolean> = {}) {
		if (!threadId || busy) return;
		const decisions = Object.fromEntries(approvals.map((a) => [a.id, approve === 'each' ? !!each[a.id] : approve]));
		approvals = [];
		sent++; // an answer to an approval counts as a turn, like a message
		await stream({ threadId, decisions, ...pick() });
	}
	let picks = $state<Record<string, boolean>>({});

	function stop() {
		controller?.abort();
	}
	function keydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			ask(draft);
		}
	}
	function resize() {
		if (!input) return;
		input.style.height = 'auto';
		input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
	}
	function newChat() {
		if (busy) stop();
		goto('/chat');
		historyOpen = false;
	}

	onMount(() => {
		if (data.q && data.ready && !data.thread) {
			const q = data.q;
			replaceState('/chat', {});
			ask(q);
		} else {
			if (data.draft && !data.thread) {
				draft = data.draft;
				replaceState('/chat', {});
			}
			input?.focus();
			if (input && draft) input.setSelectionRange(draft.length, draft.length);
		}
		if (items.length) window.scrollTo({ top: document.documentElement.scrollHeight });
	});

	const pretty = (v: unknown) => JSON.stringify(v, null, 2);
	const when = (t: number) => {
		const d = Date.now() - t;
		if (d < 3_600_000) return `${Math.max(1, Math.round(d / 60_000))}m`;
		if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`;
		return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	};
	const toolIcon = { running: LoaderCircle, done: Check, error: X, declined: X } as const;
</script>

<div class="grid gap-6 lg:grid-cols-[248px_minmax(0,1fr)]">
	<!-- Conversations -->
	<aside class="lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:self-start lg:overflow-y-auto">
		<div class="flex items-center gap-2">
			<button type="button" onclick={newChat} class="btn flex-1 justify-start"><MessageSquarePlus class="size-4" />New chat</button>
			<button type="button" class="btn lg:hidden" aria-expanded={historyOpen} onclick={() => (historyOpen = !historyOpen)}><History class="size-4" />History</button>
		</div>
		<nav class="mt-3 space-y-0.5 {historyOpen ? '' : 'max-lg:hidden'}" aria-label="Conversations">
			{#if threads.length === 0}
				<p class="px-2 py-3 text-xs text-muted-foreground">Your conversations appear here. Only you can see them.</p>
			{/if}
			{#each threads as t (t.id)}
				<div class="group flex items-center rounded-lg {t.id === threadId ? 'bg-accent' : 'hover:bg-accent/60'}">
					<a href="/chat?t={t.id}" class="min-w-0 flex-1 truncate px-2.5 py-1.5 text-[13px] {t.id === threadId ? 'font-medium' : 'text-muted-foreground group-hover:text-foreground'}" aria-current={t.id === threadId ? 'page' : undefined} onclick={() => (historyOpen = false)}>{t.title}</a>
					<span class="pr-1 text-[11px] text-muted-foreground group-hover:hidden">{when(t.updated_at)}</span>
					<form method="POST" action="?/delete{threadId ? `&t=${threadId}` : ''}" use:enhance={() => async ({ update }) => { threads = threads.filter((x) => x.id !== t.id); await update({ reset: false }); }} class="hidden group-hover:block">
						<input type="hidden" name="id" value={t.id} />
						<button class="rounded-md p-1.5 text-muted-foreground hover:bg-background hover:text-destructive" aria-label="Delete “{t.title}”" title="Delete"><Trash2 class="size-3.5" /></button>
					</form>
				</div>
			{/each}
		</nav>
	</aside>

	<!-- Conversation -->
	<section class="mx-auto flex w-full max-w-3xl min-w-0 flex-col {empty ? 'justify-center lg:min-h-[calc(100dvh-10rem)]' : 'min-h-[calc(100dvh-10rem)]'}">
		{#if empty}
			<div class="mb-8 text-center">
				<div class="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm"><Sparkles class="size-6" /></div>
				<h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">Ask your data anything</h1>
				<p class="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">Search Console, Bing, GA4, Clarity and AI answers for every site you can see, in plain language. Every number comes from your own data, and nothing changes without your click.</p>
			</div>
			{#if !data.ready}
				<div class="mx-auto mb-6 w-full max-w-xl rounded-xl border border-dashed bg-card p-5 text-sm">
					<p class="flex items-center gap-2 font-medium"><KeyRound class="size-4" />One step to switch it on</p>
					<p class="mt-1.5 text-muted-foreground">{data.setupProblem}</p>
					<!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable block must be reachable by keyboard to scroll it) -->
					<pre tabindex="0" class="mt-3 overflow-x-auto rounded-lg bg-muted px-3 py-2 text-xs">ANTHROPIC_API_KEY=sk-ant-…</pre>
					<p class="mt-2 text-xs text-muted-foreground">Or another provider: <code>CHAT_PROVIDER=deepseek</code> with <code>DEEPSEEK_API_KEY</code> (also openai, gemini, kimi, openrouter, groq, mistral, xai, or custom with <code>CHAT_BASE_URL</code>). List more in <code>CHAT_PROVIDERS</code> to let people choose between them in the chat.</p>
					<p class="mt-2 text-xs text-muted-foreground">Questions and the data they need are sent to the provider you pick, and usage is billed by it; each person can send {data.usage.limit} messages a day (CHAT_MESSAGES_PER_DAY).</p>
				</div>
			{/if}
		{:else}
			<ol class="flex-1 space-y-5 pb-6" aria-live="polite">
				{#each items as item, i (i)}
					{#if item.kind === 'user'}
						<li class="flex justify-end"><div class="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-primary-foreground">{item.text}</div></li>
					{:else if item.kind === 'text'}
						{@const parts = splitFollowUps(item.text)}
						<li class="flex gap-3">
							<div class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border bg-card {items[i - 1]?.kind === 'user' ? '' : 'invisible'}"><img src="/brand/mark-glyph.svg" alt="" class="size-4" /></div>
							<div class="min-w-0 flex-1">
								<div class="md text-[14px] leading-relaxed">{@html renderMarkdown(parts.body)}</div>
								{#if parts.followUps.length && !busy && !approvals.length && i === items.length - 1}
									<div class="mt-3 flex flex-wrap gap-1.5" aria-label="Suggested follow-up questions">{#each parts.followUps as f}<button type="button" class="chip hover:bg-accent" onclick={() => ask(f)}>{f}</button>{/each}</div>
								{/if}
							</div>
						</li>
					{:else if item.kind === 'tool'}
						{@const Icon = toolIcon[item.tool.status]}
						<li class="flex gap-3 !mt-2">
							<div class="size-7 shrink-0"></div>
							<div class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs {item.tool.status === 'error' ? 'border-destructive/30 text-destructive' : 'text-muted-foreground'}" title={item.tool.error ?? item.tool.name}>
								<Icon class="size-3.5 shrink-0 {item.tool.status === 'running' ? 'animate-spin' : ''} {item.tool.status === 'done' ? 'text-good' : ''}" />
								<span class="truncate">{item.tool.label}{item.tool.status === 'declined' ? ' · declined' : ''}</span>
							</div>
						</li>
					{:else if item.kind === 'chart'}
						<li class="flex gap-3"><div class="size-7 shrink-0"></div><div class="min-w-0 flex-1"><ChatChart chart={item.chart} /></div></li>
					{:else if item.kind === 'error'}
						<li class="flex gap-3"><div class="size-7 shrink-0"></div><p class="flex-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">{item.text}</p></li>
					{/if}
				{/each}
				{#if busy && (items[items.length - 1]?.kind === 'user' || (items[items.length - 1]?.kind === 'tool' && items.every((x) => x.kind !== 'tool' || x.tool.status !== 'running')))}
					<li class="flex items-center gap-3 text-[13px] text-muted-foreground"><div class="grid size-7 place-items-center rounded-lg border bg-card"><img src="/brand/mark-glyph.svg" alt="" class="size-4" /></div><span class="thinking">Thinking</span></li>
				{/if}
				{#if approvals.length && !busy}
					<li class="ml-10 rounded-xl border border-[color:var(--warn)]/40 bg-card p-4 shadow-xs">
						<p class="flex items-center gap-2 text-sm font-semibold"><ShieldCheck class="size-4 text-[color:var(--warn)]" />{approvals.length === 1 ? 'Approve this change?' : `Approve these ${approvals.length} changes?`}</p>
						<p class="mt-1 text-xs text-muted-foreground">Nothing has run yet. Approved changes run as you, are rate-limited and are recorded in the audit log.</p>
						<ul class="mt-3 space-y-2">
							{#each approvals as a (a.id)}
								<li class="rounded-lg border bg-background">
									<details>
										<summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px]">
											{#if approvals.length > 1}<input type="checkbox" class="size-3.5" bind:checked={picks[a.id]} onclick={(e) => e.stopPropagation()} aria-label="Approve {a.label}" />{/if}
											<span class="flex-1 font-medium">{a.label}</span><ChevronRight class="size-3.5 text-muted-foreground" />
										</summary>
										<!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable block must be reachable by keyboard to scroll it) -->
										<pre tabindex="0" class="overflow-x-auto border-t px-3 py-2 text-[11px] text-muted-foreground">{a.name} {pretty(a.input)}</pre>
									</details>
								</li>
							{/each}
						</ul>
						<div class="mt-3 flex flex-wrap gap-2">
							<button type="button" class="btn btn-primary btn-sm" onclick={() => decide(true)}><Check class="size-4" />{approvals.length > 1 ? 'Approve all' : 'Approve'}</button>
							{#if approvals.length > 1}<button type="button" class="btn btn-sm" onclick={() => decide('each', picks)}>Approve selected</button>{/if}
							<button type="button" class="btn btn-sm" onclick={() => decide(false)}>Decline</button>
						</div>
					</li>
				{/if}
			</ol>
		{/if}

		<!-- Composer -->
		<div class="-mx-1 px-1 pb-3 {empty ? '' : 'sticky bottom-0 z-10 bg-gradient-to-t from-background via-background to-background/0 pt-4'}">
			<form class="rounded-2xl border bg-card shadow-sm transition-shadow focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/30" onsubmit={(e) => { e.preventDefault(); ask(draft); }}>
				<label for="chat-input" class="sr-only">Ask about your sites</label>
				<textarea id="chat-input" bind:this={input} bind:value={draft} oninput={resize} onkeydown={keydown} rows="1" maxlength="8000" disabled={!data.ready} placeholder={data.ready ? (approvals.length ? 'Or write to decline and ask something else…' : 'Ask about clicks, pages, queries, indexing, AI answers…') : 'Add ANTHROPIC_API_KEY to switch chat on'} class="block max-h-56 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"></textarea>
				<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 pb-2.5">
					{#if data.ready && !data.locked && (data.providers.length > 1 || modelOptions.length > 1)}
						{#if data.providers.length > 1}
							<select id="chat-provider" aria-label="Model provider" value={current?.id} onchange={(e) => pickProvider(e.currentTarget.value)} disabled={busy} class="max-w-[9.5rem] truncate rounded-md border bg-background px-1.5 py-1 text-[11px]">
								{#each data.providers as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
							</select>
						{/if}
						{#if modelOptions.length > 1}
							<select id="chat-model" aria-label="Model" value={modelId} onchange={(e) => pickModel(e.currentTarget.value)} disabled={busy} class="max-w-[11rem] truncate rounded-md border bg-background px-1.5 py-1 text-[11px]">
								{#each modelOptions as m (m)}<option value={m}>{m}</option>{/each}
							</select>
						{/if}
					{/if}
					<span class="text-[11px] text-muted-foreground">{#if data.role === 'viewer'}Read-only (viewer role) · {/if}{left} of {data.usage.limit} messages left today</span>
					{#if busy}
						<button type="button" onclick={stop} class="ml-auto grid size-8 place-items-center rounded-full bg-primary text-primary-foreground hover:opacity-90" aria-label="Stop"><Square class="size-3 fill-current" /></button>
					{:else}
						<button type="submit" disabled={!draft.trim() || !data.ready || left === 0} class="ml-auto grid size-8 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-30" aria-label="Send"><ArrowUp class="size-4" /></button>
					{/if}
				</div>
			</form>
			{#if empty && data.ready}
				<div class="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
					{#each data.starters as s}
						<button type="button" onclick={() => ask(s.prompt)} class="group rounded-xl border bg-card p-3 text-left transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-sm">
							<span class="block text-[13px] font-medium">{s.title}</span>
							<span class="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{s.prompt}</span>
						</button>
					{/each}
				</div>
			{/if}
			<p class="mt-2 text-center text-[11px] text-muted-foreground">Answers are written by {modelId || data.model || 'the selected model'}{current && data.providers.length > 1 ? ` (${current.label})` : ''} from your own data and can be wrong: check the numbers that matter. Changes always ask first.</p>
		</div>
	</section>
</div>
