import { afterEach, describe, expect, it } from 'vitest';
import { legalContext } from '../src/lib/server/legal';

const keys = ['CHAT_PROVIDER', 'CHAT_BASE_URL'];
afterEach(() => {
	for (const k of keys) delete process.env[k];
});

describe('the host the privacy page names for the Ask chat', () => {
	it('is none for Claude, which the page already names', () => {
		expect(legalContext().context.chatHost).toBeNull();
		process.env.CHAT_PROVIDER = 'anthropic';
		expect(legalContext().context.chatHost).toBeNull();
	});
	it('is the address of the OpenAI-compatible provider, never the path or a key', () => {
		process.env.CHAT_PROVIDER = 'openai';
		process.env.CHAT_BASE_URL = 'https://api.deepseek.com/v1';
		expect(legalContext().context.chatHost).toBe('api.deepseek.com');
		process.env.CHAT_BASE_URL = 'http://localhost:11434/v1';
		expect(legalContext().context.chatHost).toBe('localhost:11434');
	});
	it('falls back to OpenAI when no address is set, and does not break on a bad one', () => {
		process.env.CHAT_PROVIDER = 'openai';
		expect(legalContext().context.chatHost).toBe('api.openai.com');
		process.env.CHAT_BASE_URL = 'not a url';
		expect(legalContext().context.chatHost).toBe('the address set in CHAT_BASE_URL');
	});
});
