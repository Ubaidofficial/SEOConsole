import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { alertTrends, closeAlerts, listAlerts, reopenAlert, runAlertRules } from '$lib/server/alerts';
import { requireRole } from '$lib/server/roles';
import { config } from '$lib/server/config';

/** Every alert on the sites this person may see: open ones first (problems before good news), then the recently closed. */
export const load: PageServerLoad = ({ locals, url }) => {
	const scope = locals.user?.siteIds ?? null;
	const show = url.searchParams.get('show') === 'closed' ? 'closed' : 'open';
	const site = Number(url.searchParams.get('site')) || undefined;
	const alerts = listAlerts({ siteIds: scope, status: show, siteId: site, limit: 300 });
	const all = listAlerts({ siteIds: scope, status: 'all', limit: 2000 });
	const sites = [...new Map(all.map((a) => [a.siteId, a.site])).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
	return { alerts, trends: alertTrends(alerts), show, site: site ?? null, sites, counts: { open: all.filter((a) => a.status === 'open').length, closed: all.filter((a) => a.status !== 'open').length } };
};

const ids = async (request: Request) => (await request.formData()).getAll('id').map(Number).filter((n) => n > 0);
const who = (locals: App.Locals) => locals.user?.email ?? locals.user?.name ?? 'owner';

export const actions: Actions = {
	resolve: async ({ request, locals }) => {
		const u = requireRole(locals, 'editor');
		const n = closeAlerts(await ids(request), 'resolved', who(locals), u.siteIds);
		return { ok: n ? `Resolved ${n} alert${n === 1 ? '' : 's'}.` : 'Nothing to resolve.' };
	},
	dismiss: async ({ request, locals }) => {
		const u = requireRole(locals, 'editor');
		const n = closeAlerts(await ids(request), 'dismissed', who(locals), u.siteIds);
		return { ok: n ? `Dismissed ${n} alert${n === 1 ? '' : 's'}.` : 'Nothing to dismiss.' };
	},
	reopen: async ({ request, locals }) => {
		const u = requireRole(locals, 'editor');
		const [id] = await ids(request);
		return reopenAlert(id, u.siteIds) ? { ok: 'Back on the open list.' } : fail(400, { error: 'That alert has ended, so there is nothing to reopen.' });
	},
	/** Run the rules now instead of waiting for the hourly check (only this person's sites). */
	check: async ({ locals }) => {
		const u = requireRole(locals, 'editor');
		if (config.readOnly) return fail(403, { error: 'READ_ONLY=1: checks that may send webhooks are off.' });
		const r = await runAlertRules(u.siteIds ? { siteIds: u.siteIds } : {});
		return { ok: `Checked ${r.checked} rules: ${r.opened} new alert${r.opened === 1 ? '' : 's'}.` };
	}
};
