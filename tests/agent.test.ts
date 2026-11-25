import { beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { actionsFor, actionStates } from '../src/lib/server/actions';
import { agentTools, decideProposal, dueSites, listProposals, listRuns, MAX_PROPOSALS_PER_RUN, pickSpecialists, PROPOSABLE, runAgent, runDueAgents, setAgentEnabled, SPECIALISTS, specialistOf } from '../src/lib/server/agent';
import { toolCatalog } from '../src/lib/server/mcp';
import type { ModelCall } from '../src/lib/server/chat';
import type { CurrentUser } from '../src/lib/server/roles';
import { agentStatus } from '../src/lib/server/agentstatus';

const owner: CurrentUser = { id: null, email: null, name: 'Owner', role: 'owner', siteIds: null };
const viewer: CurrentUser = { id: 7, email: 'v@example.com', name: 'Viewer', role: 'viewer', siteIds: null };

/** A scripted model: each call returns the next step; it records what it was sent. */
function scripted(steps: ((p: { messages: unknown[] }) => { content: unknown[]; stop_reason: string })[]) {
	const seen: { messages: unknown[]; tools: { name: string }[] }[] = [];
	let i = 0;
	const call: ModelCall = async (params) => {
		seen.push({ messages: JSON.parse(JSON.stringify(params.messages)), tools: params.tools as { name: string }[] });
		const s = steps[Math.min(i++, steps.length - 1)]({ messages: params.messages as unknown[] });
		return { id: `m${i}`, type: 'message', role: 'assistant', model: 'test', content: s.content, stop_reason: s.stop_reason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } } as never;
	};
	return { call, seen };
}

beforeAll(async () => {
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
	const client = new DemoClient('demo-a');
	let guard = 0;
	await syncSite(1, { client, backfillChunkDays: 120 });
	while (!getSite(1)!.backfill_done && guard++ < 12) await syncSite(1, { client, backfillChunkDays: 120 });
}, 180_000);

describe('what the agent is offered', () => {
	it('reads, plus changes marked as proposals; never live-quota reads, deletes or tracking writes', () => {
		const names = agentTools().map((t) => t.name);
		expect(names).toContain('get_action_queue');
		expect(names).toContain('mark_action');
		expect(agentTools().find((t) => t.name === 'mark_action')!.description).toMatch(/^\(proposal/);
		for (const n of ['inspect_url', 'delete_sitemap', 'cancel_indexing_queue', 'setup_google_tag', 'track_key_event', 'set_brand_terms', 'verify_site_ownership']) expect(names).not.toContain(n);
		for (const p of PROPOSABLE) expect(names).toContain(p);
	});
});

describe('a run', () => {
	it('reads with tools, queues a change instead of making it, and stores the brief', async () => {
		const key = actionsFor(getSite(1)!)[0].key;
		const { call, seen } = scripted([
			() => ({ stop_reason: 'tool_use', content: [
				{ type: 'tool_use', id: 't1', name: 'get_action_queue', input: { site: '1', limit: 3 } },
				{ type: 'tool_use', id: 't2', name: 'mark_action', input: { site: '2', key, state: 'done', reason: 'Fixed yesterday.' } }
			] }),
			() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '**Headline.** All fine.\n\n- Proposals: 1' }] })
		]);
		const r = await runAgent(1, { trigger: 'manual', call });
		expect(r.status).toBe('done');
		expect(r.proposals).toBe(1);
		// The read ran and its answer went back to the model; the change did not run.
		const second = JSON.stringify(seen[1].messages);
		expect(second).toContain('openItems');
		expect(second).toContain('has NOT run');
		expect(actionStates(1).has(key)).toBe(false);
		const [p] = listProposals(null);
		expect(p.tool).toBe('mark_action');
		expect(p.args.site).toBe('1'); // pinned to the run's site, whatever the model wrote
		expect(p.args.reason).toBeUndefined();
		expect(p.reason).toBe('Fixed yesterday.');
		expect(listRuns(null)[0].brief).toContain('Headline');
	});

	it('remembers yesterday: the next run sees the last brief and what happened to its proposals', async () => {
		const { call, seen } = scripted([() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Day two.' }] })]);
		await runAgent(1, { call });
		const first = JSON.stringify(seen[0].messages);
		expect(first).toContain('Your previous brief');
		expect(first).toContain('mark_action: pending');
	});

	it('caps proposals per run', async () => {
		const many = Array.from({ length: MAX_PROPOSALS_PER_RUN + 2 }, (_, i) => ({ type: 'tool_use', id: `p${i}`, name: 'log_change', input: { site: '1', date: '2026-01-01', title: `c${i}` } }));
		const { call } = scripted([() => ({ stop_reason: 'tool_use', content: many }), () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] })]);
		const r = await runAgent(1, { call });
		expect(r.proposals).toBe(MAX_PROPOSALS_PER_RUN);
	});
});

