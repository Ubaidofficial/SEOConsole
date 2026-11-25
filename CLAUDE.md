# Notes for Claude

## Production
- **Production runs on [Openship](https://openship.io)** (a self-hosted deployment platform), deployed by the owner from this repository's `main` branch.
- **Merging to `main` does not deploy by itself** (push-to-deploy was not switched on as of 2026-11-20). After a merge, the owner redeploys from the Openship dashboard, unless an Openship connector is available in the session; check before saying something is live.
- **Auto-merge and deploy workflows** (`.github/workflows/auto-merge.yml`, `deploy.yml`, added 2026-11-25): a `claude/*` pull request opened by the owner is merged once CI passes on its head commit (not drafts, not ones labelled `hold`). Deploy asks Openship's API to deploy main, but only when the `OPENSHIP_URL`, `OPENSHIP_TOKEN` and `OPENSHIP_PROJECT` secrets are set; Openship's own Auto Deploy toggle (Source tab) is the alternative. Whether either is switched on is the owner's setting: still check production before saying something is live. Pull requests from unattended (scheduled) agent sessions use a `claude/agent-…` branch or the `agent-proposed` label and are **never auto-merged**: a person reviews and merges them.
- Production is **not** on Railway or Cloudflare. The Cloudflare account only holds OpenSEO and other projects; `wrangler.jsonc` and `deploy/coolify/` are alternative targets, not what runs.
- To confirm a deploy is live, call a tool on the SEOConsole connector (it talks to the production instance) and look for something only the new code returns.

## Before pushing
CI (`.github/workflows/ci.yml`) runs these on every pull request and on `main`:
```bash
pnpm check
```
```bash
pnpm test
```
```bash
pnpm build
```

Repository-specific tests that are easy to trip over:
- **Every new form action needs a role** in `FORM_ACTIONS` (`src/lib/server/roles.ts`), or `tests/team.test.ts` fails.
- **A new light-theme CSS variable** must also be defined for the dim theme, or be a `var(--…)` alias listed in `tests/theme.test.ts`.
- **No visible paragraph over 45 words** (`tests/text-density.test.ts`): fold longer text into the `Explainer` component or a `<details>`.

Schema changes go in `src/lib/server/db.ts`: new tables as `CREATE TABLE IF NOT EXISTS`, new columns in `migrate()` with `ALTER TABLE`, so existing databases upgrade on start.
