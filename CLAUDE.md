# Notes for Claude

## Production
- **Production runs on [Openship](https://openship.io)** (a self-hosted deployment platform), deployed by the owner from this repository's `main` branch.
- **Merging to `main` does not deploy by itself** (push-to-deploy was not switched on as of 2026-11-20). After a merge, the owner redeploys from the Openship dashboard, unless an Openship connector is available in the session; check before saying something is live.
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