describe('approving', () => {
	it('a viewer cannot run a proposal; a declined one is not run; an approved one runs as the approver', async () => {
		const pending = listProposals(null).filter((p) => p.tool === 'mark_action');
		const p = pending[0];
		expect((await decideProposal(viewer, p.id, true)).ok).toBe(false);
		expect(listProposals(null).some((x) => x.id === p.id)).toBe(true); // still waiting
		const r = await decideProposal(owner, p.id, true);
		expect(r.ok).toBe(true);
		expect(actionStates(1).get(String(p.args.key))?.state).toBe('done');
		expect((await decideProposal(owner, p.id, true)).ok).toBe(false); // not twice
		const other = listProposals(null)[0];
		expect((await decideProposal(owner, other.id, false)).ok).toBe(true);
		expect(listProposals(null, 'all').find((x) => x.id === other.id)!.status).toBe('declined');
	});
});

describe('specialists', () => {
	it('every tool a specialist names exists, and its proposals are proposable', () => {
		const names = new Set(toolCatalog().map((t) => t.name));
		for (const sp of SPECIALISTS) {
			for (const t of sp.reads) expect(names.has(t), `${sp.key} reads ${t}`).toBe(true);
			for (const t of sp.proposals) expect(PROPOSABLE.has(t), `${sp.key} proposes ${t}`).toBe(true);
		}
	});
	it('a specialist is offered only its own tools', () => {
		const tech = agentTools(specialistOf('technical'));
		const names = tech.map((t) => t.name);
		expect(names).toContain('get_indexing_status');
		expect(names).toContain('submit_sitemap');
		expect(names).not.toContain('create_content_brief');
		expect(names).not.toContain('get_drop_diagnosis');
		expect(agentTools(specialistOf('keyword')).map((t) => t.name)).toContain('create_content_brief');
	});
	it('picks by open findings (blocking weigh more), alerts and AI tracking; Performance on a quiet day', () => {
		expect(pickSpecialists([], { max: 2 })).toEqual(['performance']);
		expect(pickSpecialists([{ type: 'striking', blocking: false }, { type: 'striking', blocking: false }, { type: 'robots', blocking: true }], { max: 2 })).toEqual(['technical', 'keyword']);
		expect(pickSpecialists([{ type: 'decay', blocking: false }], { openAlerts: 1, max: 1 })).toEqual(['performance']);
		expect(pickSpecialists([], { aiTracked: true, max: 3 })).toEqual(['geo']);
	});
	it('a specialist run stays in its lane and remembers its own previous brief', async () => {
		const { call, seen } = scripted([
			() => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x1', name: 'get_drop_diagnosis', input: { site: '1' } }] }),
			() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Technical: all clear.' }] })
		]);
		const r = await runAgent(1, { call, specialist: 'technical' });
		expect(r.status).toBe('done');
		expect(JSON.stringify(seen[1].messages)).toContain('belongs to another specialist');
		expect(String((seen[0] as unknown as { messages: unknown[] }).messages[0] && JSON.stringify(seen[0].messages))).not.toContain('Technical: all clear');
		expect(listRuns(null)[0].specialist).toBe('Technical');
		const again = scripted([() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Technical: day two.' }] })]);
		await runAgent(1, { call: again.call, specialist: 'technical' });
		expect(JSON.stringify(again.seen[0].messages)).toContain('Technical: all clear.');
	});
	it('the daily run gives each due site its picked specialists', async () => {
		setAgentEnabled(true);
		const { call } = scripted([() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] })]);
		const out = await runDueAgents({ call, now: Date.UTC(2031, 0, 3, 9, 0) });
		setAgentEnabled(false);
		expect(out.length).toBeGreaterThan(0);
		expect(out.every((r) => r.status === 'done' || r.status === 'skipped')).toBe(true);
	});
});

describe('status for agents (get_connections)', () => {
	it('says whether it is on, the budget, recent runs and proposals waiting, only for the given sites', () => {
		setAgentEnabled(true);
		const st = agentStatus([1]);
		expect(st.on).toBe(true);
		expect(st.lastRuns.length).toBeGreaterThan(0);
		expect(st.lastRuns[0].site).toBeTruthy();
		expect(st.nextScheduledStart).toMatch(/T\d\d:00:00/);
		expect(agentStatus([999]).lastRuns).toEqual([]);
		expect(agentStatus([999]).proposalsWaiting).toBe(0);
		setAgentEnabled(false);
		expect(agentStatus([1]).nextScheduledStart).toBeNull();
	});
});

describe('the schedule', () => {
	it('runs nothing while off, and each site once a day from the set hour when on', () => {
		const morning = Date.UTC(2030, 0, 2, 9, 0);
		setAgentEnabled(false);
		expect(dueSites(morning)).toEqual([]);
		setAgentEnabled(true);
		expect(dueSites(Date.UTC(2030, 0, 2, 2, 0))).toEqual([]); // before AGENT_HOUR_UTC
		expect(dueSites(morning).length).toBeGreaterThan(0);
		setAgentEnabled(false);
	});
});
