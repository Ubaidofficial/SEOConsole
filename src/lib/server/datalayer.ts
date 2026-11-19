/**
 * Which events does a site push to the dataLayer? Read from its own JavaScript (the page and the scripts it loads), so a key event can be
 * set up for an event the site already sends without anyone digging through the code. Two patterns are recognised:
 *  - a literal push: dataLayer.push({event: 'sign_up', plan: …}) (also `w.dataLayer.push`, `t.push({event: …})` after a dataLayer
 *    reference, quoted keys);
 *  - a helper: a function that pushes {event: name, ...params} for a name it is given (6figjobs: `function l(e,t){…dataLayer.push({event:e,...t})}`,
 *    exported by the bundler as `x: () => l`), then called as helper("job_alert_signup", {alert_form: …}) or `(0,_.x)("job_alert_signup", {…})`.
 *    The helper's own name and its exported aliases are found first (in every script read), and only calls of those names count.
 * Parameter names are the object's keys. This reads code, so it can miss events built at run time and can, for the helper pattern,
 * list a call that is not an event; the result says which pattern found each one.
 */
export interface FoundEvent { event: string; params: string[]; how: 'push' | 'helper'; where: string }

const NAME = /^[A-Za-z][A-Za-z0-9_]{1,39}$/;
/** Events Tag Manager or GA4 send by themselves: not something to set up. */
const SKIP = /^(gtm\.|gtag\.|page_view$|user_engagement$|session_start$|first_visit$|scroll$|click$|form_start$|form_submit$|file_download$|video_)/;

/** Top-level keys of an object literal's body ("a:1,b:x?y:z,'c':2" → a, b, c), leaving out `event`. */
function keysOf(body: string): string[] {
	const out: string[] = [];
	let depth = 0, start = 0;
	const parts: string[] = [];
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') depth--;
		else if (ch === ',' && depth === 0) (parts.push(body.slice(start, i)), (start = i + 1));
	}
	parts.push(body.slice(start));
	for (const p of parts) {
		const m = /^\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:/.exec(p);
		if (m && m[1] !== 'event' && NAME.test(m[1])) out.push(m[1]);
	}
	return [...new Set(out)];
}

/** The body of the object literal that starts at `open` (the index of "{"), or null when it does not close within `max` characters. */
function objectAt(code: string, open: number, max = 1500): string | null {
	let depth = 0;
	for (let i = open; i < Math.min(code.length, open + max); i++) {
		if (code[i] === '{') depth++;
		else if (code[i] === '}' && --depth === 0) return code.slice(open + 1, i);
	}
	return null;
}

const ID = '[A-Za-z_$][\\w$]*';
const esc = (s: string) => s.replace(/[$]/g, '\\$');

/**
 * Names under which a dataLayer helper can be called in this code: functions whose body pushes {event: <first argument>, ...<second>},
 * and the names a bundler exports them under (`x: () => l`, `export { l as x }`).
 */
export function helperNames(code: string): { local: string[]; exported: string[] } {
	const local = new Set<string>();
	const fn = new RegExp(`function\\s+(${ID})\\s*\\(\\s*(${ID})\\s*,\\s*(${ID})[^)]*\\)\\s*\\{[\\s\\S]{0,300}?\\.push\\(\\s*\\{\\s*["']?event["']?\\s*:\\s*(${ID})\\s*,\\s*\\.\\.\\.(${ID})`, 'g');
	for (const m of code.matchAll(fn)) if (m[4] === m[2] && m[5] === m[3]) local.add(m[1]);
	const arrow = new RegExp(`(?:const|let|var)\\s+(${ID})\\s*=\\s*\\(\\s*(${ID})\\s*,\\s*(${ID})[^)]*\\)\\s*=>[\\s\\S]{0,300}?\\.push\\(\\s*\\{\\s*["']?event["']?\\s*:\\s*(${ID})\\s*,\\s*\\.\\.\\.(${ID})`, 'g');
	for (const m of code.matchAll(arrow)) if (m[4] === m[2] && m[5] === m[3]) local.add(m[1]);
	const exported = new Set<string>();
	for (const l of local) {
		for (const m of code.matchAll(new RegExp(`(${ID})\\s*:\\s*\\(\\)\\s*=>\\s*${esc(l)}(?![\\w$])`, 'g'))) exported.add(m[1]);
		for (const m of code.matchAll(new RegExp(`(?<![\\w$])${esc(l)}\\s+as\\s+(${ID})`, 'g'))) exported.add(m[1]);
	}
	return { local: [...local], exported: [...exported] };
}

/**
 * Events pushed to the dataLayer in one piece of JavaScript. `where` names the script, for the result. `exportedHelpers` are helper
 * aliases found in the site's other scripts (a bundle often defines the helper in one module and calls it from another).
 */
