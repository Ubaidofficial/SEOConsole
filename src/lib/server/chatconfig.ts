/**
 * Which model providers the Ask chat offers, from the environment.
 *
 * Opt in, never by surprise: an installation that already has OPENAI_API_KEY for AI answers does not get OpenAI in the chat (and its data
 * sent there) just because the key exists. The chat offers the provider named by CHAT_PROVIDER (default `anthropic`) and the ones listed in
 * CHAT_PROVIDERS, each only when its own key is set (see chatproviders.ts for the variable names).
 *
 *   CHAT_PROVIDER=deepseek            the provider answers by default, with DEEPSEEK_API_KEY (or CHAT_API_KEY)
 *   CHAT_PROVIDERS=anthropic,gemini   more providers people can pick in the chat, each with its own key
 *   CHAT_MODEL / CHAT_MODEL_GEMINI    the model for the default provider / for one provider (else the page lists the provider's models)
 *   CHAT_LOCK_MODEL=1                 no picking: everyone gets the default provider and its model
 *   CHAT_PROVIDER=custom + CHAT_BASE_URL (+ CHAT_API_KEY)   any other OpenAI-compatible server
 *
 * `openai` together with CHAT_BASE_URL is read as `custom`, which is how the setting was first written.
 */
import { env } from './config';
import { CHAT_PROVIDER_IDS, providerById, validModelName, type ChatProviderChoice, type ChatProviderDef } from '../chatproviders';

export interface ResolvedProvider {
	id: string;
	label: string;
	protocol: 'anthropic' | 'openai';
	baseUrl: string;
	apiKey: string;
	/** The variable the key came from (or would come from), for messages. */
	keyName: string;
	/** The model set in the environment; '' when none. */
	model: string;
	/** The address people see on the privacy page. */
	host: string;
}

const norm = (s: string) => s.trim().toLowerCase();
const modelEnv = (id: string) => `CHAT_MODEL_${id.toUpperCase()}`;

/** A provider name as written in the environment, to one of our ids; null when it is none of them. */
export function aliasId(raw: string): string | null {
	const r = norm(raw);
	if (r === 'openai-compatible') return 'custom';
	if (r === 'openai' && env('CHAT_BASE_URL').trim() !== '') return 'custom';
	if (r === 'moonshot') return 'kimi';
	if (r === 'google') return 'gemini';
	return CHAT_PROVIDER_IDS.includes(r) ? r : null;
}

/** The default provider's id; null when CHAT_PROVIDER names none we know (chat then stays off and says so). */
export function defaultProviderId(): string | null {
	const raw = norm(env('CHAT_PROVIDER'));
	return raw === '' ? 'anthropic' : aliasId(raw);
}

const validBaseUrl = (u: string) => {
	try {
		const p = new URL(u).protocol;
		return p === 'https:' || p === 'http:';
	} catch {
		return false;
	}
};
const hostOf = (u: string) => {
	try {
		return new URL(u).host;
	} catch {
		return u;
	}
};

function resolve(def: ChatProviderDef, isDefault: boolean): ResolvedProvider | null {
	let keyName = def.keyEnv.find((k) => env(k).trim() !== '') ?? def.keyEnv[0];
	let apiKey = env(keyName).trim();
	if (!apiKey && isDefault && def.id !== 'anthropic') {
		const k = env('CHAT_API_KEY').trim();
		if (k) {
			apiKey = k;
			keyName = 'CHAT_API_KEY';
		}
	}
	const model = env(modelEnv(def.id)).trim() || (isDefault ? env('CHAT_MODEL').trim() : '') || def.defaultModel || '';
	if (def.id === 'custom') {
		const baseUrl = env('CHAT_BASE_URL').trim();
		if (!validBaseUrl(baseUrl)) return null;
		// A local server may need no key, so a custom address is enough.
		return { id: def.id, label: `Custom (${hostOf(baseUrl)})`, protocol: 'openai', baseUrl, apiKey, keyName: 'CHAT_API_KEY', model, host: hostOf(baseUrl) };
	}
	if (!apiKey) return null;
	return { id: def.id, label: def.label, protocol: def.protocol, baseUrl: def.baseUrl!, apiKey, keyName, model, host: hostOf(def.baseUrl!) };
}

