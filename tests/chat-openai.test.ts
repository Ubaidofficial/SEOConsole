import { beforeEach, describe, expect, it } from 'vitest';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { resetRateLimits, resetWriteLimits } from '../src/lib/server/mcp';
import { chatBaseUrl, chatMaxTokens, chatModel, chatProvider, chatReady, chatSetupProblem, runTurn, threadMessages, type ModelCall } from '../src/lib/server/chat';
import { createOpenAiCall, ProviderError, toOpenAiMessages, toOpenAiTools } from '../src/lib/server/chatopenai';
import { OWNER } from '../src/lib/server/roles';
import type { ChatEvent } from '../src/lib/chat';

const CFG = () => ({ baseUrl: 'https://api.example.test/v1/', apiKey: 'sk-fake', maxTokens: 4096 });

/** A provider that answers with the given server-sent events, split into the given chunk sizes to prove the parser does not depend on them. */
const sse = (objs: unknown[], opts: { split?: number; raw?: string } = {}) => {
	const text = opts.raw ?? objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('') + 'data: [DONE]\n\n';
	const bytes = new TextEncoder().encode(text);
	const size = opts.split ?? bytes.length;
	return new Response(
		new ReadableStream({
			start(c) {
				for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
				c.close();
			}
		}),
		{ status: 200, headers: { 'content-type': 'text/event-stream' } }
	);
};
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

function fakeProvider(...replies: (Response | ((req: { url: string; init: RequestInit; body: Record<string, unknown> }) => Response))[]) {
	const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		seen.push({ url, headers: init.headers as Record<string, string>, body });
		const r = replies.shift();
		if (!r) throw new Error('provider script ran out');
		return typeof r === 'function' ? r({ url, init, body }) : r;
	}) as unknown as typeof fetch;
	return { fetchImpl, seen };
}

const params = (over: Partial<BetaMessageStreamParams> = {}): BetaMessageStreamParams => ({
	model: 'some-model',
	max_tokens: 32_000,
	system: 'SYSTEM TEXT',
	tools: [{ name: 'list_sites', description: 'List the sites', input_schema: { type: 'object', properties: {} }, cache_control: { type: 'ephemeral' } } as never],
	messages: [{ role: 'user', content: 'hi' }],
	...over
});
const sink = () => {
	const texts: string[] = [];
	return { texts, o: { signal: new AbortController().signal, onText: (t: string) => texts.push(t), onBlock: () => {} } };
};

describe('the messages sent to an OpenAI-compatible provider', () => {
	it('turns the stored conversation into chat-completions messages, tool results directly after their calls', () => {
		const out = toOpenAiMessages('SYS', [
			{ role: 'user', content: [{ type: 'text', text: 'how is example.com doing?' }, { type: 'text', text: '<context>Today is 2026-11-09.</context>' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'c1', name: 'list_sites', input: {} }, { type: 'tool_use', id: 'c2', name: 'get_overview', input: { site: 1 } }] as never },
			{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c2', content: '{"clicks":5}' }, { type: 'tool_result', tool_use_id: 'c1', is_error: true, content: 'nope' }, { type: 'text', text: 'and mobile?' }] },
			{ role: 'assistant', content: [{ type: 'tool_use', id: 'c3', name: 'get_performance', input: { device: 'mobile' } }] as never }
		]);
		expect(out).toEqual([
			{ role: 'system', content: 'SYS' },
			{ role: 'user', content: "how is example.com doing?\n\n<context>Today is 2026-11-09.</context>" },
			{
				role: 'assistant',
				content: 'Let me look.',
				tool_calls: [
					{ id: 'c1', type: 'function', function: { name: 'list_sites', arguments: '{}' } },
					{ id: 'c2', type: 'function', function: { name: 'get_overview', arguments: '{"site":1}' } }
				]
			},
			{ role: 'tool', tool_call_id: 'c2', content: '{"clicks":5}' },
			{ role: 'tool', tool_call_id: 'c1', content: 'Error: nope' },
			{ role: 'user', content: 'and mobile?' },
			{ role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'get_performance', arguments: '{"device":"mobile"}' } }] }
		]);
	});

	it('keeps plain string turns, drops blocks the protocol has no place for, and skips an assistant turn left empty', () => {
		const out = toOpenAiMessages(undefined, [
			{ role: 'user', content: 'plain' },
			{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }] as never },
			{ role: 'assistant', content: 'earlier answer' }
		]);
		expect(out).toEqual([{ role: 'user', content: 'plain' }, { role: 'assistant', content: 'earlier answer' }]);
	});

	it('sends tools as functions and leaves out the Claude-only cache marker', () => {
		const t = toOpenAiTools(params().tools);
		expect(t).toEqual([{ type: 'function', function: { name: 'list_sites', description: 'List the sites', parameters: { type: 'object', properties: {} } } }]);
		expect(JSON.stringify(t)).not.toContain('cache_control');
	});
});

