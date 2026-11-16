# Configuration

Every environment variable.

[Back to the README](../README.md)

## Environment variables

All are optional except where noted; copy `.env.example` to `.env`. On Cloudflare they are Worker secrets or variables instead.

| Variable | Meaning |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client (not needed in demo mode). |
| `ORIGIN` | Public address of the app; builds the OAuth redirect URI. |
| `APP_SECRET` | 32+ random characters; encrypts OAuth tokens at rest. If unset, a key is generated next to the database. **Required on Cloudflare**, where the disk is wiped. |
| `ADMIN_PASSWORD` | The owner's password (the owner can do everything; team members are invited from the Team page and have their own). Required before any non-local access, and before anyone can be invited. Changing it signs everyone out, team members included. |
| `ADMIN_PASSWORD_HASH` | Instead of `ADMIN_PASSWORD`: a scrypt hash (`pnpm hash-password`), so the password itself is never stored. Wins if both are set. |
| `OAUTH_REDIRECT_URI` | Hosted plan only: the one shared Google redirect address (the control app's `/oauth/callback`). Leave empty for a normal install. |
| `DEMO_MODE=1` | Synthetic data, no Google credentials. |
| `DB_PATH` | SQLite file (default `./data/opensiteconsole.db`). |
| `GOOGLE_INCLUDE_GA4`, `GOOGLE_INCLUDE_GTM` | Ask for GA4 / read-only Tag Manager access in the same consent (default 1). |
| `BING_CLIENT_ID`, `BING_CLIENT_SECRET` | One-click Bing sign-in; otherwise paste a Bing API key. |
| `INDEX_MONITOR_URLS` | URLs the indexing monitor inspects per run (default 40, max 200). |
| `MOZ_DA_EVERY_DAYS`, `MOZ_MONTHLY_ROWS` | How often each site's Moz Domain Authority is refreshed (default 30 days, 7 to 90) and the most Moz API rows the app spends in a calendar month (default 40; Moz limits plans by rows, so check yours; this uses Moz's older Access ID and Secret Key API, which a new Moz account may not be able to get). The credentials are added on the Connect page. |
| `AHREFS_DR_VERSION` | Which Domain Rating version to ask Ahrefs for: `dr3` (default) or `dr4`. The key itself is added on the Connect page, not here. |
| `BACKUP=0` | Turn off the daily database backup. By default the app writes a checked copy of its database once a day to a `backups` folder next to it (`opensiteconsole-YYYY-MM-DD.db`, SQLite's own backup call, readable by the app's user only) and keeps the newest 3. It guards against a bad change or a damaged file, **not** against losing the disk, so copy that folder off the machine too. Off in demo mode, and set off in the Cloudflare image, which has Litestream. A failure is written to the audit log and, if `DIGEST_WEBHOOK_URL` is set, sent to the webhook once a day. |
| `BACKUP_DIR`, `BACKUP_KEEP` | Where the copies go (default: `backups` beside the database) and how many to keep (default 3, 1 to 30; each is a full copy of the database). |
| `ONPAGE_ALLOW_PRIVATE=1` | Let on-page checks reach private addresses (only if your site lives on your own network). |
| `SITE_ICONS=0` | Turn off site logos. By default the dashboard and site header show each site's own favicon: your server fetches it from the site's own host (never a third-party favicon service, and never from a CDN on another host), caches it for a week (an hour when there is none) and falls back to the letter avatar. Off by default in demo mode (demo domains are fake) unless `SITE_ICONS=1`. Private addresses are refused as for on-page checks (`ONPAGE_ALLOW_PRIVATE=1` lifts that). |
| `LINK_CRAWL_PAGES` | Pages the internal-link crawl fetches per site (default 60, max 500): the ones with the most impressions in the last 90 days. |
| `OWNER_GOOGLE_EMAILS` | Google addresses (comma separated) that sign in as the **owner** with "Continue with Google". The owner is not a team member, so this is the only way to say who. Matched by the address Google has verified. A team member cannot have one of these addresses. |
| `GOOGLE_LOGIN=0` | Hide "Continue with Google" and refuse `/login/google`. On by default when there is a login password and a Google client; always off on the hosted plan. |
| `READ_ONLY=1` | Read-only Google scope and write actions disabled. This includes the Tag Manager and Google Analytics write permissions behind **Set up GA4 & Tag Manager** and the Clarity install: they are never requested, and the plans refuse. |
| `MAX_ROWS_PER_DAY` | Per-day row cap in the warehouse (default 100,000). |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY` | AI answers: the assistants to ask (each optional; none set, nothing runs). Billed to your accounts. `ANTHROPIC_API_KEY` also switches on the *Ask* chat. |
| `CHAT_PROVIDER` | The *Ask* chat's **default provider**: `anthropic` (default, Claude), `openai`, `gemini`, `deepseek`, `kimi`, `openrouter`, `groq`, `mistral`, `xai`, or `custom` (any OpenAI-compatible server at `CHAT_BASE_URL`). Each one other than `custom` has a built-in address and reads its own key: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY` (or `KIMI_API_KEY`), `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`; for the default provider `CHAT_API_KEY` also works. `openai` together with `CHAT_BASE_URL` is read as `custom`. An unknown value leaves chat off and says so. The addresses are written from memory of each provider's documentation and not checked today: if one is wrong, use `custom` with the right address. |
| `CHAT_PROVIDERS` | More providers people can **pick in the chat**, comma separated (for example `anthropic,gemini,kimi`), each shown only when its own key is set. Opt in on purpose: a key that exists for another feature (say `OPENAI_API_KEY` for AI answers) does not put that provider in the chat. The privacy page names every provider switched on. |
| `CHAT_MODEL`, `CHAT_MODEL_<PROVIDER>`, `CHAT_EFFORT`, `CHAT_MESSAGES_PER_DAY` | The model: `CHAT_MODEL` for the default provider, `CHAT_MODEL_GEMINI`, `CHAT_MODEL_DEEPSEEK` and so on for any. Claude defaults to `claude-opus-5-5`; for the rest, when none is set, the chat's model menu lists what the provider itself offers (asked live, kept ten minutes) and people choose. `CHAT_EFFORT` (`low` to `max`, default `medium`) is Claude only. `CHAT_MESSAGES_PER_DAY` is the messages each person may send a day (default 50; `0` turns chat off for everyone). |
| `CHAT_LOCK_MODEL=1` | Nobody picks: everyone gets the default provider and its model, and the menus are hidden. Use it to control cost, since otherwise anyone signed in can pick any model your keys can use. |
| `CHAT_BASE_URL`, `CHAT_API_KEY`, `CHAT_MAX_TOKENS` | For `custom` (or the default provider): the base address up to its version segment (for example `https://api.example.com/v1`), the key (optional for a local server such as Ollama), and the most tokens one answer may use (default 8192, a limit most providers accept; raise it only if yours allows more). |
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | AI answers through DataForSEO instead of (or besides) the keys above: ChatGPT and Gemini as seen in their apps, Claude and Perplexity when you have no key for them. `AI_VIS_SOURCE` = `auto` (default), `direct` or `dataforseo`. |
| `AI_VIS_LOCATION_CODE`, `AI_VIS_LANGUAGE_CODE`, `AI_VIS_COUNTRY`, `AI_VIS_DFS_CLAUDE_MODEL`, `AI_VIS_DFS_PERPLEXITY_MODEL` | DataForSEO settings: where the apps are asked from (default 2840 = United States, `en`), the country for API web search (default `US`), and its model names (defaults `claude-opus-5`, `sonar`). |
| `AI_VIS_RUNS_PER_DAY`, `AI_VIS_EVERY_DAYS` | AI answers: runs a day across all sites (default 60, max 2000) and days between re-asking a prompt (default 7). |
| `AI_VIS_CLAUDE_MODEL`, `AI_VIS_CLAUDE_EFFORT`, `AI_VIS_OPENAI_MODEL`, `AI_VIS_PERPLEXITY_MODEL` | AI answers: the models used (defaults `claude-opus-5-5`, `medium`, `gpt-6-astra`, `sonar`). |
| `DIGEST_MONTHLY` | `0` stops the automatic monthly report (default on; it can still be made by hand on the Digest page). |
| `DIGEST_WEBHOOK_URL`, `DIGEST_WEBHOOK_FORMAT`, `DIGEST_DAY` | Weekly digest and urgent alerts: https webhook, `slack` (default) / `discord` / `json`, weekday 0-6 (default 1 = Monday). No email. |
| `MCP_OAUTH_REDIRECTS` | Extra callback addresses an MCP client may register for "Sign in" (comma-separated, exact, https only). Claude's own is built in. Leave empty unless you connect another client. |
| `MCP_INSPECT_PER_KEY_DAY` | Live URL inspections one API key may cause per day through `inspect_url` (default 100, max 2000; Google allows about 2,000 a day per property). |
| `INDEX_RECHECK_PER_RUN` | URLs the automatic day 1 / 3 / 5 re-checks inspect per site per run (default 40, max 200). They share Google's URL Inspection quota with the indexing monitor. |
| `REQUEST_INDEXING_PER_DAY` | Pages the Request tab lists per site per day, and the allowance it counts what you asked against (default 10, max 50). Google does not publish its limit; third-party sources say about 10 to 12 a day, which is unverified. |
| `COMPARE_HOSTED_PRICE` | The sentence about the hosted plan's price on the public `/compare` pages (default: "$9 a month, $29 with the advanced indexing features, launch price $19"). Say what is true for your hosting. |
| `LEGAL_ENTITY`, `LEGAL_CONTACT_EMAIL`, `LEGAL_GOVERNING_LAW`, `LEGAL_UPDATED` | Who the public privacy policy (`/privacy`) and terms (`/terms`) speak for. Until the first two are set the pages say "the operator of this SEOConsole installation" and signed-in users see a reminder. The texts are a starting point, not legal advice: have them reviewed before relying on them (for example for Google's OAuth verification). |
| `MCP_SUBMIT_PER_KEY_DAY` | URLs one API key with the submit permission may push to search engines per day, UTC (default 200, max 10,000). |
| `GOOGLE_INCLUDE_INDEXING=1` | Ask for Google's Indexing API permission on new Google connections and allow that channel. Google documents the API for **job-posting and livestream pages only**: every other page is refused. `INDEXING_API_MAX_PER_DAY` caps notifications per site per day (default 200, the quota as I understand it; verify it). |
| `GOOGLE_INCLUDE_SITE_VERIFICATION=1` | Ask for the Site Verification permission, so a site can be proven and added from the Accounts page or over MCP. |
| `INDEXNOW_ENDPOINT`, `INDEXNOW_MAX_PER_DAY` | IndexNow endpoint (https) and URLs per site per day (default 1000). |