/** The ids the operator switched on: the default first, then CHAT_PROVIDERS, without repeats. Names we do not know are ignored. */
function switchedOn(): string[] {
	const out: string[] = [];
	const d = defaultProviderId();
	if (d) out.push(d);
	for (const raw of env('CHAT_PROVIDERS').split(/[\s,;]+/)) {
		const id = raw ? aliasId(raw) : null;
		if (id && !out.includes(id)) out.push(id);
	}
	return out;
}

/** The providers people can use now: switched on and holding a key (or, for a custom server, an address). */
export function offeredProviders(): ResolvedProvider[] {
	const d = defaultProviderId();
	const out: ResolvedProvider[] = [];
	for (const id of switchedOn()) {
		const def = providerById(id);
		const r = def ? resolve(def, id === d) : null;
		if (r) out.push(r);
	}
	return out;
}

/** Why chat is off, in words for the person who runs the server; null when it is ready. */
export function chatSetupProblem(): string | null {
	const d = defaultProviderId();
	if (d === null) return `CHAT_PROVIDER is "${env('CHAT_PROVIDER').trim().slice(0, 40)}": use one of ${CHAT_PROVIDER_IDS.join(', ')}, then restart.`;
	if (offeredProviders().length > 0) return null;
	const def = providerById(d)!;
	if (d === 'custom') return 'CHAT_PROVIDER=custom needs CHAT_BASE_URL, a valid http(s) address such as https://api.example.com/v1, then restart.';
	if (d === 'anthropic') return 'Chat needs an API key. For Claude add ANTHROPIC_API_KEY; for another provider set CHAT_PROVIDER (' + CHAT_PROVIDER_IDS.filter((x) => x !== 'anthropic').join(', ') + ') and its key, for example DEEPSEEK_API_KEY. Then restart.';
	return `${def.label} needs its API key: set ${def.keyEnv[0]} (or CHAT_API_KEY), then restart.`;
}
export const chatReady = () => chatSetupProblem() === null;

/** The default provider's model, for the page's footer and as the request's default; '' when none is set. */
export const chatModel = () => offeredProviders()[0]?.model ?? '';

/** Most providers cap one answer well below Claude's limit (8,192 tokens is common), and some refuse a request that asks for more. */
export const chatMaxTokens = () => {
	const n = Number(env('CHAT_MAX_TOKENS', '8192'));
	return Number.isFinite(n) && n >= 256 ? Math.floor(n) : 8192;
};

/** CHAT_LOCK_MODEL=1: nobody picks a provider or model; the default is used for everyone (a cost control). */
export const chatLocked = () => env('CHAT_LOCK_MODEL') === '1';

/** What the page needs to build its menus. */
export const providerChoices = (): ChatProviderChoice[] => offeredProviders().map((p) => ({ id: p.id, label: p.label, model: p.model, host: p.host }));

/**
 * The provider and model one turn uses: what the person picked, if that provider is switched on here and the name is plausible,
 * otherwise (or when picking is locked) the default. Returns the reason in words when it cannot be done.
 */
export function chooseProvider(requestedProvider?: unknown, requestedModel?: unknown): { provider: ResolvedProvider; model: string } | { error: string } {
	const offered = offeredProviders();
	if (!offered.length) return { error: chatSetupProblem() ?? 'Chat is not set up.' };
	const locked = chatLocked();
	let provider = offered[0];
	const rp = !locked && typeof requestedProvider === 'string' ? requestedProvider.trim() : '';
	if (rp) {
		const id = aliasId(rp);
		const hit = id ? offered.find((p) => p.id === id) : undefined;
		if (!hit) return { error: `${rp.slice(0, 40)} is not switched on for this chat. Pick another provider.` };
		provider = hit;
	}
	const rm = !locked && typeof requestedModel === 'string' ? requestedModel.trim() : '';
	if (rm && !validModelName(rm)) return { error: 'That model name is not valid.' };
	const model = rm || provider.model;
	if (!model) return { error: `Choose a model for ${provider.label}: pick one in the model menu, or set ${modelEnv(provider.id)} (CHAT_MODEL when it is the default provider) and restart.` };
	return { provider, model };
}