describe('one streamed call to an OpenAI-compatible provider', () => {
	it('posts to the base address with the key, the model, the tools and a token cap', async () => {
		const p = fakeProvider(sse([delta({ content: 'ok' }, 'stop')]));
		await createOpenAiCall(CFG, p.fetchImpl)(params(), sink().o);
		const r = p.seen[0];
		expect(r.url).toBe('https://api.example.test/v1/chat/completions');
		expect(r.headers.authorization).toBe('Bearer sk-fake');
		expect(r.body.model).toBe('some-model');
		expect(r.body.stream).toBe(true);
		expect(r.body.max_tokens).toBe(4096);
		expect((r.body.tools as unknown[]).length).toBe(1);
		expect((r.body.messages as { role: string }[])[0]).toEqual({ role: 'system', content: 'SYSTEM TEXT' });
		expect(JSON.stringify(r.body)).not.toMatch(/cache_control|output_config|betas|fallbacks/);
	});

	it('sends no authorization header when there is no key (a local server)', async () => {
		const p = fakeProvider(sse([delta({ content: 'ok' }, 'stop')]));
		await createOpenAiCall(() => ({ ...CFG(), apiKey: '' }), p.fetchImpl)(params(), sink().o);
		expect(p.seen[0].headers.authorization).toBeUndefined();
	});

	it('streams text and returns it as one text block that ends the turn', async () => {
		const p = fakeProvider(sse([delta({ role: 'assistant', content: '' }), delta({ content: 'Clicks ' }), delta({ content: 'rose 8%.' }), delta({}, 'stop')], { split: 7 }));
		const s = sink();
		const res = await createOpenAiCall(CFG, p.fetchImpl)(params(), s.o);
		expect(s.texts.join('')).toBe('Clicks rose 8%.');
		expect(res.content).toEqual([{ type: 'text', text: 'Clicks rose 8%.', citations: null }]);
		expect(res.stop_reason).toBe('end_turn');
	});

	it('joins tool-call arguments split over chunks, and several calls, and reports tool_use even when the server says "stop"', async () => {
		const p = fakeProvider(
			sse(
				[
					delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_overview', arguments: '' } }] }),
					delta({ tool_calls: [{ index: 0, function: { arguments: '{"site":' } }] }),
					delta({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'list_sites', arguments: '{}' } }] }),
					delta({ tool_calls: [{ index: 0, function: { arguments: '3}' } }] }),
					delta({}, 'stop')
				],
				{ split: 5 }
			)
		);
		const res = await createOpenAiCall(CFG, p.fetchImpl)(params(), sink().o);
		expect(res.stop_reason).toBe('tool_use');
		expect(res.content).toEqual([
			{ type: 'tool_use', id: 'call_a', name: 'get_overview', input: { site: 3 } },
			{ type: 'tool_use', id: 'call_b', name: 'list_sites', input: {} }
		]);
	});

	it('answers broken or missing arguments with empty ones, and gives a call without an id one of its own', async () => {
		const p = fakeProvider(sse([delta({ tool_calls: [{ index: 0, function: { name: 'get_overview', arguments: '{"site":' } }] }), delta({}, 'tool_calls')]));
		const res = await createOpenAiCall(CFG, p.fetchImpl)(params(), sink().o);
		const b = res.content[0] as { type: string; id: string; input: unknown };
		expect(b.type).toBe('tool_use');
		expect(b.id).toMatch(/^call_/);
		expect(b.input).toEqual({});
	});

	it('maps the finish reasons the loop cares about, and ignores comments and blank lines in the stream', async () => {
		const raw = ': keep-alive\n\nevent: message\ndata: ' + JSON.stringify(delta({ content: 'cut' }, 'length')) + '\r\n\r\ndata: [DONE]\r\n\r\n';
		const res = await createOpenAiCall(CFG, fakeProvider(sse([], { raw })).fetchImpl)(params(), sink().o);
		expect(res.stop_reason).toBe('max_tokens');
		const filtered = await createOpenAiCall(CFG, fakeProvider(sse([delta({}, 'content_filter')])).fetchImpl)(params(), sink().o);
		expect(filtered.stop_reason).toBe('refusal');
		expect(filtered.content).toEqual([]);
	});

	it.each([
		[401, /rejected the API key \(CHAT_API_KEY\)/],
		[404, /Check CHAT_MODEL and CHAT_BASE_URL/],
		[429, /rate limiting/],
		[503, /server error \(503\)/],
		[400, /refused the request \(400\)\. It said: context too long/]
	])('words a %i answer for the person', async (status, re) => {
		const body = JSON.stringify({ error: { message: 'context too long' } });
		const p = fakeProvider(new Response(body, { status }));
		const err = await createOpenAiCall(CFG, p.fetchImpl)(params(), sink().o).catch((e) => e);
		expect(err).toBeInstanceOf(ProviderError);
		expect(err.message).toMatch(re);
		expect(err.message).not.toContain('sk-fake');
	});

	it('reports an unreachable provider by host only, and an error event inside the stream', async () => {
		const down = (async () => {
			throw new TypeError('fetch failed');
		}) as unknown as typeof fetch;
		const e1 = await createOpenAiCall(CFG, down)(params(), sink().o).catch((e) => e);
		expect(e1.message).toBe('Could not reach the model provider at api.example.test. Check CHAT_BASE_URL.');
		const e2 = await createOpenAiCall(CFG, fakeProvider(sse([{ error: { message: 'overloaded' } }])).fetchImpl)(params(), sink().o).catch((e) => e);
		expect(e2.message).toBe('The model provider reported an error: overloaded');
	});

	it('lets an abort through as itself, so the loop can tell a stop from a failure', async () => {
		const ctl = new AbortController();
		const fetchImpl = (async (_u: string, init: RequestInit) => {
			ctl.abort();
			if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
			return sse([]);
		}) as unknown as typeof fetch;
		const err = await createOpenAiCall(CFG, fetchImpl)(params(), { signal: ctl.signal, onText: () => {}, onBlock: () => {} }).catch((e) => e);
		expect(err).not.toBeInstanceOf(ProviderError);
		expect(ctl.signal.aborted).toBe(true);
	});
});

