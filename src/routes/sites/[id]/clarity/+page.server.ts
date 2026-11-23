import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { config } from '$lib/server/config';
import { getSite } from '$lib/server/clients';
import { linksFor } from '$lib/server/links';
import { callsLeft, type ClarityMetric } from '$lib/server/clarity';
import { checkClarityNow, clarityInstallFor, storedClarityScan } from '$lib/server/clarityscan';
import { hasGtmWrite, installClarityViaGtm, planClarityInstall } from '$lib/server/gtmwrite';
import { enqueueLinkSync } from '$lib/server/jobs';
import { clarityByDimension, clarityDashboardUrl } from '$lib/claritydims';
import { clarityPages } from '$lib/pageinsights';

/** Is Clarity's script on the pages, and can SEOConsole add it through Tag Manager? Shown whether or not a token is connected. */
function installState(siteId: number) {
	const gtm = linksFor(siteId).gtm;
	const acc = gtm?.account_id ? (db().prepare('SELECT email, scopes, is_demo FROM accounts WHERE id = ?').get(gtm.account_id) as { email: string; scopes: string; is_demo: number } | undefined) : undefined;
	const scan = storedClarityScan(siteId);
	return {
		install: clarityInstallFor(siteId),
		scan: scan ? { checkedAt: scan.checkedAt, pages: scan.pages } : null,
		gtm: gtm ? { label: gtm.label ?? gtm.external_id, canWrite: !!acc && hasGtmWrite(acc), account: acc?.email ?? null } : null,
		readOnly: config.readOnly
	};
}

export const load: PageServerLoad = ({ params }) => {
	const site = getSite(Number(params.id))!;
	const link = linksFor(site.id).clarity;
	const install = installState(site.id);
	if (!link) return { linked: false as const, ...install };
	const d = db();
	const snap = (dim: string) => {
		const r = d.prepare('SELECT day, payload FROM clarity_snapshots WHERE site_id = ? AND dimension = ? ORDER BY day DESC LIMIT 1').get(site.id, dim) as { day: string; payload: string } | undefined;
		return r ? { day: r.day, metrics: JSON.parse(r.payload) as ClarityMetric[] } : null;
	};
	// Sessions per stored day (Clarity only exposes 1-3 days, so history exists only because we keep it).
	const history = (d.prepare("SELECT day, payload FROM clarity_snapshots WHERE site_id = ? AND dimension = '' ORDER BY day DESC LIMIT 60").all(site.id) as { day: string; payload: string }[])
		.map((r) => {
			const traffic = (JSON.parse(r.payload) as ClarityMetric[]).find((m) => m.metricName === 'Traffic')?.information ?? [];
			const sum = (k: string) => traffic.reduce((a, x) => a + Number(x[k] ?? 0), 0);
			return { day: r.day, sessions: sum('totalSessionCount'), botSessions: sum('totalBotSessionCount'), users: sum('distinctUserCount') || sum('distantUserCount') };
		})
		.reverse();
	const totals = snap('');
	const byUrl = snap('URL');
	const byChannel = snap('Channel');
	// The pages where the most sessions hit rage or dead clicks: the ones worth watching in Clarity's recordings.
	const frustrated = byUrl
		? clarityPages(byUrl.metrics)
				.filter((p) => (p.sessions ?? 0) > 0 && ((p.rageClicks ?? 0) > 0 || (p.deadClicks ?? 0) > 0))
				.map((p) => ({ url: p.url, sessions: p.sessions ?? 0, rageClicks: p.rageClicks ?? 0, deadClicks: p.deadClicks ?? 0, frustration: ((p.rageClicks ?? 0) + (p.deadClicks ?? 0)) / (p.sessions || 1) }))
				.sort((a, b) => b.frustration - a.frustration)
				.slice(0, 10)
		: [];
	return {
		linked: true as const,
		...install,
		clarityUrl: clarityDashboardUrl(install.install.ids[0]),
		channels: byChannel ? { day: byChannel.day, rows: clarityByDimension(byChannel.metrics, 'Channel') } : null,
		devices: (() => {
			const dev = snap('Device');
			return dev ? { day: dev.day, rows: clarityByDimension(dev.metrics, 'Device') } : null;
		})(),
		frustrated,
		status: { state: link.sync_status, message: link.sync_message, lastSync: link.last_sync_at },
		callsLeft: callsLeft(link.integration_id!),
		totals,
		byUrl,
		byDevice: snap('Device'),
		history
	};
};

export const actions: Actions = {
	/** Fetch the home page and the two biggest pages now and look for Clarity. */
	check: async ({ params }) => {
		await checkClarityNow(Number(params.id));
		return { checked: true };
	},
	/** Show exactly what would be added to Tag Manager; changes nothing. */
	plan: async ({ params, request }) => {
		const project = String((await request.formData()).get('project') ?? '');
		const plan = await planClarityInstall(Number(params.id), project).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
		if (!plan.ok) return fail(400, { plan, project });
		return { plan, project };
	},
	/** The confirmed change: a new workspace with the Clarity tag, published only if asked and safe. */
	install: async ({ params, request }) => {
		const f = await request.formData();
		const project = String(f.get('project') ?? '');
		const mode = f.get('mode') === 'publish' ? 'publish' : 'workspace';
		const siteId = Number(params.id);
		const result = await installClarityViaGtm(siteId, project, mode);
		if (!result.ok) return fail(400, { result, project });
		// Re-read the container (and then the pages) so the status above catches up.
		enqueueLinkSync(siteId, 'gtm');
		return { result, project };
	}
};
