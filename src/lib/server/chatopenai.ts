/**
 * The chat's second model path: any server that speaks the OpenAI "chat completions" protocol (OpenAI, DeepSeek, OpenRouter, Groq, a local
 * Ollama or vLLM, ...), chosen with CHAT_PROVIDER=openai.
 *
 * The conversation is stored in Anthropic's block format (text, tool_use, tool_result) whichever provider answers, so the loop, the
 * approval step and the page that shows a conversation do not change. This file only translates at the edge: the stored messages and the
 * tool list go out as chat-completions messages and function tools, and the streamed answer comes back as the same blocks the loop
 * already reads (text, tool_use) plus a stop reason.
 *
 * What it does not do, on purpose: prompt caching, CHAT_EFFORT and refusal fallbacks are Claude features and are ignored here. A model that
 * returns its reasoning as a separate field (`reasoning_content`) has that field dropped, so use the provider's non-reasoning model.
 *
 * Written from the protocol's documentation and tested against a fake server; not run against a live provider.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages';

type Params = BetaMessageStreamParams;
type Reply = Anthropic.Beta.BetaMessage;

/** A problem with the provider, worded for the person reading the chat (never contains the API key). */
export class ProviderError extends Error {}

export interface OpenAiConfig {
	/** Up to and including the version segment, e.g. https://api.deepseek.com or https://api.openai.com/v1. */
	baseUrl: string;
	apiKey: string;
	maxTokens: number;
}

export type OaToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type OaMessage =
	| { role: 'system' | 'user'; content: string }
	| { role: 'assistant'; content: string | null; tool_calls?: OaToolCall[] }
	| { role: 'tool'; tool_call_id: string; content: string };
export interface OaTool { type: 'function'; function: { name: string; description: string; parameters: unknown } }

const TIMEOUT_MS = 300_000;
const ERROR_SNIPPET = 300;

const resultText = (b: { content?: unknown; is_error?: boolean }): string => {
	const c = b.content;
	const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as { text: unknown }).text) : '')).join('\n') : '';
	return b.is_error ? `Error: ${text}` : text;
};

/** The stored conversation as chat-completions messages. Blocks this protocol has no place for (thinking, server tools) are left out. */
export function toOpenAiMessages(system: Params['system'], messages: Params['messages']): OaMessage[] {
	const out: OaMessage[] = [];
	const sys = typeof system === 'string' ? system : Array.isArray(system) ? system.map((b) => ('text' in b ? b.text : '')).join('\n\n') : '';
	if (sys) out.push({ role: 'system', content: sys });
	for (const m of messages) {
		if (!m.content) continue;
		if (typeof m.content === 'string') {
			out.push({ role: m.role, content: m.content });
			continue;
		}
		if (m.role === 'assistant') {
			const texts: string[] = [];
			const calls: OaToolCall[] = [];
			for (const b of m.content) {
				if (b.type === 'text') texts.push(b.text);
				else if (b.type === 'tool_use') calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
			}
			const content = texts.join('\n\n');
			if (!content && !calls.length) continue;
			out.push(calls.length ? { role: 'assistant', content: content || null, tool_calls: calls } : { role: 'assistant', content });
			continue;
		}
		// A person's turn: tool results become `tool` messages (they must directly follow the assistant message that asked), then any text.
		const texts: string[] = [];
		for (const b of m.content) {
			if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: resultText(b) });
			else if (b.type === 'text') texts.push(b.text);
		}
		if (texts.length) out.push({ role: 'user', content: texts.join('\n\n') });
	}
	return out;
}

export function toOpenAiTools(tools: Params['tools']): OaTool[] {
	const out: OaTool[] = [];
	for (const t of tools ?? []) {
		const x = t as { name?: string; description?: string; input_schema?: unknown };
		if (x.name && x.input_schema) out.push({ type: 'function', function: { name: x.name, description: x.description ?? '', parameters: x.input_schema } });
	}
	return out;
}

const parseArgs = (raw: string): Record<string, unknown> => {
	if (!raw.trim()) return {};
	try {
		const v = JSON.parse(raw);
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	} catch {
		return {}; // the tool then refuses the empty arguments with its own message, which the model reads and corrects
	}
};

const snippet = (s: string) => (s.length > ERROR_SNIPPET ? `${s.slice(0, ERROR_SNIPPET)}…` : s);

async function failure(r: Response, model: string): Promise<ProviderError> {
	let detail = '';
	try {
		const body = await r.text();
		try {
			const j = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
			const m = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message;
			detail = typeof m === 'string' ? m : body;
		} catch {
			detail = body;
		}
	} catch {
		/* no body */
	}
	detail = snippet(detail.replace(/\s+/g, ' ').trim());
	if (r.status === 401 || r.status === 403) return new ProviderError(`The model provider rejected the API key (CHAT_API_KEY) or does not allow it to use ${model}.${detail ? ` It said: ${detail}` : ''}`);
	if (r.status === 404) return new ProviderError(`The model provider did not find ${model} or the endpoint. Check CHAT_MODEL and CHAT_BASE_URL.${detail ? ` It said: ${detail}` : ''}`);
	if (r.status === 429) return new ProviderError('The model provider is rate limiting this key. Wait a minute and ask again.');
	if (r.status >= 500) return new ProviderError(`The model provider had a server error (${r.status}). Ask again in a moment.`);
	return new ProviderError(`The model provider refused the request (${r.status}).${detail ? ` It said: ${detail}` : ''}`);
}

