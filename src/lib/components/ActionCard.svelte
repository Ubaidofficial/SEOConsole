<script lang="ts">
	import { enhance } from '$app/forms';
	import { NAMES_TARGETS, type ActionItem } from '$lib/actions';
	import { Tip } from '$lib/components/ui/tooltip';
	import { AlarmClock, ArrowUpRight, Check, CircleAlert, Gem, Link, ListChecks, RotateCcw, Search, ShieldAlert, Sparkles, TrendingDown, TrendingUp, Wrench, Zap } from '@lucide/svelte';
	import { BLOCKING_EXPLAIN, BUTTON_EXPLAIN, CONFIDENCE_EXPLAIN, EFFORT_EXPLAIN, IMPACT_EXPLAIN, NO_IMPACT_EXPLAIN, TYPE_EXPLAIN, TYPE_LABEL } from '$lib/explain';
	/**
	 * One finding. The controls sit on the first line so a card is three short lines, not five. `sameAs` is the rank of an earlier card in
	 * the same list with the very same instructions: then they are not repeated word for word, only pointed to.
	 */
	let { a, rank, site = null, siteHref = null, hideControls = false, restore = false, sameAs = null }: { a: ActionItem & { score?: number; site?: string }; rank: number; site?: string | null; siteHref?: string | null; hideControls?: boolean; restore?: boolean; sameAs?: number | null } = $props();
	const names = $derived(NAMES_TARGETS.has(a.type));
	const conf = { high: 'text-good', medium: 'text-muted-foreground', low: 'text-warn' } as const;
	/**
	 * A colour and icon per kind of finding, so the list can be scanned by kind: red for things that are broken, amber for losses,
	 * blue for growth, green for quick fixes, grey for the rest.
	 */
	const FAMILY: Record<string, [string, typeof Zap]> = {
		connection: ['red', ShieldAlert], tracking: ['red', ShieldAlert], blocked: ['red', ShieldAlert], robots: ['red', ShieldAlert], deindexed: ['red', CircleAlert], dead: ['red', CircleAlert], 'not-indexed': ['red', CircleAlert], 'broken-links': ['red', Link], reclaim: ['amber', Link],
		sitewide: ['amber', TrendingDown], anomaly: ['amber', TrendingDown], decay: ['amber', TrendingDown], 'lost-query': ['amber', TrendingDown], update: ['amber', CircleAlert], cannibalization: ['amber', Search],
		striking: ['blue', TrendingUp], rising: ['blue', TrendingUp], 'page-edge': ['blue', TrendingUp], gem: ['blue', Gem], questions: ['blue', Sparkles],
		'ctr-gap': ['green', Zap], onpage: ['green', Wrench], 'internal-link': ['green', Link], lastmod: ['green', Wrench], sitemap: ['green', Wrench]
	};
	const fam = $derived(FAMILY[a.type] ?? ['gray', ListChecks]);
	const FamIcon = $derived(fam[1]);
</script>

<article class="card p-4 {a.blocking ? 'border-[color:var(--bad)]' : ''}">
	<div class="flex flex-wrap items-center gap-2 text-xs">
		{#if rank}<span class="tnum grid size-6 place-items-center rounded-full bg-muted font-semibold">{rank}</span>{/if}
		{#if a.blocking}<Tip text={BLOCKING_EXPLAIN}><span class="chip border-[color:var(--bad)] text-bad">Do first: blocking</span></Tip>{/if}
		<Tip text={TYPE_EXPLAIN[a.type]}><span class="inline-flex items-center gap-1.5 rounded-md py-0.5 pr-2 pl-0.5 text-xs font-medium tone-{fam[0]}" style="background:color-mix(in oklab, var(--tone) 10%, transparent);color:color-mix(in oklab, var(--tone) 85%, var(--foreground))"><span class="ibadge ibadge-sm !size-5 tone-{fam[0]}" aria-hidden="true"><FamIcon class="size-3" /></span>{TYPE_LABEL[a.type]}</span></Tip>
		{#if site}<a class="chip pii" href={siteHref ?? '#'}>{site}</a>{/if}
		{#if a.impact != null}<Tip text={IMPACT_EXPLAIN}><span class="chip font-medium">≈ {Math.round(a.impact).toLocaleString('en-US')} clicks / 28d</span></Tip>{:else}<Tip text={NO_IMPACT_EXPLAIN}><span class="chip">no click estimate</span></Tip>{/if}
		<span class="text-muted-foreground"><Tip text={CONFIDENCE_EXPLAIN[a.confidence]}><span class={conf[a.confidence]}>{a.confidence} confidence</span></Tip> · <Tip text={EFFORT_EXPLAIN[a.effort]}><span>{a.effort} effort</span></Tip></span>
		<div class="ml-auto flex items-center gap-1.5">
			<Tip interactive text={BUTTON_EXPLAIN.open}><a class="btn btn-xs !px-2.5 {a.blocking ? 'btn-primary' : ''}" href={a.href}>Open<ArrowUpRight class="size-3" /></a></Tip>
			{#if !hideControls}
				<form method="POST" action="/sites/{a.siteId}/actions?/state" use:enhance class="flex gap-1.5">
					<input type="hidden" name="key" value={a.key} />
					{#if restore}<Tip interactive text={BUTTON_EXPLAIN.restore}><button class="btn btn-xs !px-2.5" name="state" value="open"><RotateCcw class="size-3" />Restore</button></Tip>
					{:else}<Tip interactive text={BUTTON_EXPLAIN.done}><button class="btn btn-xs !px-2.5" name="state" value="done"><Check class="size-3" />Done</button></Tip><Tip interactive text={BUTTON_EXPLAIN.snooze}><button class="btn btn-ghost btn-xs !px-2 text-muted-foreground" name="state" value="snoozed"><AlarmClock class="size-3" />Snooze</button></Tip>{/if}
				</form>
			{/if}
		</div>
	</div>
	<h2 class="mt-2 font-medium" class:pii={names}>{a.title}</h2>
	{#if sameAs}<p class="mt-1 text-sm text-muted-foreground">What to do: the same as #{sameAs} above.</p>{:else}<p class="mt-1 text-sm" class:pii={names}><b>What to do:</b> {a.how}</p>{/if}
	<details class="mt-1 text-xs text-muted-foreground"><summary class="cursor-pointer select-none">Why{a.evidence.length ? ` and evidence (${a.evidence.length})` : ''}</summary>
		<p class="mt-1 leading-relaxed" class:pii={names}>{a.why}</p>
		{#if a.evidence.length}<ul class="pii mt-1 space-y-0.5">{#each a.evidence as e}<li>· {e}</li>{/each}</ul>{/if}
	</details>
</article>