export function findEvents(code: string, where: string, exportedHelpers: string[] = []): FoundEvent[] {
	const found = new Map<string, FoundEvent>();
	const add = (event: string, params: string[], how: FoundEvent['how']) => {
		if (!NAME.test(event) || SKIP.test(event)) return;
		const cur = found.get(event);
		if (cur) cur.params = [...new Set([...cur.params, ...params])];
		else found.set(event, { event, params, how, where });
	};
	const own = helperNames(code);
	if (!/dataLayer/.test(code) && !exportedHelpers.length) return [];
	// 1. literal pushes: .push({ event: "name", … }) or .push({"event":"name"}).
	for (const m of code.matchAll(/\.push\(\s*\{/g)) {
		const body = objectAt(code, m.index! + m[0].length - 1);
		if (!body) continue;
		const ev = /^\s*["']?event["']?\s*:\s*["'`]([^"'`]+)["'`]/.exec(body) ?? /[,{]\s*["']?event["']?\s*:\s*["'`]([^"'`]+)["'`]/.exec(`{${body}`);
		if (ev) add(ev[1], keysOf(body), 'push');
	}
	// 2. calls of a helper: by its own name here (`l("sign_up", {…})`), or by an exported alias (`(0,_.x)("sign_up", {…})`, `r.x("sign_up", {…})`).
	const callees = [...own.local.map((n) => `(?<![\\w$.])${esc(n)}`), ...[...new Set([...own.exported, ...exportedHelpers])].map((n) => `\\.${esc(n)}\\)?`)];
	if (callees.length) {
		const call = new RegExp(`(?:${callees.join('|')})\\(\\s*["']([A-Za-z][A-Za-z0-9_]{1,39})["']\\s*,\\s*\\{`, 'g');
		for (const m of code.matchAll(call)) {
			const body = objectAt(code, m.index! + m[0].length - 1);
			if (body !== null) add(m[1], keysOf(body), 'helper');
		}
	}
	return [...found.values()];
}

/** The site's own scripts referenced by a page: same host, or relative. */
export function scriptUrls(html: string, pageUrl: string): string[] {
	const base = new URL(pageUrl);
	const out = new Set<string>();
	for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
		try {
			const u = new URL(m[1].replace(/&amp;/g, '&'), base);
			if (u.hostname === base.hostname) out.add(u.toString());
		} catch {
			/* not a URL */
		}
	}
	return [...out];
}

const MAX_SCRIPTS = 40;
const MAX_BYTES = 3_000_000;
const MAX_TOTAL = 30_000_000;

/**
 * Fetch the pages (the home page first), their inline scripts and up to MAX_SCRIPTS of the site's own scripts, one at a time, and list
 * the events found. Sequential and capped on purpose: this must never put load on the site.
 */
export async function discoverEvents(pages: string[], o: { fetchImpl?: typeof fetch } = {}): Promise<{ events: FoundEvent[]; scripts: number; pages: number; errors: string[] }> {
	const f = o.fetchImpl ?? fetch;
	const get = async (url: string) => {
		const res = await f(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; SEOConsole event discovery)' }, signal: AbortSignal.timeout(20_000) });
		if (!res.ok) throw new Error(`${res.status}`);
		const text = await res.text();
		return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
	};
	const errors: string[] = [];
	const seen = new Set<string>();
	const all = new Map<string, FoundEvent>();
	const merge = (list: FoundEvent[]) => {
		for (const e of list) {
			const cur = all.get(e.event);
			if (!cur) all.set(e.event, { ...e });
			else {
				cur.params = [...new Set([...cur.params, ...e.params])];
				if (e.how === 'push') cur.how = 'push';
			}
		}
	};
	let pagesRead = 0;
	// Read everything first: a helper defined in one script is often called from another, so its aliases must be known before scanning.
	const texts: { code: string; where: string }[] = [];
	let total = 0;
	for (const page of pages.slice(0, 3)) {
		let html: string;
		try {
			html = await get(page);
			pagesRead++;
		} catch (e) {
			errors.push(`${page}: ${e instanceof Error ? e.message : e}`);
			continue;
		}
		texts.push({ code: html, where: page });
		for (const src of scriptUrls(html, page)) {
			if (seen.size >= MAX_SCRIPTS || seen.has(src) || total > MAX_TOTAL) continue;
			seen.add(src);
			try {
				const code = await get(src);
				total += code.length;
				texts.push({ code, where: new URL(src).pathname });
			} catch (e) {
				errors.push(`${src}: ${e instanceof Error ? e.message : e}`);
			}
		}
	}
	const aliases = [...new Set(texts.flatMap((t) => helperNames(t.code).exported))];
	for (const t of texts) merge(findEvents(t.code, t.where, aliases));
	return { events: [...all.values()].sort((a, b) => (a.how === b.how ? a.event.localeCompare(b.event) : a.how === 'push' ? -1 : 1)), scripts: seen.size, pages: pagesRead, errors: errors.slice(0, 10) };
}