type Delta = { content?: unknown; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
type Chunk = { choices?: { delta?: Delta; finish_reason?: string | null }[]; error?: { message?: unknown } | string };

/** The server-sent events of a streamed completion, one parsed JSON object per `data:` line. */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<Chunk> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	const lines = function* (flush: boolean) {
		let i: number;
		while ((i = buf.indexOf('\n')) >= 0) {
			yield buf.slice(0, i).replace(/\r$/, '');
			buf = buf.slice(i + 1);
		}
		if (flush && buf) {
			yield buf.replace(/\r$/, '');
			buf = '';
		}
	};
	const parse = (line: string): Chunk | 'done' | null => {
		if (!line.startsWith('data:')) return null; // comments (": keep-alive"), event names and blank lines
		const data = line.slice(5).trim();
		if (!data) return null;
		if (data === '[DONE]') return 'done';
		try {
			return JSON.parse(data) as Chunk;
		} catch {
			return null;
		}
	};
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (value) buf += decoder.decode(value, { stream: true });
			for (const line of lines(!!done)) {
				const c = parse(line);
				if (c === 'done') return;
				if (c) yield c;
			}
			if (done) return;
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Builds the model call the chat loop uses. `config` is read on every call, so a changed setting needs no restart of the loop; the fetch
 * is a parameter so tests can stand in for the provider.
 */
export function createOpenAiCall(config: () => OpenAiConfig, fetchImpl: typeof fetch = fetch) {
	return async (params: Params, o: { signal: AbortSignal; onText: (t: string) => void; onBlock: () => void }): Promise<Reply> => {
		const cfg = config();
		const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
		const tools = toOpenAiTools(params.tools);
		const body = {
			model: params.model,
			messages: toOpenAiMessages(params.system, params.messages),
			...(tools.length ? { tools } : {}),
			stream: true,
			max_tokens: cfg.maxTokens
		};
		const timeout = AbortSignal.timeout(TIMEOUT_MS);
		let res: Response;
		try {
			res = await fetchImpl(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
				body: JSON.stringify(body),
				signal: AbortSignal.any([o.signal, timeout])
			});
		} catch (e) {
			if (o.signal.aborted) throw e;
			if (timeout.aborted) throw new ProviderError('The model provider did not answer in time. Ask again.');
			let host = url;
			try {
				host = new URL(url).host;
			} catch {
				/* keep the whole text */
			}
			throw new ProviderError(`Could not reach the model provider at ${host}. Check CHAT_BASE_URL.`);
		}
		if (!res.ok) throw await failure(res, params.model);
		if (!res.body) throw new ProviderError('The model provider sent no answer.');

		let text = '';
		let finish: string | null = null;
		const calls = new Map<number, { id: string; name: string; args: string }>();
		try {
			for await (const chunk of events(res.body)) {
				if (chunk.error) {
					const m = typeof chunk.error === 'string' ? chunk.error : chunk.error.message;
					throw new ProviderError(`The model provider reported an error: ${snippet(String(m ?? 'unknown'))}`);
				}
				const choice = chunk.choices?.[0];
				if (!choice) continue;
				const d = choice.delta ?? {};
				if (typeof d.content === 'string' && d.content) {
					text += d.content;
					o.onText(d.content);
				}
				for (const tc of d.tool_calls ?? []) {
					// Most servers number the calls; a few resend a whole call without an index, so a fresh id means a new call.
					const i = tc.index ?? (tc.id ? calls.size : Math.max(0, calls.size - 1));
					const c = calls.get(i) ?? { id: '', name: '', args: '' };
					if (tc.id) c.id = tc.id;
					if (tc.function?.name && !c.name) c.name = tc.function.name;
					if (tc.function?.arguments) c.args += tc.function.arguments;
					calls.set(i, c);
				}
				if (choice.finish_reason) finish = choice.finish_reason;
			}
		} catch (e) {
			if (o.signal.aborted || e instanceof ProviderError) throw e;
			if (timeout.aborted) throw new ProviderError('The model provider did not answer in time. Ask again.');
			throw new ProviderError('The connection to the model provider broke while it was answering. Ask again.');
		}

		const content: unknown[] = [];
		if (text.trim()) content.push({ type: 'text', text, citations: null });
		let n = 0;
		for (const c of [...calls.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1])) {
			if (!c.name) continue;
			content.push({ type: 'tool_use', id: c.id || `call_${Date.now().toString(36)}_${n}`, name: c.name, input: parseArgs(c.args) });
			n++;
		}
		const stop = n > 0 ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end_turn';
		return { id: 'oa', type: 'message', role: 'assistant', model: params.model, content, stop_reason: stop, stop_sequence: null, usage: {} } as unknown as Reply;
	};
}
