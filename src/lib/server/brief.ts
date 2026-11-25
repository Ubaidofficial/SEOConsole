/**
 * Content brief: what to write (or rewrite) for one search, from data the app already holds. No credits, no live calls.
 *
 * - The verdict: optimise the page that already ranks for it (top 20 with real impressions), consolidate when several of the
 *   site's pages split it, or create a new page when none does. A page passed in is a rework of that page.
 * - What to cover: the site's other searches that share the target's main words (from Search Console, last 90 days), the
 *   question-shaped ones as an FAQ, and an outline built from them. Word overlap, not meaning: it reads what people searched.
 * - Where to link from: crawled pages of the site whose text mentions the search and that do not link to the page yet.
 * - Volume and difficulty when OpenSEO has measured the search. The page's current title and H1 when the on-page check read it.
 *
 * Search queries and page text are third-party content: shown as data, never followed.
 */
import { db } from './db';
import { addDays } from './dates';
import { siteEnd } from './queries';
import { isBranded, normalizeUrl } from '../analytics';
import { isQuestionQuery } from '../trends';
import type { SiteRow } from './clients';
import { brandTerms } from './queries';

const STOP = new Set('a an and are as at be best by can do does for from free get has have how i in is it its me my near no not of on online or our so than that the this to top vs was what when where which who why will with you your'.split(' '));
export const mainWords = (q: string) => [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/s$/, '')))];

/**
 * The target's distinctive words: not a year, and not in more than 5% of the site's searches (when there are 40 or more), so a
 * word that describes the whole site ("book", "job") or a date does not make two searches about the same thing.
 */
export function topicWords(words: string[], queries: string[]): string[] {
	const counts = new Map<string, number>();
	for (const q of queries) for (const w of new Set(mainWords(q))) counts.set(w, (counts.get(w) ?? 0) + 1);
	const common = (w: string) => queries.length >= 40 && (counts.get(w) ?? 0) / queries.length > 0.05;
	return words.filter((w) => !/^\d{4}$/.test(w) && !common(w));
}

