/**
 * The model providers the Ask chat knows by name. Pure data, shared by the server (which reads the keys) and the page (which lists the
 * ones this installation has switched on). Anything not listed works as `custom`: any server that speaks the OpenAI chat-completions
 * protocol, at the address in CHAT_BASE_URL.
 *
 * The addresses below are the ones each provider documents for its OpenAI-compatible API, written from memory of those pages and not
 * checked against them today: if one has moved, set CHAT_PROVIDER=custom with CHAT_BASE_URL instead. No model names are built in
 * (except Claude's default), because they change faster than this file: the page asks the provider for its list.
 */
export interface ChatProviderDef {
	id: string;
	label: string;
	/** `anthropic` is Claude through its own SDK; `openai` is the OpenAI chat-completions protocol. */
	protocol: 'anthropic' | 'openai';
	/** Null for `custom`, whose address is CHAT_BASE_URL. */
	baseUrl: string | null;
	/** Environment variables that hold this provider's key, first one set wins. */
	keyEnv: string[];
	defaultModel?: string;
}

export const CHAT_PROVIDERS: ChatProviderDef[] = [
	{ id: 'anthropic', label: 'Claude (Anthropic)', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', keyEnv: ['ANTHROPIC_API_KEY'], defaultModel: 'claude-opus-5-5' },
	{ id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', keyEnv: ['OPENAI_API_KEY'] },
	{ id: 'gemini', label: 'Gemini (Google)', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: ['GEMINI_API_KEY'] },
	{ id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', keyEnv: ['DEEPSEEK_API_KEY'] },
	{ id: 'kimi', label: 'Kimi (Moonshot)', protocol: 'openai', baseUrl: 'https://api.moonshot.ai/v1', keyEnv: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'] },
	{ id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: ['OPENROUTER_API_KEY'] },
	{ id: 'groq', label: 'Groq', protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: ['GROQ_API_KEY'] },
	{ id: 'mistral', label: 'Mistral', protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1', keyEnv: ['MISTRAL_API_KEY'] },
	{ id: 'xai', label: 'xAI (Grok)', protocol: 'openai', baseUrl: 'https://api.x.ai/v1', keyEnv: ['XAI_API_KEY'] },
	{ id: 'custom', label: 'Custom (OpenAI-compatible)', protocol: 'openai', baseUrl: null, keyEnv: ['CHAT_API_KEY'] }
];

export const CHAT_PROVIDER_IDS = CHAT_PROVIDERS.map((p) => p.id);
export const providerById = (id: string) => CHAT_PROVIDERS.find((p) => p.id === id) ?? null;

/** A model name safe to put in a request: what providers actually use (letters, digits and . _ : / @ + -), at most 100 characters. */
export const validModelName = (m: string) => /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/.test(m);

/** The provider and model the page offers, as the server describes them to it. */
export interface ChatProviderChoice { id: string; label: string; /** the model set for it in the environment ('' when none: the page lists the provider's own) */ model: string; host: string }