describe('choosing the provider', () => {
	beforeEach(() => {
		for (const k of ['CHAT_PROVIDER', 'CHAT_MODEL', 'CHAT_BASE_URL', 'CHAT_API_KEY', 'CHAT_MAX_TOKENS', 'ANTHROPIC_API_KEY']) delete process.env[k];
	});

	it('is Claude by default, and needs the Anthropic key', () => {
		expect(chatProvider()).toBe('anthropic');
		expect(chatModel()).toBe('claude-opus-5-5');
		expect(chatReady()).toBe(false);
		expect(chatSetupProblem()).toMatch(/ANTHROPIC_API_KEY/);
		process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
		expect(chatReady()).toBe(true);
	});

	it('needs a model name for an OpenAI-compatible provider, but not a key, and defaults the address to OpenAI', () => {
		process.env.CHAT_PROVIDER = 'OpenAI';
		expect(chatProvider()).toBe('openai');
		expect(chatModel()).toBe('');
		expect(chatReady()).toBe(false);
		expect(chatSetupProblem()).toMatch(/CHAT_MODEL/);
		process.env.CHAT_MODEL = 'a-model';
		expect(chatReady()).toBe(true);
		expect(chatBaseUrl()).toBe('https://api.openai.com/v1');
		process.env.CHAT_BASE_URL = 'http://localhost:11434/v1';
		expect(chatBaseUrl()).toBe('http://localhost:11434/v1');
		expect(chatReady()).toBe(true);
	});

	it('refuses a base address that is not http(s), and a provider name it does not know', () => {
		process.env.CHAT_PROVIDER = 'openai';
		process.env.CHAT_MODEL = 'a-model';
		process.env.CHAT_BASE_URL = 'ftp://x.example';
		expect(chatSetupProblem()).toMatch(/CHAT_BASE_URL/);
		process.env.CHAT_BASE_URL = 'not a url';
		expect(chatReady()).toBe(false);
		process.env.CHAT_PROVIDER = 'deepseek';
		process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
		expect(chatProvider()).toBeNull();
		expect(chatReady()).toBe(false);
		expect(chatSetupProblem()).toMatch(/CHAT_PROVIDER is "deepseek"/);
	});

	it('caps one answer at 8,192 tokens unless told otherwise', () => {
		expect(chatMaxTokens()).toBe(8192);
		process.env.CHAT_MAX_TOKENS = '16000';
		expect(chatMaxTokens()).toBe(16000);
		process.env.CHAT_MAX_TOKENS = 'lots';
		expect(chatMaxTokens()).toBe(8192);
	});
});

