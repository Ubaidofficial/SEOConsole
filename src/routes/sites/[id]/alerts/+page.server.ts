import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { config } from '$lib/server/config';
import { requireRole, hasRole } from '$lib/server/roles';
import { setSiteEmails } from '$lib/server/alerts';
import { mailConfig } from '$lib/server/mail';
import { addCustomRule, alertTrends, closeAlerts, deleteCustomRule, listAlerts, listRules, maskedWebhook, renderAlerts, reopenAlert, runAlertRules, scopeText, setSiteWebhook, siteWebhook, updateRule } from '$lib/server/alerts';
import { postWebhook, webhook } from '$lib/server/digest';
import { listGroups } from '$lib/server/groups';
import { listTracked } from '$lib/server/ranktrack';
import { ALERT_KINDS, alertKind, ruleText } from '$lib/alerts';
import { displayName } from '$lib/server/clients';

export const load: PageServerLoad = ({ params, locals }) => {
	const site = getSite(Number(params.id))!;
	const rules = listRules(site.id).map((r) => {
		const k = alertKind(r.kind)!;
		return { ...r, label: k.label, text: ruleText(k, r.threshold), unit: k.unit, positive: k.positive, scope: scopeText(site.id, r) };
	});
	const alerts = listAlerts({ siteIds: null, siteId: site.id, status: 'all', limit: 60 });
	return {
		rules,
		trends: alertTrends(alerts),
		kinds: ALERT_KINDS.map((k) => ({ kind: k.kind, label: k.label, unit: k.unit, threshold: k.threshold, window: k.window, scopable: k.scopable, rule: k.rule })),
		buckets: listGroups(site.id, 'bucket').map((g) => ({ id: g.id, name: g.name })),
		pageGroups: listGroups(site.id, 'pages').map((g) => ({ id: g.id, name: g.name })),
		tracked: listTracked(site.id).length,
		alerts,
		webhook: { site: maskedWebhook(site.alert_webhook), global: !!webhook().url },
		email: (() => {
			const cfg = mailConfig();
			return { configured: !!cfg, site: site.alert_emails ?? '', defaults: cfg?.defaultTo.length ?? 0 };
		})(),
		canAdmin: hasRole(locals.user?.role, 'admin')
	};
};

const num = (v: FormDataEntryValue | null) => (v === null || v === '' ? undefined : Number(v));
const who = (locals: App.Locals) => locals.user?.email ?? locals.user?.name ?? 'owner';

export const actions: Actions = {
	rule: async ({ params, request }) => {
		const f = await request.formData();
		const r = updateRule(Number(params.id), Number(f.get('id')), { threshold: num(f.get('threshold')), windowDays: num(f.get('window')), enabled: f.has('enabled') ? f.getAll('enabled').includes('1') : undefined });
		return 'error' in r ? fail(400, { error: r.error }) : { ok: 'Rule saved.' };
	},
	addRule: async ({ params, request }) => {
		const f = await request.formData();
		const scopeKind = String(f.get('scopeKind') ?? 'site');
		const scopeValue = scopeKind === 'bucket' ? f.get('bucket') : scopeKind === 'pages' ? f.get('pageGroup') : f.get('scopeValue');
		const r = addCustomRule(Number(params.id), { kind: String(f.get('kind') ?? ''), threshold: Number(f.get('threshold')), windowDays: Number(f.get('window')), scopeKind, scopeValue: scopeValue == null ? null : String(scopeValue), name: String(f.get('name') ?? '') });
		return 'error' in r ? fail(400, { error: r.error }) : { ok: 'Custom alert added. It is checked with the next hourly run, or press Check now.' };
	},
	deleteRule: async ({ params, request }) => {
		const f = await request.formData();
		return deleteCustomRule(Number(params.id), Number(f.get('id'))) ? { ok: 'Custom alert removed.' } : fail(400, { error: 'Built-in rules can be switched off, not removed.' });
	},
	webhook: async ({ params, request, locals }) => {
		requireRole(locals, 'admin');
		const f = await request.formData();
		const r = setSiteWebhook(Number(params.id), f.get('remove') ? '' : String(f.get('url') ?? ''));
		return 'error' in r ? fail(400, { error: r.error }) : { ok: f.get('remove') ? 'This site\'s alerts go to the default webhook again.' : 'Alerts for this site now go to that webhook.' };
	},
	/** Who gets this site's alerts by email (admin). Empty = ALERT_EMAIL_TO. */
	emails: async ({ params, request, locals }) => {
		requireRole(locals, 'admin');
		const r = setSiteEmails(Number(params.id), String((await request.formData()).get('emails') ?? ''));
		return 'error' in r ? fail(400, { error: r.error }) : { ok: r.list.length ? `Alerts for this site are emailed to ${r.list.length} address${r.list.length === 1 ? '' : 'es'}.` : 'This site uses the default recipients (ALERT_EMAIL_TO).' };
	},
	testWebhook: async ({ params, locals }) => {
		requireRole(locals, 'admin');
		if (config.readOnly) return fail(403, { error: 'READ_ONLY=1: sending is off.' });
		const site = getSite(Number(params.id))!;
		const own = siteWebhook(site.alert_webhook);
		const target = own && !('error' in own) ? own : undefined;
		if (!target && !webhook().url) return fail(400, { error: 'No webhook: set one for this site, or DIGEST_WEBHOOK_URL in .env.' });
		const text = renderAlerts([{ site: site.label || displayName(site.site_url), title: 'Test alert', detail: 'This is how alerts for this site will look.', positive: false, siteId: site.id }], config.origin);
		const r = await postWebhook(text, { test: true }, fetch, target);
		return r.ok ? { ok: `Test sent. ${r.message}` } : fail(502, { error: r.message });
	},
	resolve: async ({ params, request, locals }) => {
		const n = closeAlerts((await request.formData()).getAll('id').map(Number), 'resolved', who(locals), [Number(params.id)]);
		return { ok: n ? 'Resolved.' : 'Nothing to resolve.' };
	},
	dismiss: async ({ params, request, locals }) => {
		const n = closeAlerts((await request.formData()).getAll('id').map(Number), 'dismissed', who(locals), [Number(params.id)]);
		return { ok: n ? 'Dismissed.' : 'Nothing to dismiss.' };
	},
	reopen: async ({ params, request }) => {
		return reopenAlert(Number((await request.formData()).get('id')), [Number(params.id)]) ? { ok: 'Back on the open list.' } : fail(400, { error: 'That alert has ended, so there is nothing to reopen.' });
	},
	check: async ({ params }) => {
		if (config.readOnly) return fail(403, { error: 'READ_ONLY=1: checks that may send webhooks are off.' });
		const r = await runAlertRules({ siteIds: [Number(params.id)] });
		return { ok: `Checked ${r.checked} rules: ${r.opened} new alert${r.opened === 1 ? '' : 's'}.` };
	}
};
