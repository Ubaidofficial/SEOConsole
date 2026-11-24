import nodemailer from 'nodemailer';
import { env } from './config';

/**
 * Email for alerts, through the operator's own SMTP server. Everything about the server comes from .env (SMTP_URL, ALERT_EMAIL_FROM),
 * never from a form, so the app cannot be pointed at another mail server by someone using the UI. Recipients can be set per site by
 * an admin (checked here), else ALERT_EMAIL_TO.
 *
 *   SMTP_URL=smtps://user:password@smtp.example.com:465      (or smtp://…:587 for STARTTLS)
 *   ALERT_EMAIL_FROM="SEOConsole <alerts@example.com>"
 *   ALERT_EMAIL_TO=you@example.com, team@example.com          (optional default recipients)
 */
export const MAX_RECIPIENTS = 10;
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export function mailConfig(): { url: string; from: string; defaultTo: string[] } | null {
	const url = env('SMTP_URL').trim();
	if (!url || !/^smtps?:\/\//i.test(url)) return null;
	const from = env('ALERT_EMAIL_FROM').trim();
	if (!from) return null;
	return { url, from, defaultTo: parseRecipients(env('ALERT_EMAIL_TO')).list };
}

/** Addresses separated by commas, semicolons or spaces: valid ones kept (lower-cased, deduplicated, at most MAX_RECIPIENTS). */
export function parseRecipients(raw: string | null | undefined): { list: string[]; bad: string[] } {
	const parts = String(raw ?? '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
	const list = [...new Set(parts.filter((x) => EMAIL.test(x) && x.length <= 254))].slice(0, MAX_RECIPIENTS);
	return { list, bad: parts.filter((x) => !EMAIL.test(x)) };
}

type Sender = (m: { from: string; to: string[]; subject: string; text: string }) => Promise<unknown>;
let sender: Sender | null = null;
/** For tests: replace the SMTP transport. */
export const setMailSender = (s: Sender | null) => (sender = s);

export async function sendMail(to: string[], subject: string, text: string): Promise<{ ok: boolean; message: string }> {
	const cfg = mailConfig();
	if (!cfg) return { ok: false, message: 'Email is not set up (SMTP_URL and ALERT_EMAIL_FROM).' };
	if (!to.length) return { ok: false, message: 'No recipients.' };
	try {
		const send: Sender = sender ?? ((m) => nodemailer.createTransport(cfg.url, { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 }).sendMail(m));
		await send({ from: cfg.from, to, subject: subject.slice(0, 200), text });
		return { ok: true, message: `Emailed ${to.length} recipient${to.length === 1 ? '' : 's'}.` };
	} catch (e) {
		// the error text can carry the server's address but never the password (it lives only in SMTP_URL)
		return { ok: false, message: `Email failed: ${e instanceof Error ? e.message.replace(/\/\/[^@\s]*@/g, '//…@').slice(0, 160) : 'unknown error'}` };
	}
}
