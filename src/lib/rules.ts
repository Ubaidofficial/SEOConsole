import { COMMERCIAL, INFORMATIONAL, TRANSACTIONAL, isQuestionQuery, safeRegex } from './trends';

/**
 * Rules that sort searches into keyword buckets and pages into page groups. One rule engine for both, so a bucket and a page group
 * read the same way: a list of rules, and whether a value must match any of them or all of them. Exclusion rules ("does not contain",
 * "does not match") always apply on top: a value that hits one is left out whatever the other rules say.
 *
 * Pure (no database), so the same code runs on the server, in tests and when the editor previews a rule.
 */
export const RULE_KINDS = [
	['contains', 'Contains'],
	['not_contains', 'Does not contain'],
	['starts', 'Starts with'],
	['ends', 'Ends with'],
	['exact', 'Is exactly'],
	['list', 'Is one of (one per line)'],
	['regex', 'Matches regex'],
	['not_regex', 'Does not match regex'],
	['words_min', 'Has at least N words'],
	['words_max', 'Has at most N words']
] as const;
export type RuleKind = (typeof RULE_KINDS)[number][0];
export const RULE_KIND_LABEL: Record<RuleKind, string> = Object.fromEntries(RULE_KINDS) as Record<RuleKind, string>;
const EXCLUDE: RuleKind[] = ['not_contains', 'not_regex'];

export interface Rule { kind: RuleKind; value: string }
export interface RuleSet { match: 'any' | 'all'; rules: Rule[] }

export const MAX_RULES = 20;
export const MAX_LIST_LINES = 2000;
export const MAX_RULE_VALUE = 20_000;

const isKind = (k: unknown): k is RuleKind => typeof k === 'string' && RULE_KINDS.some(([x]) => x === k);

/** A rule set as stored or as posted, checked: unknown kinds and empty values dropped, regexes run through the same safe grammar as every other filter. */
export function parseRuleSet(raw: unknown): { set: RuleSet } | { error: string } {
	let o: unknown = raw;
	if (typeof raw === 'string') {
		try {
			o = JSON.parse(raw);
		} catch {
			return { error: 'The rules could not be read.' };
		}
	}
	const obj = (o ?? {}) as { match?: unknown; rules?: unknown };
	const match = obj.match === 'all' ? 'all' : 'any';
	const list = Array.isArray(obj.rules) ? obj.rules : [];
	const rules: Rule[] = [];
	for (const r of list) {
		const kind = (r as Rule)?.kind;
		const value = String((r as Rule)?.value ?? '').trim();
		if (!isKind(kind) || !value) continue;
		if (value.length > MAX_RULE_VALUE) return { error: 'A rule is too long.' };
		if (kind === 'regex' || kind === 'not_regex') {
			const s = safeRegex(value);
			if ('error' in s) return { error: `${RULE_KIND_LABEL[kind]} “${value.slice(0, 40)}”: ${s.error}` };
		}
		if ((kind === 'words_min' || kind === 'words_max') && !(Number(value) >= 1 && Number(value) <= 50)) return { error: `${RULE_KIND_LABEL[kind]} needs a number from 1 to 50.` };
		if (kind === 'list' && value.split('\n').length > MAX_LIST_LINES) return { error: `A list can hold up to ${MAX_LIST_LINES} lines.` };
		rules.push({ kind, value });
	}
	if (!rules.length) return { error: 'Add at least one rule.' };
	if (rules.length > MAX_RULES) return { error: `Up to ${MAX_RULES} rules.` };
	return { set: { match, rules } };
}

/** A compiled rule set: a function from a value (a search, or a page path) to whether it belongs. */
export function compileRuleSet(set: RuleSet): (value: string) => boolean {
	const tests = set.rules.map((r) => ({ exclude: EXCLUDE.includes(r.kind), test: compileRule(r) }));
	const excl = tests.filter((t) => t.exclude);
	const incl = tests.filter((t) => !t.exclude);
	return (raw: string) => {
		const v = raw.toLowerCase();
		// an exclusion rule is written as "does not …": it passes when the value does not match, so a failing one rules the value out
		if (excl.some((t) => !t.test(v))) return false;
		if (!incl.length) return true;
		return set.match === 'all' ? incl.every((t) => t.test(v)) : incl.some((t) => t.test(v));
	};
}

const words = (v: string) => v.split(/\s+/).filter(Boolean).length;

