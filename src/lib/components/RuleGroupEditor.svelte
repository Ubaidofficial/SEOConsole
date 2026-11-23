<script lang="ts">
	import { enhance } from '$app/forms';
	import { Plus, X } from '@lucide/svelte';
	import { RULE_KINDS, type RuleSet } from '$lib/rules';

	/** Create or edit a keyword bucket (kind "bucket") or a page group (kind "pages"). Each rule is a kind and a value; the form posts them as pairs. */
	let { kind, group = null, onDone }: { kind: 'bucket' | 'pages'; group?: { id: number; name: string; set: RuleSet } | null; onDone?: () => void } = $props();
	type Row = { kind: string; value: string };
	// a fresh copy of the group's rules: editing them must not change the group shown elsewhere until it is saved
	const start = (): Row[] => (group ? group.set.rules.map((r) => ({ ...r })) : [{ kind: kind === 'pages' ? 'starts' : 'contains', value: '' }]);
	let rows = $state<Row[]>(start());
	const startMatch = (): 'any' | 'all' => group?.set.match ?? 'any';
	let match = $state(startMatch());
	const thing = $derived(kind === 'bucket' ? 'search' : 'page path');
</script>

<form method="POST" action="?/saveGroup" use:enhance={() => async ({ result, update }) => { await update({ reset: false }); if (result.type === 'success') onDone?.(); }} class="card space-y-3 p-4">
	<input type="hidden" name="kind" value={kind} />
	{#if group}<input type="hidden" name="id" value={group.id} />{/if}
	<div class="flex flex-wrap items-end gap-3">
		<label class="text-xs text-muted-foreground">Name<input class="input mt-1 block w-56" name="name" maxlength="80" value={group?.name ?? ''} placeholder={kind === 'bucket' ? 'e.g. Running shoes' : 'e.g. Blog'} required /></label>
		<fieldset class="text-xs text-muted-foreground">
			<legend>A {thing} belongs when it matches</legend>
			<div class="mt-1 flex gap-3 text-sm text-foreground">
				<label class="flex items-center gap-1"><input type="radio" name="match" value="any" bind:group={match} />any rule</label>
				<label class="flex items-center gap-1"><input type="radio" name="match" value="all" bind:group={match} />every rule</label>
			</div>
		</fieldset>
	</div>
	<div class="space-y-2">
		{#each rows as r, i}
			<div class="flex flex-wrap items-start gap-2">
				<select class="input" name="ruleKind" bind:value={r.kind} aria-label="Rule {i + 1}">{#each RULE_KINDS as [k, label]}<option value={k}>{label}</option>{/each}</select>
				{#if r.kind === 'list'}
					<textarea class="input min-w-0 flex-1 basis-64 font-mono text-xs" name="ruleValue" rows="4" bind:value={r.value} placeholder={kind === 'bucket' ? 'running shoes\ntrail running shoes' : '/pricing\n/features'} aria-label="Values, one per line"></textarea>
				{:else}
					<input class="input min-w-0 flex-1 basis-64 {r.kind.includes('regex') ? 'font-mono text-xs' : ''}" name="ruleValue" bind:value={r.value} type={r.kind.startsWith('words') ? 'number' : 'text'} min="1" max="50" placeholder={r.kind.includes('regex') ? (kind === 'bucket' ? 'shoes?|sneakers?' : '^/blog/') : r.kind.startsWith('words') ? '4' : kind === 'pages' ? '/blog/' : 'shoe'} aria-label="Value" />
				{/if}
				<button type="button" class="btn btn-sm text-muted-foreground" onclick={() => (rows = rows.filter((_, j) => j !== i))} disabled={rows.length === 1} aria-label="Remove rule {i + 1}"><X class="size-3.5" /></button>
			</div>
		{/each}
		<button type="button" class="btn btn-sm" onclick={() => (rows = [...rows, { kind: 'contains', value: '' }])} disabled={rows.length >= 20}><Plus class="size-3.5" />Add a rule</button>
	</div>
	<p class="text-xs text-muted-foreground">Matching ignores case. “Does not …” rules always leave a {thing} out. {kind === 'pages' ? 'Rules see the path only (/blog/post), so every host of a Domain property matches.' : 'New searches join as they arrive.'}</p>
	<div class="flex gap-2"><button class="btn btn-primary">{group ? 'Save' : kind === 'bucket' ? 'Create bucket' : 'Create group'}</button>{#if onDone}<button type="button" class="btn" onclick={onDone}>Cancel</button>{/if}</div>
</form>