export interface BriefQuery { query: string; clicks: number; impressions: number; position: number; question: boolean }
export interface ContentBrief {
	query: string;
	window: { start: string; end: string };
	stats: { clicks: number; impressions: number; position: number | null; ctr: number | null };
	volume: { searchesPerMonth: number | null; difficulty: number | null } | null;
	verdict: 'create' | 'optimize' | 'consolidate' | 'rework';
	why: string;
	targetPage: string | null;
	pagesRanking: { page: string; clicks: number; impressions: number; position: number }[];
	current: { title: string | null; h1: string | null } | null;
	related: BriefQuery[];
	questions: BriefQuery[];
	outline: { h1: string; sections: string[]; faq: string[] };
	linkFrom: { page: string; sentence: string }[];
	branded: boolean;
	notes: string[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function contentBrief(site: Pick<SiteRow, 'id' | 'synced_through' | 'site_url' | 'brand_terms'>, rawQuery: string, opts: { page?: string } = {}): ContentBrief {
	const query = rawQuery.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
	if (!query) throw new Error('Name the search to write a brief for.');
	const d = db();
	const end = siteEnd(site);
	const start = addDays(end, -89);
	const W = 'SUM(position * impressions) / NULLIF(SUM(impressions), 0)';
	const tot = d.prepare(`SELECT SUM(clicks) c, SUM(impressions) i, ${W} p FROM sa_rows WHERE site_id = ? AND query = ? AND date BETWEEN ? AND ?`).get(site.id, query, start, end) as { c: number | null; i: number | null; p: number | null };
	const pages = (d.prepare(`SELECT page, SUM(clicks) clicks, SUM(impressions) impressions, ${W} position FROM sa_rows WHERE site_id = ? AND query = ? AND date BETWEEN ? AND ? GROUP BY page ORDER BY impressions DESC LIMIT 10`).all(site.id, query, start, end) as { page: string; clicks: number; impressions: number; position: number }[]).map((p) => ({ ...p, position: r1(p.position) }));
	const impressions = tot.i ?? 0;

	// The verdict.
	let verdict: ContentBrief['verdict'];
	let targetPage: string | null = null;
	let why: string;
	const ranking = pages.filter((p) => p.position <= 20 && p.impressions >= 10);
	const splitting = pages.filter((p) => impressions > 0 && p.impressions / impressions >= 0.2);
	if (opts.page) {
		verdict = 'rework';
		targetPage = opts.page;
		why = 'You asked for a rework of this page.';
	} else if (splitting.length >= 2 && ranking.length >= 1) {
		verdict = 'consolidate';
		targetPage = ranking[0].page;
		why = `${splitting.length} of your pages split this search's impressions. Make ${pathOf(targetPage)} the one page for it: fold the others into it or point them at it, then optimise it.`;
	} else if (ranking.length) {
		verdict = 'optimize';
		targetPage = ranking[0].page;
		why = `${pathOf(targetPage)} already ranks around position ${ranking[0].position} for it. Improving that page is faster than starting a new one.`;
	} else {
		verdict = 'create';
		why = pages.length ? `Your pages appear for it only beyond position 20 or rarely (${pages[0].impressions} impressions at best), so a page made for it has room.` : 'None of your pages has been shown for it in 90 days, so it needs a page of its own.';
	}

	// What to cover: the site's searches that share the target's main words.
	const words = mainWords(query);
	const rows = d.prepare(`SELECT query, SUM(clicks) clicks, SUM(impressions) impressions, ${W} position FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY query HAVING SUM(impressions) >= 3 ORDER BY impressions DESC LIMIT 20000`).all(site.id, start, end) as { query: string; clicks: number; impressions: number; position: number }[];
	// Words that say what the site is (on a book site "book" is in most searches) or when (years) are not the topic: a search
	// shares the topic only through its distinctive words ("sailing" in "sailing books 2024").
	const topic = topicWords(words, rows.map((r) => r.query));
	const need = topic.length ? Math.min(2, topic.length) : Math.min(2, words.length);
	const matchWords = topic.length ? topic : words;
	const target = targetPage ? normalizeUrl(targetPage) : null;
	const onPage = target
		? new Set((d.prepare('SELECT query, page FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY query, page').all(site.id, start, end) as { query: string; page: string }[]).filter((r) => normalizeUrl(r.page) === target).map((r) => r.query))
		: new Set<string>();
	const related: BriefQuery[] = [];
	for (const r of rows) {
		if (r.query === query || /\b(site|inurl|intitle|after|before):/.test(r.query)) continue;
		const w = mainWords(r.query);
		const shared = matchWords.filter((x) => w.includes(x)).length;
		if ((need && shared >= need) || r.query.includes(query) || onPage.has(r.query)) related.push({ query: r.query, clicks: r.clicks, impressions: r.impressions, position: r1(r.position), question: isQuestionQuery(r.query) });
		if (related.length >= 60) break;
	}
	const questions = related.filter((r) => r.question).slice(0, 8);
	const others = related.filter((r) => !r.question);

	// Outline: one section per distinct angle (a search whose words add something the target and earlier sections do not have).
	const seen = new Set(words);
	const sections: string[] = [];
	for (const r of others) {
		const extra = mainWords(r.query).filter((w) => !seen.has(w));
		if (!extra.length) continue;
		extra.forEach((w) => seen.add(w));
		sections.push(cap(r.query));
		if (sections.length >= 6) break;
	}

	// Where to link from: crawled pages mentioning the search that do not already link to the target.
	const linkFrom: ContentBrief['linkFrom'] = [];
	const phrase = new RegExp(`\\b${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+')}s?\\b`, 'i');
	for (const p of d.prepare('SELECT url, final_url, body, links FROM link_pages WHERE site_id = ? AND status < 400').all(site.id) as { url: string; final_url: string; body: string; links: string }[]) {
		if (target && normalizeUrl(p.final_url) === target) continue;
		let links: { href?: string; url?: string }[] = [];
		try {
			links = JSON.parse(p.links);
		} catch {
			/* a broken row contributes nothing */
		}
		if (target && links.some((l) => normalizeUrl(String(l.href ?? l.url ?? '')) === target)) continue;
		const sentence = p.body.split('\n').find((line) => phrase.test(line));
		if (sentence) linkFrom.push({ page: p.url, sentence: sentence.length > 240 ? sentence.slice(0, 237) + '…' : sentence });
		if (linkFrom.length >= 8) break;
	}

	const vol = d.prepare('SELECT volume, kd FROM oseo_volumes WHERE site_id = ? AND keyword = ?').get(site.id, query) as { volume: number | null; kd: number | null } | undefined;
	let current: ContentBrief['current'] = null;
	if (target) {
		const lp = (d.prepare('SELECT final_url, title, h1 FROM link_pages WHERE site_id = ?').all(site.id) as { final_url: string; title: string | null; h1: string | null }[]).find((r) => normalizeUrl(r.final_url) === target);
		if (lp) current = { title: lp.title, h1: lp.h1 };
	}
	const branded = isBranded(query, brandTerms(site as SiteRow));
	const notes: string[] = [];
	if (branded) notes.push('This is a brand search: people already look for you, so the page to win it is usually your home or about page.');
	if (!rows.length) notes.push('No Search Console rows in the last 90 days: the brief can only give the verdict.');
	if (!d.prepare('SELECT 1 FROM link_pages WHERE site_id = ? LIMIT 1').get(site.id)) notes.push('The internal-link crawl has not run for this site yet, so no pages to link from are suggested.');
	if (!vol) notes.push('No search volume stored for it. OpenSEO can measure it (Queries tab, Show search volume; it spends credits).');
	notes.push('For what the competing pages look like, run Research, Results pages (OpenSEO credits) or check the results page yourself.');

	return {
		query,
		window: { start, end },
		stats: { clicks: tot.c ?? 0, impressions, position: tot.p == null ? null : r1(tot.p), ctr: impressions ? Math.round(((tot.c ?? 0) / impressions) * 1000) / 1000 : null },
		volume: vol ? { searchesPerMonth: vol.volume, difficulty: vol.kd } : null,
		verdict,
		why,
		targetPage,
		pagesRanking: pages,
		current,
		related: related.slice(0, 20),
		questions,
		outline: { h1: cap(query), sections, faq: questions.slice(0, 6).map((q) => cap(q.query.replace(/\?*$/, '?'))) },
		linkFrom,
		branded,
		notes
	};
}

function pathOf(u: string): string {
	try {
		return new URL(u).pathname || '/';
	} catch {
		return u;
	}
}
