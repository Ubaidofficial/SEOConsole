<script lang="ts">
	import { page } from '$app/state';
	import { CalendarDays } from '@lucide/svelte';
	import { MAX_DAYS, MENU_PERIODS, QUICK_PERIODS, periodLabel, shiftDay } from '$lib/periods';

	/**
	 * 24h, 3d, 7d and 28d, then a date-picker menu: the longer ranges (3m, 6m, 16m) and a "from" date. A date means "since then, up to the
	 * newest data", so every report keeps one consistent window. `latest` is the newest day of data on the page.
	 */
	let { days, latest = null }: { days: number; latest?: string | null } = $props();

	const href = (d: number) => {
		const u = new URL(page.url);
		u.searchParams.delete('from');
		u.searchParams.set('days', String(d));
		return u.pathname + u.search;
	};
	const quick = $derived((QUICK_PERIODS as readonly number[]).includes(days));
	const inMenu = $derived((MENU_PERIODS as readonly number[]).includes(days));
	const since = $derived(latest ? shiftDay(latest, -(days - 1)) : null);
	/** What the menu button says: the range picked from it, or an invitation. */
	const menuLabel = $derived(quick ? 'Dates' : inMenu ? periodLabel(days) : since ? `Since ${since}` : `${days}d`);
	/** The page's other query (tab, view…) travels with the form; the period is replaced. */
	const keep = $derived([...page.url.searchParams].filter(([k]) => k !== 'days' && k !== 'from'));
	const earliest = $derived(latest ? shiftDay(latest, -(MAX_DAYS - 1)) : undefined);

	let open = $state(false);
	let box = $state<HTMLDetailsElement>();
	const close = () => (open = false);
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} onclick={(e) => box && open && !box.contains(e.target as Node) && close()} />

<div class="inline-flex items-center rounded-lg bg-muted p-0.5" role="group" aria-label="Period">
	{#each QUICK_PERIODS as d}
		<a
			href={href(d)}
			aria-current={d === days ? 'true' : undefined}
			title={d === 1 ? 'The newest day Search Console has: it reports whole days and runs about two days behind' : undefined}
			class="rounded-md px-2.5 py-1 text-xs font-medium transition-all {d === days ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}">{periodLabel(d)}</a
		>
	{/each}
	<details bind:this={box} bind:open class="relative">
		<summary
			aria-label="Choose dates"
			aria-current={!quick ? 'true' : undefined}
			class="flex cursor-pointer list-none items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-all select-none [&::-webkit-details-marker]:hidden {!quick ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}"
		>
			<CalendarDays class="size-3.5" aria-hidden="true" />{menuLabel}
		</summary>
		<div class="absolute right-0 z-30 mt-2 w-64 rounded-xl border bg-card p-3 text-left shadow-lg">
			<p class="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Longer ranges</p>
			<div class="mb-3 flex gap-1">
				{#each MENU_PERIODS as d}
					<a href={href(d)} onclick={close} aria-current={d === days ? 'true' : undefined} class="flex-1 rounded-md border px-2 py-1.5 text-center text-xs font-medium hover:bg-accent {d === days ? 'border-foreground bg-accent' : ''}">{periodLabel(d)}</a>
				{/each}
			</div>
			<form method="GET" action={page.url.pathname} onsubmit={close}>
				{#each keep as [k, v]}<input type="hidden" name={k} value={v} />{/each}
				<label for="period-from" class="mb-1.5 block text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Or pick a start date</label>
				<input id="period-from" name="from" type="date" required min={earliest} max={latest ?? undefined} value={!quick && !inMenu && since ? since : ''} class="input mb-2 w-full" />
				<p class="mb-2 text-[11px] leading-snug text-muted-foreground">From that day to the newest data{latest ? ` (${latest})` : ''}. Search Console runs about two days behind.</p>
				<button class="btn btn-primary w-full">Apply</button>
			</form>
		</div>
	</details>
</div>
