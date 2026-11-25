import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { agentEnabled, agentHourUtc, agentMaxRounds, agentRunsPerDay, decideProposal, listProposals, listRuns, runAgent, runsToday, setAgentEnabled, SPECIALISTS, specialistOf, specialistsFor, specialistsPerSite } from '$lib/server/agent';
import { chatSetupProblem } from '$lib/server/chatconfig';
import { allSites } from '$lib/server/queries';
import { displayName } from '$lib/server/clients';
import { renderMarkdown } from '$lib/markdown';
import { audit } from '$lib/server/db';
import { intParam } from '$lib/server/params';

export const load: PageServerLoad = ({ locals }) => {
	const user = locals.user!;
	const scope = user.siteIds;
	return {
		enabled: agentEnabled(),
		setupProblem: chatSetupProblem(),
		budget: { perDay: agentRunsPerDay(), usedToday: runsToday(), maxRounds: agentMaxRounds(), hourUtc: agentHourUtc(), perSite: specialistsPerSite() },
		specialists: SPECIALISTS.map((x) => ({ key: x.key, name: x.name, focus: x.focus.split('.')[0] })),
		sites: allSites().filter((s) => !scope || scope.includes(s.id)).map((s) => ({ id: s.id, name: displayName(s.site_url), today: specialistsFor(s.id).map((k) => specialistOf(k)!.name) })),
		proposals: listProposals(scope, 'pending'),
		decided: listProposals(scope, 'all', 60).filter((p) => p.status !== 'pending'),
		// The brief is model output: rendered by the escaping Markdown renderer, which only ever produces its own tags.
		runs: listRuns(scope, 30).map((r) => ({ ...r, html: r.brief ? renderMarkdown(r.brief) : null }))
	};
};

export const actions: Actions = {
	toggle: async ({ request }) => {
		const on = (await request.formData()).get('on') === '1';
		setAgentEnabled(on);
		audit(on ? 'agent.enabled' : 'agent.disabled');
		return { ok: on ? 'The agent is on: each site gets a brief once a day.' : 'The agent is off.' };
	},
	run: async ({ request }) => {
		const f = await request.formData();
		const siteId = intParam(f.get('siteId'));
		const which = String(f.get('specialist') ?? 'auto');
		// auto: the specialists the daily run would pick for this site today; all-round: the generalist; else that one specialist.
		const keys = which === 'auto' ? specialistsFor(siteId) : which === 'all' ? [null] : specialistOf(which) ? [specialistOf(which)!.key] : [];
		if (!keys.length) return fail(400, { error: 'Unknown specialist.' });
		let proposals = 0;
		const done: string[] = [];
		for (const k of keys) {
			const r = await runAgent(siteId, { trigger: 'manual', specialist: k });
			if (r.status !== 'done') return fail(400, { error: `${k ? specialistOf(k)!.name : 'All-round'}: ${r.message}` });
			proposals += r.proposals;
			done.push(k ? specialistOf(k)!.name : 'All-round');
		}
		return { ok: `${done.join(' and ')} brief${done.length > 1 ? 's' : ''} written${proposals ? `, with ${proposals} proposal(s) to review` : ''}.` };
	},
	approve: async ({ request, locals }) => {
		const r = await decideProposal(locals.user!, intParam((await request.formData()).get('id')), true);
		return r.ok ? { ok: r.message } : fail(400, { error: r.message });
	},
	decline: async ({ request, locals }) => {
		const r = await decideProposal(locals.user!, intParam((await request.formData()).get('id')), false);
		return r.ok ? { ok: r.message } : fail(400, { error: r.message });
	}
};
