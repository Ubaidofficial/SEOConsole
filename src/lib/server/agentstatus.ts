/**
 * The in-app agent's switch, budget and status, apart from the agent itself (src/lib/server/agent.ts), so the tool layer can report
 * them without importing the chat and the model client.
 */
import { db } from './db';
import { env } from './config';
import { chatSetupProblem } from './chatconfig';
import { displayName } from './clients';
import { allSites } from './queries';

const KV_ON = 'agent_enabled';
export const agentEnabled = () => (db().prepare('SELECT value FROM kv WHERE key = ?').get(KV_ON) as { value: string } | undefined)?.value === '1';
export const setAgentEnabled = (on: boolean) => void db().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(KV_ON, on ? '1' : '0');

const intEnv = (name: string, def: number, min: number, max: number) => {
	const n = Number(env(name, String(def)));
	return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def;
};
export const agentRunsPerDay = () => intEnv('AGENT_RUNS_PER_DAY', 10, 0, 200);
export const agentMaxRounds = () => intEnv('AGENT_MAX_ROUNDS', 14, 2, 40);
/** The UTC hour from which the daily runs start (default 5: after the night's syncs, early morning in Europe). */
export const agentHourUtc = () => intEnv('AGENT_HOUR_UTC', 5, 0, 23);

const dayStart = (now: number) => Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
/** Runs started today (UTC day), across all sites: the daily budget. */
export const runsToday = (now = Date.now()) => (db().prepare('SELECT COUNT(*) n FROM agent_runs WHERE started_at >= ?').get(dayStart(now)) as { n: number }).n;

/** What an agent (MCP) or a person may see of the agent, for the given sites: on or off, why it cannot run, budget, last runs, proposals waiting. */
export function agentStatus(siteIds: number[], now = Date.now()) {
	const ids = new Set(siteIds);
	const names = new Map(allSites({ includeHidden: true }).map((s) => [s.id, displayName(s.site_url)]));
	const last = (db().prepare('SELECT site_id, started_at, status, error, rounds, tool_calls FROM agent_runs ORDER BY started_at DESC LIMIT 50').all() as { site_id: number; started_at: number; status: string; error: string | null; rounds: number; tool_calls: number }[])
		.filter((r) => ids.has(r.site_id))
		.slice(0, 5);
	const pending = (db().prepare("SELECT site_id FROM agent_proposals WHERE status = 'pending'").all() as { site_id: number }[]).filter((r) => ids.has(r.site_id)).length;
	const hour = agentHourUtc();
	const next = new Date(dayStart(now) + hour * 3600_000);
	if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
	return {
		on: agentEnabled(),
		cannotRun: chatSetupProblem(),
		dailyRunsFrom: `${String(hour).padStart(2, '0')}:00 UTC`,
		nextScheduledStart: agentEnabled() ? next.toISOString() : null,
		runsToday: runsToday(now),
		runsPerDay: agentRunsPerDay(),
		proposalsWaiting: pending,
		lastRuns: last.map((r) => ({ site: names.get(r.site_id) ?? String(r.site_id), at: new Date(r.started_at).toISOString(), status: r.status, modelCalls: r.rounds, toolCalls: r.tool_calls, ...(r.error ? { error: r.error.slice(0, 200) } : {}) }))
	};
}