describe('a whole chat turn answered by an OpenAI-compatible provider', () => {
	beforeEach(async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		delete process.env.CHAT_MESSAGES_PER_DAY;
		delete process.env.READ_ONLY;
		process.env.CHAT_PROVIDER = 'openai';
		process.env.CHAT_MODEL = 'some-model';
		process.env.CHAT_API_KEY = 'sk-fake';
		delete process.env.ANTHROPIC_API_KEY;
		await ensureDemoAccounts();
		resetRateLimits();
		resetWriteLimits();
	});

	async function turn(input: Parameters<typeof runTurn>[1], call?: ModelCall) {
		const events: ChatEvent[] = [];
		await runTurn(OWNER, input, (e) => events.push(e), { call, now: '2026-11-09' });
		return events;
	}

	it('runs a tool the model asks for, sends its result back, stores the conversation in the usual shape, and shows the answer', async () => {
		const p = fakeProvider(
			sse([delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_sites', arguments: '{}' } }] }, 'tool_calls')]),
			sse([delta({ content: 'You have ' }), delta({ content: 'some sites.' }, 'stop')])
		);
		const events = await turn({ threadId: null, text: 'which sites do I have?' }, createOpenAiCall(() => ({ baseUrl: chatBaseUrl(), apiKey: 'sk-fake', maxTokens: chatMaxTokens() }), p.fetchImpl));
		expect(events.find((e) => e.type === 'error')).toBeUndefined();
		expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('You have some sites.');
		expect(events.some((e) => e.type === 'tool' && e.tool.name === 'list_sites' && e.tool.status === 'done')).toBe(true);
		expect(events[events.length - 1].type).toBe('done');

		// The second request carries the first answer's tool call and its result, in the provider's own shape.
		const second = p.seen[1].body.messages as { role: string; tool_call_id?: string; tool_calls?: { id: string }[] }[];
		const roles = second.map((m) => m.role);
		expect(roles).toEqual(['system', 'user', 'assistant', 'tool']);
		expect(second[2].tool_calls?.[0].id).toBe('call_1');
		expect(second[3].tool_call_id).toBe('call_1');

		// The stored thread is in the Anthropic block shape, as it is for Claude.
		const id = (events.find((e) => e.type === 'thread') as { id: number }).id;
		const stored = threadMessages(id);
		expect(stored.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
		expect((stored[1].content as { type: string }[])[0].type).toBe('tool_use');
		expect((stored[2].content as { type: string }[])[0].type).toBe('tool_result');
	});

	it('asks before a change, exactly as it does with Claude', async () => {
		const p = fakeProvider(sse([delta({ tool_calls: [{ index: 0, id: 'call_w', type: 'function', function: { name: 'log_change', arguments: '{"site":1,"note":"x"}' } }] }, 'tool_calls')]));
		const events = await turn({ threadId: null, text: 'log that I changed titles' }, createOpenAiCall(CFG, p.fetchImpl));
		expect(events.some((e) => e.type === 'approval')).toBe(true);
		expect(p.seen.length).toBe(1);
	});

	it('shows a provider problem as the error and still finishes with done', async () => {
		const events = await turn({ threadId: null, text: 'hi' }, createOpenAiCall(CFG, fakeProvider(new Response('{"error":{"message":"bad key"}}', { status: 401 })).fetchImpl));
		const err = events.find((e) => e.type === 'error') as { message: string };
		expect(err.message).toMatch(/rejected the API key \(CHAT_API_KEY\)/);
		expect(events[events.length - 1].type).toBe('done');
	});

	it('uses the OpenAI-compatible path by default when CHAT_PROVIDER=openai, and says what is missing when it is not set up', async () => {
		delete process.env.CHAT_MODEL;
		const events = await turn({ threadId: null, text: 'hi' });
		const err = events.find((e) => e.type === 'error') as { message: string };
		expect(err.message).toMatch(/CHAT_MODEL/);
		expect(db().prepare('SELECT COUNT(*) AS n FROM chat_threads').get()).toEqual({ n: 0 });
	});
});
