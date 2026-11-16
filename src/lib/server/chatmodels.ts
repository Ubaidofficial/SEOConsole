/**
 * The models a provider says it offers, for the chat's model menu. Asked of the provider itself (GET /models, which the OpenAI protocol
 * and Anthropic both have) rather than kept in a list here, because model names change faster than this code. Cached for ten minutes
 * per provider and key; a provider that will not answer just gives an empty list and the person types nothing: the model set in the
 * environment still works.
 */
import type { ResolvedProvider } from './chatconfig';

const TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 8_000;
const MAX_MODELS = 300;
/** Ids that are plainly not for chatting: embeddings, speech, image, moderation and reranking models. */
const NOT_CHAT = /embed|whisper|tts|speech|transcri|dall-e|image|imagen|moderation|rerank|audio|realtime|video/i;

const cache = new Map<string, { at: number; models: string[] }>();
export const clearModelCache = () => cache.clear();

export async function listModels(p: ResolvedProvider, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<string[]> {
	const key = `${p.id}|${p.baseUrl}|${p.apiKey.slice(-6)}`;
	const hit = cache.get(key);
	if (hit && now - hit.at < TTL_MS) return hit.models;
	let models: string[] = [];
	try {
		const base = p.baseUrl.replace(/\/+$/, '');
		const anthropic = p.protocol === 'anthropic';
		const headers: Record<string, string> = anthropic
			? { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' }
			: { ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}) };
		const r = await fetchImpl(anthropic ? `${base}/v1/models?limit=1000` : `${base}/models`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (r.ok) {
			const j = (await r.json()) as { data?: { id?: unknown }[]; models?: { id?: unknown; name?: unknown }[] };
			const rows = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
			models = rows
				.map((m) => String((m as { id?: unknown; name?: unknown }).id ?? (m as { name?: unknown }).name ?? '').replace(/^models\//, ''))
				.filter((id) => id && !NOT_CHAT.test(id))
				.sort()
				.slice(0, MAX_MODELS);
		}
	} catch {
		/* the provider did not answer: no list */
	}
	// An empty list is not kept for ten minutes, so a provider that was briefly down is asked again soon.
	if (models.length) cache.set(key, { at: now, models });
	return models;
}
