import { env } from './config';
import type { LegalContext } from '../legal';

/** Who the privacy policy and terms speak for, from the environment. `configured` is false until the operator names themselves and a contact. */
export function legalContext(): { context: LegalContext; configured: boolean } {
	const entity = env('LEGAL_ENTITY').trim();
	const contact = env('LEGAL_CONTACT_EMAIL').trim();
	const law = env('LEGAL_GOVERNING_LAW').trim();
	// When the Ask chat is pointed at another provider than Anthropic, the privacy page must name where the data goes.
	const prov = env('CHAT_PROVIDER').trim().toLowerCase();
	let chatHost: string | null = null;
	if (prov === 'openai' || prov === 'openai-compatible') {
		try {
			chatHost = new URL(env('CHAT_BASE_URL').trim() || 'https://api.openai.com/v1').host;
		} catch {
			chatHost = 'the address set in CHAT_BASE_URL';
		}
	}
	return {
		configured: !!entity && !!contact,
		context: { entity: entity || 'the operator of this SEOConsole installation', contact: contact || null, law: law || null, updated: env('LEGAL_UPDATED', '2026-11-14'), chatHost }
	};
}
