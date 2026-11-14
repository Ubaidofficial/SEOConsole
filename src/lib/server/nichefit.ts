import type { SiteRow } from './clients';
import { brandTerms, periodFor, topQueries } from './queries';
import { isBranded } from '../analytics';
import { nicheProfile, scoreKeywords, type KeywordFit, type NicheProfile } from '../nichefit';

/** The niche profile of a site from its stored Search Console queries (brand searches left out). Reads only; nothing is fetched. */
export function nicheFor(site: SiteRow, days = 90, candidates: string[] = []): { profile: NicheProfile; period: { start: string; end: string; days: number }; candidates: KeywordFit[] } {
	const p = periodFor(site, days);
	const terms = brandTerms(site);
	const rows = topQueries(site.id, p.start, p.end, {}, 50_000).filter((r) => !isBranded(r.query, terms) && r.impressions >= 3);
	const profile = nicheProfile(rows, terms);
	return { profile, period: { start: p.start, end: p.end, days }, candidates: candidates.length ? scoreKeywords(profile, candidates) : [] };
}
