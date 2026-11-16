import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { aliasId, chatLocked, offeredProviders } from '$lib/server/chatconfig';
import { listModels } from '$lib/server/chatmodels';

/**
 * The models one provider offers, for the chat's model menu: GET /chat/models?provider=deepseek. Any signed-in person may ask, as for
 * the chat itself; only providers this installation has switched on can be asked about, and nothing here reveals a key. With
 * CHAT_LOCK_MODEL=1 the menu is not shown, so the answer is empty.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) error(401, 'Sign in first.');
	if (chatLocked()) return json({ models: [], default: '' }, { headers: { 'cache-control': 'no-store' } });
	const id = aliasId(url.searchParams.get('provider') ?? '');
	const provider = id ? offeredProviders().find((p) => p.id === id) : undefined;
	if (!provider) error(404, 'That provider is not switched on for the chat.');
	return json({ models: await listModels(provider), default: provider.model }, { headers: { 'cache-control': 'no-store' } });
};
