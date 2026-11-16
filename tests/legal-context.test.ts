import { afterEach, describe, expect, it } from 'vitest';
import { legalContext } from '../src/lib/server/legal';

const keys = ['CHAT_PROVIDER', 'CHAT_PROVIDERS', 'CHAT_BASE_URL', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY'];
afterEach(() => {
	for (const k of keys) delete process.env[k];
});

describe('the providers the privacy page names for the Ask chat', () => {
	it('is empty while chat is off, and Anthropic alone for the default', () => {
		expect(legalContext().context.chatProviders).toEqual([]);
		process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
		expect(legalContext().context.chatProviders).toEqual(['Anthropic']);
	});
	it('lists the address of each provider switched on, never a path or a key', () => {
		process.env.CHAT_PROVIDER = 'deepseek';
		process.env.DEEPSEEK_API_KEY = 'sk-x';
		expect(legalContext().context.chatProviders).toEqual(['api.deepseek.com']);
		process.env.CHAT_PROVIDERS = 'anthropic,gemini';
		process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
		process.env.GEMINI_API_KEY = 'g-x';
		expect(legalContext().context.chatProviders).toEqual(['api.deepseek.com', 'Anthropic', 'generativelanguage.googleapis.com']);
	});
	it('does not name a provider that is merely listed without a key, or one whose key exists only for AI answers', () => {
		process.env.CHAT_PROVIDER = 'deepseek';
		process.env.DEEPSEEK_API_KEY = 'sk-x';
		process.env.CHAT_PROVIDERS = 'gemini';
		process.env.OPENAI_API_KEY = 'sk-openai-for-ai-answers';
		expect(legalContext().context.chatProviders).toEqual(['api.deepseek.com']);
	});
	it('names a custom address by its host', () => {
		process.env.CHAT_PROVIDER = 'openai';
		process.env.CHAT_BASE_URL = 'http://localhost:11434/v1';
		expect(legalContext().context.chatProviders).toEqual(['localhost:11434']);
	});
});
