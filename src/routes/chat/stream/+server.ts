import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runTurn, type TurnInput } from '$lib/server/chat';
import type { ChatEvent } from '$lib/chat';

/**
 * One chat turn, streamed as newline-delimited JSON events (see ChatEvent). Body: {threadId?, text} for a new message, or
 * {threadId, decisions: {toolUseId: true|false}} to answer the changes waiting for approval. Either may carry `provider` and `model`, the
 * person's pick from the chat's menus. Any signed-in person may chat; what
 * the chat may do follows their role and site scope (src/lib/server/chat.ts).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = locals.user;
	if (!user) error(401, 'Sign in first.');
	if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) error(415, 'Send JSON.');
	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		error(400, 'The body is not valid JSON.');
	}
	const threadId = body.threadId == null || body.threadId === '' ? null : Number(body.threadId);
	if (threadId !== null && !Number.isInteger(threadId)) error(400, '`threadId` must be a number.');
	let input: TurnInput;
	if (body.decisions && typeof body.decisions === 'object' && !Array.isArray(body.decisions)) {
		if (threadId === null) error(400, 'Approvals need the `threadId`.');
		input = { threadId, decisions: Object.fromEntries(Object.entries(body.decisions as Record<string, unknown>).map(([k, v]) => [k, v === true])) };
	} else input = { threadId, text: String(body.text ?? '') };
	// The provider and model the person picked; the server checks both and falls back to its default.
	if (typeof body.provider === 'string') input.provider = body.provider.slice(0, 40);
	if (typeof body.model === 'string') input.model = body.model.slice(0, 120);

	const abort = new AbortController();
	request.signal.addEventListener('abort', () => abort.abort());
	const enc = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const emit = (e: ChatEvent) => {
				try {
					controller.enqueue(enc.encode(JSON.stringify(e) + '\n'));
				} catch {
					/* the browser went away: the turn still finishes and is stored */
				}
			};
			await runTurn(user, input, emit, { signal: abort.signal });
			try {
				controller.close();
			} catch {
				/* already closed */
			}
		},
		cancel() {
			abort.abort();
		}
	});
	return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
};
