/**
 * The Queries text filter, in plain words: contains, doesn't contain, is exactly, matches any of a list, or a regular expression.
 * Every choice becomes the same regular-expression parameters the server already understands (re = include, nre = exclude), so a
 * filter built here is an ordinary link that can be saved as a view or shared.
 */
export const TEXT_OPS = [
	['contains', 'contains'],
	['not', "doesn't contain"],
	['exact', 'is exactly'],
	['any', 'matches any of'],
	['regex', 'matches regex']
] as const;
export type TextOp = (typeof TEXT_OPS)[number][0];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The parameter and pattern for one filter; null when there is nothing to filter on. "any" takes a list split by commas or new lines. */
export function textFilter(op: TextOp, value: string): { key: 're' | 'nre'; pattern: string } | null {
	const v = value.trim();
	if (!v) return null;
	switch (op) {
		case 'contains':
			return { key: 're', pattern: esc(v) };
		case 'not':
			return { key: 'nre', pattern: esc(v) };
		case 'exact':
			return { key: 're', pattern: `^${esc(v)}$` };
		case 'any': {
			const parts = v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
			return parts.length ? { key: 're', pattern: parts.map(esc).join('|') } : null;
		}
		default:
			return { key: 're', pattern: v };
	}
}

/** How a stored pattern reads on its chip: the plain words when it came from one of the simple choices, the pattern itself otherwise. */
export function describePattern(pattern: string, exclude: boolean): string {
	const un = (s: string) => s.replace(/\\(.)/g, '$1');
	const plain = (s: string) => !/(^|[^\\])[.*+?^${}()|[\]]/.test(s);
	if (exclude) return plain(pattern) ? `doesn't contain “${un(pattern)}”` : `excludes /${pattern}/`;
	const exact = /^\^(.*)\$$/.exec(pattern);
	if (exact && plain(exact[1])) return `is “${un(exact[1])}”`;
	if (plain(pattern)) return `contains “${un(pattern)}”`;
	const parts = pattern.split(/(?<!\\)\|/);
	if (parts.length > 1 && parts.every(plain)) return `any of ${parts.map((p) => `“${un(p)}”`).join(', ')}`;
	return `matches /${pattern}/`;
}