function compileRule(r: Rule): (v: string) => boolean {
	const val = r.value.toLowerCase();
	switch (r.kind) {
		case 'contains': return (v) => v.includes(val);
		case 'not_contains': return (v) => !v.includes(val);
		case 'starts': return (v) => v.startsWith(val);
		case 'ends': return (v) => v.endsWith(val);
		case 'exact': return (v) => v === val;
		case 'list': {
			const set = new Set(val.split('\n').map((x) => x.trim()).filter(Boolean));
			return (v) => set.has(v.trim());
		}
		case 'regex':
		case 'not_regex': {
			const s = safeRegex(r.value);
			const re = 're' in s ? s.re : null;
			// matched on at most 500 characters, as the database's REGEXP does
			return r.kind === 'regex' ? (v) => !!re && re.test(v.slice(0, 500)) : (v) => !re || !re.test(v.slice(0, 500));
		}
		case 'words_min': return (v) => words(v) >= Number(r.value);
		case 'words_max': return (v) => words(v) <= Number(r.value);
	}
}

/** A page URL as page groups see it: the path (and query string), lower-cased, so "/blog/" rules work for every host of a Domain property. */
export function pagePath(url: string): string {
	try {
		const u = new URL(url);
		return (u.pathname || '/') + u.search;
	} catch {
		return url;
	}
}

/** A one-line, human summary of a rule set, for tables and alert messages. */
export function describeRuleSet(set: RuleSet): string {
	const parts = set.rules.map((r) => {
		const v = r.kind === 'list' ? `${r.value.split('\n').filter((x) => x.trim()).length} entries` : `“${r.value.length > 30 ? r.value.slice(0, 30) + '…' : r.value}”`;
		return `${RULE_KIND_LABEL[r.kind].toLowerCase().replace(' (one per line)', '').replace(' n ', ' ')} ${v}`;
	});
	return parts.join(set.match === 'all' ? ' and ' : ' or ');
}

// ── Quick filters ────────────────────────────────────────────────────────────
/**
 * One-click filters on the Queries tab. Each is a plain wording rule (English), the same kind of heuristic as the intent labels: it
 * says which searches look like that, not what the searcher meant.
 */
const COMPARE = /\b(vs\.?|versus|or|compare|comparison|alternative|alternatives|better than|difference between)\b/i;
const NEAR = /\b(near me|nearby|near by|close to me|open now|in my area)\b/i;
const LOCAL = /\b(near me|nearby|in [a-z]+ (city|town)|local)\b/i;
const YEAR = /\b(19|20)\d{2}\b/;
const PROBLEM = /\b(not working|error|fix|problem|issue|broken|won'?t|can'?t|doesn'?t|failed|troubleshoot)\b/i;
const PRICE = /\b(price|prices|pricing|cost|costs|how much|cheap|cheapest|fee|fees|free)\b/i;

export const QUICK_FILTERS = [
	{ key: 'questions', label: 'Questions', hint: 'How, what, why, can… or containing a question mark', test: (q: string) => isQuestionQuery(q) },
	{ key: 'longtail', label: 'Long tail', hint: 'Four words or more', test: (q: string) => words(q) >= 4 },
	{ key: 'short', label: 'Short head', hint: 'One or two words', test: (q: string) => words(q) <= 2 },
	{ key: 'compare', label: 'Comparisons', hint: 'vs, versus, or, alternative, compare, better than', test: (q: string) => COMPARE.test(q) },
	{ key: 'buying', label: 'Buying intent', hint: 'buy, price, deal, discount, shop, order, booking and similar words', test: (q: string) => TRANSACTIONAL.test(q) },
	{ key: 'research', label: 'Researching', hint: 'best, top, review, compare, alternatives and similar words', test: (q: string) => COMMERCIAL.test(q) },
	{ key: 'learning', label: 'Learning', hint: 'guide, tutorial, how to, what is, examples, tips and similar words', test: (q: string) => INFORMATIONAL.test(q) || isQuestionQuery(q) },
	{ key: 'price', label: 'Price', hint: 'price, cost, how much, cheap, free, fees', test: (q: string) => PRICE.test(q) },
	{ key: 'nearme', label: 'Near me', hint: 'near me, nearby, open now, in my area', test: (q: string) => NEAR.test(q) },
	{ key: 'local', label: 'Local', hint: 'near me, nearby or “local”', test: (q: string) => LOCAL.test(q) },
	{ key: 'problem', label: 'Problems', hint: 'not working, error, fix, problem, broken, can’t', test: (q: string) => PROBLEM.test(q) },
	{ key: 'year', label: 'With a year', hint: 'Contains a year, such as 2026', test: (q: string) => YEAR.test(q) },
	{ key: 'new', label: 'New this period', hint: 'Searches with impressions now but none in the previous period of the same length', test: null }
] as const;
export type QuickFilterKey = (typeof QUICK_FILTERS)[number]['key'];
export const quickFilter = (key: string | null | undefined) => QUICK_FILTERS.find((f) => f.key === key) ?? null;
