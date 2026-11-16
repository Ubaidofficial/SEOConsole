import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aliasId, chatLocked, chatMaxTokens, chatModel, chatReady, chatSetupProblem, chooseProvider, defaultProviderId, offeredProviders, providerChoices } from '../src/lib/server/chatconfig';
import { clearModelCache, listModels } from '../src/lib/server/chatmodels';
import { CHAT_PROVIDERS, validModelName } from '../src/lib/chatproviders';
import { accessRefusal, type CurrentUser } from '../src/lib/server/roles';

const VARS = [
	'CHAT_PROVIDER', 'CHAT_PROVIDERS', 'CHAT_MODEL', 'CHAT_API_KEY', 'CHAT_BASE_URL', 'CHAT_MAX_TOKENS', 'CHAT_LOCK_MODEL',
	...CHAT_PROVIDERS.flatMap((p) => [...p.keyEnv, `CHAT_MODEL_${p.id.toUpperCase()}`])
];
beforeEach(() => {
	for (const k of VARS) delete process.env[k];
	clearModelCache();
});
afterEach(() => {
	for (const k of VARS) delete process.env[k];
});
const ids = () => offeredProviders().map((p) => p.id);

describe('the providers the chat knows', () => {
	it('has the ones people asked for, each with an address and a key variable, and no model names built in but Claude\'s', () => {
		const have = CHAT_PROVIDERS.map((p) => p.id);
		expect(have).toEqual(expect.arrayContaining(['anthropic', 'openai', 'gemini', 'deepseek', 'kimi', 'custom']));
		for (const p of CHAT_PROVIDERS) {
			expect(p.keyEnv.length).toBeGreaterThan(0);
			if (p.id !== 'custom') expect(p.baseUrl).toMatch(/^https:\/\//);
			if (p.id !== 'anthropic') expect(p.defaultModel).toBeUndefined();
		}
	});
	it('reads the names people write for them', () => {
		expect(aliasId('DeepSeek')).toBe('deepseek');
		expect(aliasId('moonshot')).toBe('kimi');
		expect(aliasId('google')).toBe('gemini');
		expect(aliasId('openai-compatible')).toBe('custom');
		expect(aliasId('openai')).toBe('openai');
		expect(aliasId('nonsense')).toBeNull();
		process.env.CHAT_BASE_URL = 'https://api.deepseek.com';
		expect(aliasId('openai')).toBe('custom'); // the setting as it was first written: openai plus an address
	});
	it('accepts the model names providers use and refuses the rest', () => {
		for (const m of ['gpt-6', 'deepseek-chat', 'moonshotai/kimi-k2', 'gemini-2.5-pro', 'llama3.1:8b', 'claude-opus-5-5']) expect(validModelName(m)).toBe(true);
		for (const m of ['', ' x', 'a b', '"; drop', '../x', 'x'.repeat(101), '-flag']) expect(validModelName(m)).toBe(false);
	});
});

describe('which providers are offered', () => {
	it('is Claude alone by default, as before, and off without its key', () => {
		expect(defaultProviderId()).toBe('anthropic');
		expect(chatReady()).toBe(false);
		expect(chatSetupProblem()).toMatch(/ANTHROPIC_API_KEY/);
		process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
		expect(ids()).toEqual(['anthropic']);
		expect(chatModel()).toBe('claude-opus-5-5');
		expect(chatReady()).toBe(true);
	});
	it('does not offer a provider just because its key exists for another feature', () => {
		process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
		process.env.OPENAI_API_KEY = 'sk-for-ai-answers';
		process.env.GEMINI_API_KEY = 'g-x';
		expect(ids()).toEqual(['anthropic']);
	});
	it('offers the default provider, then those listed in CHAT_PROVIDERS, each only with its key', () => {
		process.env.CHAT_PROVIDER = 'deepseek';
		process.env.DEEPSEEK_API_KEY = 'sk-d';
		process.env.CHAT_PROVIDERS = 'anthropic, gemini, kimi, nonsense, deepseek';
		process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
		process.env.GEMINI_API_KEY = 'g-x';
		// kimi has no key, "nonsense" is unknown, deepseek is not repeated
		expect(ids()).toEqual(['deepseek', 'anthropic', 'gemini']);
		process.env.KIMI_API_KEY = 'k-x';
		expect(ids()).toEqual(['deepseek', 'anthropic', 'gemini', 'kimi']);
		expect(providerChoices().map((p) => p.label)).toEqual(['DeepSeek', 'Claude (Anthropic)', 'Gemini (Google)', 'Kimi (Moonshot)']);
		expect(providerChoices().every((p) => !JSON.stringify(p).includes('sk-'))).toBe(true);
	});
	it('lets CHAT_API_KEY stand in for the default provider\'s own key, and names it in messages', () => {
		process.env.CHAT_PROVIDER = 'deepseek';
		expect(chatReady()).toBe(false);
		expect(chatSetupProblem()).toMatch(/DEEPSEEK_API_KEY/);
		process.env.CHAT_API_KEY = 'sk-generic';
		expect(offeredProviders()[0]).toMatchObject({ id: 'deepseek', apiKey: 'sk-generic', keyName: 'CHAT_API_KEY', baseUrl: 'https://api.deepseek.com', host: 'api.deepseek.com' });
		// but not for a provider that is only listed
		process.env.CHAT_PROVIDERS = 'gemini';
		expect(ids()).toEqual(['deepseek']);
	});
	it('takes the model from CHAT_MODEL for the default provider and CHAT_MODEL_<ID> for any', () => {
		process.env.CHAT_PROVIDER = 'deepseek';
		process.env.DEEPSEEK_API_KEY = 'sk-d';
		process.env.CHAT_MODEL = 'm-default';
		process.env.CHAT_PROVIDERS = 'gemini';
		process.env.GEMINI_API_KEY = 'g-x';
		process.env.CHAT_MODEL_GEMINI = 'm-gem';
		const byId = Object.fromEntries(offeredProviders().map((p) => [p.id, p.model]));
		expect(byId).toEqual({ deepseek: 'm-default', gemini: 'm-gem' });
		process.env.CHAT_MODEL_DEEPSEEK = 'm-specific';
		expect(offeredProviders()[0].model).toBe('m-specific');
	});
	it('reads the first setting as a custom address, and needs a valid one', () => {
		process.env.CHAT_PROVIDER = 'openai';
		process.env.CHAT_BASE_URL = 'https://api.deepseek.com';
		expect(defaultProviderId()).toBe('custom');
		expect(offeredProviders()[0]).toMatchObject({ id: 'custom', label: 'Custom (api.deepseek.com)', host: 'api.deepseek.com', apiKey: '' });
		expect(chatReady()).toBe(true); // a local server needs no key
		process.env.CHAT_BASE_URL = 'ftp://x.example';
		expect(chatReady()).toBe(false);
		expect(chatSetupProblem()).toMatch(/CHAT_BASE_URL/);
		process.env.CHAT_PROVIDER = 'custom';
		delete process.env.CHAT_BASE_URL;
		expect(chatSetupProblem()).toMatch(/CHAT_BASE_URL/);
	});
	it('keeps chat off, and says so, for a provider name it does not know, even when Claude has a key', () => {
		process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
		process.env.CHAT_PROVIDER = 'deepsek';
		expect(defaultProviderId()).toBeNull();
		expect(chatReady()).toBe(false);
		expect(chatSetupProblem()).toMatch(/CHAT_PROVIDER is "deepsek".*deepseek/);
	});
	it('caps one answer at 8,192 tokens unless told otherwise', () => {
		expect(chatMaxTokens()).toBe(8192);
		process.env.CHAT_MAX_TOKENS = '16000';
		expect(chatMaxTokens()).toBe(16000);
		process.env.CHAT_MAX_TOKENS = 'lots';
		expect(chatMaxTokens()).toBe(8192);
	});
});

describe('what a person may pick for one turn', () => {
	beforeEach(() => {
		process.env.CHAT_PROVIDER = 'deepseek';
		process.env.DEEPSEEK_API_KEY = 'sk-d';
		process.env.CHAT_MODEL = 'm-default';
		process.env.CHAT_PROVIDERS = 'anthropic,gemini';
		process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
		process.env.GEMINI_API_KEY = 'g-x';
	});
	it('uses the default provider and its model when nothing is picked', () => {
		const c = chooseProvider();
		expect('provider' in c && [c.provider.id, c.model]).toEqual(['deepseek', 'm-default']);
	});
	it('uses the provider and model picked, when that provider is switched on', () => {
		const c = chooseProvider('anthropic', 'claude-sonnet-5-5');
		expect('provider' in c && [c.provider.id, c.model]).toEqual(['anthropic', 'claude-sonnet-5-5']);
		const d = chooseProvider('Gemini');
		expect('error' in d).toBe(true); // gemini has no model set and none was picked
		expect('error' in d && d.error).toMatch(/Choose a model for Gemini.*CHAT_MODEL_GEMINI/);
		const e = chooseProvider('gemini', 'gemini-x');
		expect('provider' in e && e.model).toBe('gemini-x');
	});
	it('refuses a provider that is not switched on, and a model name that is not plausible', () => {
		expect(chooseProvider('openai', 'gpt-x')).toEqual({ error: 'openai is not switched on for this chat. Pick another provider.' });
		expect(chooseProvider('mistral')).toEqual({ error: 'mistral is not switched on for this chat. Pick another provider.' });
		expect(chooseProvider('deepseek', 'a b; x')).toEqual({ error: 'That model name is not valid.' });
		expect(chooseProvider('nonsense')).toMatchObject({ error: expect.stringContaining('not switched on') });
	});
	it('ignores any pick when CHAT_LOCK_MODEL=1', () => {
		process.env.CHAT_LOCK_MODEL = '1';
		expect(chatLocked()).toBe(true);
		const c = chooseProvider('anthropic', 'claude-sonnet-5-5');
		expect('provider' in c && [c.provider.id, c.model]).toEqual(['deepseek', 'm-default']);
	});
	it('says how to set it up when nothing is switched on', () => {
		for (const k of ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) delete process.env[k];
		expect(chooseProvider('anthropic')).toMatchObject({ error: expect.stringContaining('DEEPSEEK_API_KEY') });
	});
});

describe('the models a provider lists', () => {
	const provider = (over: Record<string, unknown> = {}) => ({ id: 'deepseek', label: 'DeepSeek', protocol: 'openai' as const, baseUrl: 'https://api.deepseek.com', apiKey: 'sk-secret-123456', keyName: 'DEEPSEEK_API_KEY', model: '', host: 'api.deepseek.com', ...over });
	const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

	it('asks the provider, sends the key, drops models that cannot chat, strips Gemini\'s "models/" prefix and sorts', async () => {
		const seen: { url: string; headers: Record<string, string> }[] = [];
		const f = (async (url: string, init: RequestInit) => {
			seen.push({ url, headers: init.headers as Record<string, string> });
			return reply({ data: [{ id: 'models/zeta-chat' }, { id: 'text-embedding-3' }, { id: 'alpha-chat' }, { id: 'whisper-1' }, { id: 'dall-e-3' }] });
		}) as unknown as typeof fetch;
		expect(await listModels(provider(), f)).toEqual(['alpha-chat', 'zeta-chat']);
		expect(seen[0].url).toBe('https://api.deepseek.com/models');
		expect(seen[0].headers.authorization).toBe('Bearer sk-secret-123456');
	});
	it('asks Anthropic its own way', async () => {
		let seen: { url: string; headers: Record<string, string> } | null = null;
		const f = (async (url: string, init: RequestInit) => {
			seen = { url, headers: init.headers as Record<string, string> };
			return reply({ data: [{ id: 'claude-b' }, { id: 'claude-a' }] });
		}) as unknown as typeof fetch;
		const m = await listModels(provider({ id: 'anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' }), f);
		expect(m).toEqual(['claude-a', 'claude-b']);
		expect(seen!.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
		expect(seen!.headers['x-api-key']).toBe('sk-secret-123456');
		expect(seen!.headers.authorization).toBeUndefined();
	});
	it('caches a list for ten minutes, but not an empty one', async () => {
		let calls = 0;
		const ok = (async () => (calls++, reply({ data: [{ id: 'm1' }] }))) as unknown as typeof fetch;
		const t0 = 1_000_000;
		await listModels(provider(), ok, t0);
		await listModels(provider(), ok, t0 + 9 * 60_000);
		expect(calls).toBe(1);
		await listModels(provider(), ok, t0 + 11 * 60_000);
		expect(calls).toBe(2);
		clearModelCache();
		let n = 0;
		const down = (async () => (n++, reply({ error: 'x' }, 500))) as unknown as typeof fetch;
		expect(await listModels(provider(), down)).toEqual([]);
		expect(await listModels(provider(), down)).toEqual([]);
		expect(n).toBe(2);
	});
	it('gives an empty list, not an error, when the provider cannot be reached', async () => {
		const f = (async () => {
			throw new TypeError('fetch failed');
		}) as unknown as typeof fetch;
		expect(await listModels(provider(), f)).toEqual([]);
	});
});

describe('who may open the model menu', () => {
	const person = (role: CurrentUser['role'], siteIds: number[] | null): CurrentUser => ({ id: 7, email: null, name: 'x', role, siteIds });
	it('lets every signed-in role, including a person limited to some sites, ask for a provider\'s models', () => {
		for (const u of [person('viewer', null), person('editor', [1]), person('viewer', [2])]) expect(accessRefusal(u, 'GET', new URL('https://x.example/chat/models?provider=deepseek'))).toBeNull();
	});
});
