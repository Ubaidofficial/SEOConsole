/**
 * "Is it live?": read the container script Google serves to visitors (https://www.googletagmanager.com/gtm.js?id=GTM-…) and look for what a
 * change should have put there (an event name, a measurement ID). This is what the site's visitors actually load, so it confirms a publish
 * independently of the Tag Manager API. Google can take a minute to serve a new version, so "not yet" is reported as such, not as a failure.
 */
export type LiveCheck = { state: 'confirmed' | 'not-yet' | 'unknown'; found: string[]; missing: string[]; note: string };

export async function checkLiveScript(publicId: string, needles: string[], o: { fetchImpl?: typeof fetch; demo?: boolean } = {}): Promise<LiveCheck> {
	const want = [...new Set(needles.filter(Boolean))];
	if (o.demo) return { state: 'confirmed', found: want, missing: [], note: 'Demo container: nothing is served, so this is simulated.' };
	if (!/^GTM-[A-Z0-9]+$/i.test(publicId)) return { state: 'unknown', found: [], missing: want, note: `Not a web container ID (${publicId}).` };
	let body = '';
	try {
		const res = await (o.fetchImpl ?? fetch)(`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(publicId)}`, { signal: AbortSignal.timeout(15_000) });
		if (!res.ok) return { state: 'unknown', found: [], missing: want, note: `Google answered ${res.status} for the container script.` };
		body = await res.text();
	} catch {
		return { state: 'unknown', found: [], missing: want, note: 'The container script could not be fetched.' };
	}
	const found = want.filter((n) => body.includes(n));
	const missing = want.filter((n) => !found.includes(n));
	return missing.length
		? { state: 'not-yet', found, missing, note: `The live container script does not show ${missing.join(', ')} yet. Google can take a minute or two to serve a new version: check again shortly.` }
		: { state: 'confirmed', found, missing, note: `The live container script ${publicId} now includes ${found.join(', ')}.` };
}
