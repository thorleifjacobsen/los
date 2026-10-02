# CLAUDE.md — los

*los* (Norwegian: harbour pilot) is a personal AI assistant shaped like a chat app: a **team** of agents (Los 🧭,
Mira 🔎, Finn 🛠️, Vera 📬, Ollie 👁️ the image analyst and design reviewer, Kai 💡 the opportunity scout), each just a **name, a personality and a brain**, and **chats** with them. Los answers a
chat unless someone is @mentioned; `@mira` (or `@team` for everyone) brings others in, and agents bring each other in
the same way, visibly, in the chat (a "handoff"). Several agents can work in one chat at once; you can write to one
while it works. Agents remember you (memories in every prompt) and set up **jobs** (cron) and **tasks** (later) that
**report back** into the chat. A shared **workspace** folder holds files for everyone, shown in chat via `/files/<path>`.
One protocol for every brain. It started from the `hjelper` tarball (CLI-only); UI, brains, login and Docker were
added here. Installing on another machine: `INSTALL.md`.

Read `README.md` for the original design ("the five ideas") and `src/types.ts` for the whole vocabulary.

## Deployment (this box)

- **Single deployment** in `/var/www/los`, with no dev/prod split, by choice (an exception to `/var/www/CLAUDE.md`).
- **Containers** (`docker-compose.yml`, on their **own** network `los`, deliberately not the box's shared `infra`:
  nothing an agent can reach should sit next to other projects' databases; Caddy reaches los via the host port):
  `los` (`127.0.0.1:7001`), `los-searxng` (web search, internal only: `http://searxng:8080`, secret `SEARXNG_SECRET`
  in `.env`, config `services/searxng/settings.yml`), and optional `los-browser` (headless Chrome for JavaScript pages,
  compose profile `browser`: `docker compose --profile browser up -d`; `web.browser_url: http://browser:9222`).
- **Caddy:** `/etc/caddy/sites/los.tjlabs.no.caddy` is a plain `reverse_proxy` + `tls internal`, behind Cloudflare
  (whose `*.tjlabs.no` wildcard means `los` never shows up in crt.sh). There's no basic auth: los has its own login.
  `los.tjlabs.no` is also behind **Cloudflare Access** (seen 2026-10-02): requests from the box through Cloudflare get
  Access's 403 page. Test the live app via Caddy locally: `curl -k --resolve los.tjlabs.no:443:127.0.0.1 https://los.tjlabs.no/…`.
- **Rebuild after any change to `src/` or `web/`:** `cd /var/www/los && docker compose up -d --build`.
  A restart stops chat runs: on shutdown each is stopped with "Interrupted: los was restarted" and listed in
  `data/interrupted.json`; on start, ones younger than 15 min resume (same turn). Still, check nothing is running
  first (an open `request` without a later `usage`/`error` for the same session+turn+agent, or `/api/overview`).
  Source is baked into the image. Only `data/` and `config/` are bind mounts. DB backups before big changes go in
  `data/backups/` (`sqlite3 data/los.db ".backup data/backups/<name>.db"`).
- **Logs:** `docker logs -f los`.
- **Healthcheck:** `GET /api/health` is public. Everything else needs a session.

### Bind mounts / state

| Path | What |
|---|---|
| `config/settings.yaml` | brains, privacy, routing, sources. Editable from the UI (Settings, Brains) |
| `config/agents/<name>.md` | one agent per file: `brain` (+ optional `emoji`) and the personality. Editable from the UI (Team) |
| `config/mcp.json` | external MCP servers. Editable from the UI (MCP) |
| `data/los.db` | SQLite (WAL): sessions, messages, events, tasks, documents, plugin tables |
| `data/auth.json` (0600) | web login: username, scrypt hash, cookie-signing secret |
| `data/brain-env.json` (0600) | per-brain env vars / secrets. **Never** put these in settings.yaml |
| `data/accounts/<name>/` | per-brain login + state for runtimes (CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_* for opencode) |
| `data/workspace/` | the shared workspace: files for you and the team, indexed, served at `/files/<path>` |
| `/home/deploy/.claude` → `/home/node/.claude` | the **host's** Claude Code login, shared with brains of type `claude-code` that have no `account` |

The container runs as `node` (uid 1000 = `deploy`), so the shared `~/.claude` stays writable on both sides.

### Web login, profile, security headers

- One user (`toffe`). Change the password with `docker exec -it los npm run password -- toffe`. This rotates the
  secret, so every session is logged out.
- Cookie `los_session` is HMAC-signed, HttpOnly, Secure, SameSite=Lax: 30 days with "keep me logged in", else 12h.
- Failed logins are rate-limited per IP (CF-Connecting-IP): 8 per 15 min.
- Every non-GET `/api/*` request must send `X-Los: 1` (CSRF defence on top of SameSite). `api()` in `web/app.js` does it.
  `/login` and `/logout` form posts are refused when their `Origin` isn't los's own host.
- **Rate limit:** 8 failures per IP *and* 40 for the whole account per 15 min (the IP comes from Cloudflare/Caddy
  headers, which someone reaching the server directly could fake; the account-wide cap is what really bounds it).
- **Profile page** (`/profile`, `/api/profile*`): display name (in `data/auth.json`, used as `{{name}}`), change
  password (current one required, rotates the secret → other sessions out, this one gets a fresh cookie), two-factor
  login: TOTP (RFC 6238, own implementation in auth.ts, QR via `qrcode`), 8 one-time recovery codes (sha256 in
  auth.json), two-step login (password → short-lived signed `pending` token → code). Turning it off or new recovery
  codes need password + code. Lost phone: `npm run password` resets the password and turns 2FA off.
- **Headers:** app pages get a CSP (`script-src 'self'`, no inline scripts: the theme script is `web/theme.js`;
  `connect-src 'self'`; `frame-ancestors 'none'`; images `https:` because of click-to-load), `X-Frame-Options: DENY`,
  `Referrer-Policy: same-origin`, `nosniff`. Workspace files get `Referrer-Policy: no-referrer` (their URL is a key).

## Code map

```
src/cli/serve.ts        container entry: web server + worker pool in one process; fails stale tasks
src/web/server.ts       route table over node:http (no framework), SSE stream at /api/stream, static files
src/web/auth.ts         login (two-step with TOTP 2FA + recovery codes), cookie signing, rate limit, profile, view tokens
src/brains/
  index.ts              getBrain(): merges account env + data/brain-env.json into cfg.env
  session.ts            THE translation layer: a CLI agent as a chat-completions brain (see "One protocol" below)
  cli.ts                per-CLI flags + stream parsers (claude-code, codex, opencode) and the plain `cli` brain.
                        BrainAuthError on login failures
  opencode-guard.js     opencode plugin loaded into every opencode run: refuses its built-in tools (see Brains)
  env.ts                brain-env.json + account dirs
  manage.ts             brain manager: CRUD (writes settings.yaml via yaml Document API, so comments survive),
                        login status, plan limits, browser-driven login flows, usage stats
  openai.ts anthropic.ts  API brains: openai = llama.cpp/Ollama/OpenRouter/vLLM/OpenAI as-is, anthropic = translated
src/tools/run.ts        callTool(): the ONE place a tool runs (visibility, args, approval, privacy, events)
src/mcp/server.ts       per-run MCP endpoint (127.0.0.1:<random>/mcp/<token>) that only *carries* a CLI agent's calls
                        to session.ts; it runs nothing itself
src/mcp/client.ts       external MCP servers (config/mcp.json) → registry plugins `<server>_<tool>`
src/plugins/shell/      shell_run (bash in the workspace; sideEffect → approval, or "Allow for this chat")
src/plugins/web/        web_search (SearXNG, else DuckDuckGo) and web_fetch (fetch.ts: local Readability → Markdown,
                        "Page data" from JSON-LD/meta (prices, stock), headless-Chrome fallback via DevTools protocol),
                        web_screenshot (same browser: desktop 1440 / mobile 390 px, full_page in ≤4 parts of ~2 screens
                        so models see them readably; saved in the chat folder or screenshots/<date>/, shown to seeing brains)
src/plugins/files/      files_read/write/edit/list/search, confined to the workspace (realpath-checked)
src/core/loop.ts        THE agent loop, for every brain: budget/limits, stall watchdog, inbox, stop, fallback, deltas
src/core/session.ts     chats: mentions()/addressees(), chatView() (what one agent sees), saveMessage (turn, agent)
src/core/context.ts     send-time cut of tool results (stored in full; result_read reads on), per-request size budget
src/core/net.ts         fetchPublic()/checkPublicUrl(): agents reach only the public internet (SSRF guard)
src/core/profile.ts     the owner's display name and {{name}}/{{date}}/… variables for system prompts
src/core/images.ts      image markers ⟦image:id⟧: pictures for brains that can see, a note for the others
src/plugins/images/     image_view (workspace file, /files link or https URL → shown to the model)
src/plugins/plan/       plan_set/plan_update: a plan per (chat, agent, turn), shown to that agent only in that run
src/core/control.ts     in-memory registries shared by chats + worker: approvals (request/answer/list) and runs (stop)
src/core/time.ts        owner's timezone (settings.timezone): "now" in prompts, parseWhen (local → UTC), cron/nextRun
src/core/history.ts     what a brain missed (runtimeHistory), compaction (compactSession)
src/core/conversation.ts export a session as Responses-style items JSON (GET /api/sessions/:id/conversation)
src/tasks/worker.ts     worker pool (startWorkers), scheduler (scheduleDue: jobs → tasks), report() into report_to
src/plugins/jobs/       jobs_create/list/update/run_now/delete (recurring), context() lists jobs reporting to this chat
src/core/boards.ts      kanban boards: cards, assignees, the agent card queue, hand-back (schema + rules)
src/plugins/boards/     boards_list/create, cards_find/get/add/update; context() shows an agent its boards + your decisions
src/plugins/team/       team_list, team_find (keyword rank over personalities); team_ask only inside background tasks
src/core/workspace.ts   the shared folder data/workspace: safe paths, folder-aware private flags, listing, search (rg)
src/plugins/tasks/      tasks_create (later work, run_at local time, reports back), tasks_wait (subtasks), tasks_cancel
web/                    vanilla JS SPA (app.js), style.css, login.html. marked + DOMPurify served from node_modules
```

### One protocol (the core design)

- **Every brain speaks one protocol**, the OpenAI chat-completions shape: `complete({system, messages, tools})` →
  `{text, toolCalls}` (`Brain` in `src/types.ts`). **los runs the loop for every brain** (`src/core/loop.ts`):
  system prompt, tools, approvals, history, step limits, events. There is no second loop.
- **API brains** map it to HTTP: `openai.ts` (llama.cpp, Ollama, OpenRouter, vLLM, OpenAI) and `anthropic.ts`.
- **CLI agents** (Claude Code, Codex, opencode) are translated by `src/brains/session.ts`: the CLI process lives for
  the whole turn, its tool calls arrive on a per-run MCP endpoint and are held open, `complete()` returns them as
  `toolCalls`, los runs them, and the next `complete()` answers the held MCP requests. `close()` kills it at the
  end of the run (also on `max_steps`). Session brains get every permitted tool up front (no `tool_search`), plus
  `resume` (their own session id + a transcript of turns they missed).
- **Claude Code has no tools of its own.** `--tools ""` (init event shows `tools: []` before MCP),
  `--strict-mcp-config` with only `los`, `--allowedTools mcp__los`, `--setting-sources ""` (no host hooks/plugins),
  `--system-prompt` (replaces its own), `--thinking-display summarized` (newer models otherwise send thinking blocks
  *empty*, only a signature). Brain `args` that touch tools/permissions/MCP/prompt/max-turns/thinking are refused.
  Claude calls MCP tools one at a time (no readOnlyHint), so a "parallel" request arrives as consecutive steps.
  Codex and opencode still have built-in tools; those show up as `codex · …`/`opencode · …` notes in the event log.
- Tools themselves are plugins in `src/plugins/*` plus external MCP servers (`src/mcp/client.ts`), all in the
  registry, all run by `callTool()` (`src/tools/run.ts`).
- **Approvals:** `sideEffect` tools (shell_run, external MCP tools without readOnlyHint, …) wait for the UI
  (15 min, then denied). "Allow for this chat" (`{granted, always}`) adds the tool to `sessions.allow`, so it doesn't
  ask again in that chat. Background tasks wait up to 24 h for an answer ("Needs you" on the Tasks page), unless the
  agent file lists the tool in `auto_approve` (an expert knob; none of the shipped agents use it). `MCP_TOOL_TIMEOUT`
  is 20 min so Claude waits.
- **Bypass** (2026-10-02): `sessions.bypass` / `tasks.bypass` / `jobs.bypass`. With it on, every tool that needs
  approval runs without asking *in that chat or task* (others still ask); each such call is logged as an `approval`
  event with `bypass: true` ("⚠ ran without asking"). Set only by you from the UI (chat Details → Approvals, task
  drawer, new task / job form, always behind a warning confirm) or the API (`PATCH /api/sessions/:id`,
  `PATCH /api/tasks/:id`, `{bypass}` on POST/PATCH jobs and POST tasks); never through agent tools. A task copies it
  to its session when it starts; a job passes it to each task; turning it on answers what's waiting there with yes.
  Agent-created tasks (`tasks_create`) never get it, and `jobs_update` changing a job's prompt or agent turns it off.
- **Tool results are stored in full** (`messages`, and `output` on `tool_result` events for a runtime's own built-ins).
  Only what's *sent* is cut (`src/core/context.ts`: 50k chars for the last 8 messages, 1.2k for older ones), with a
  note pointing at `result_read(call_id, offset)`, a core tool every agent has (like `tool_search`).
- **Budget per turn** (`loop.ts`): `max_steps` = tool calls, los's *and* a runtime's built-ins (`opencode · bash`, …);
  `max_minutes` (default 20) wall clock, not counting time waiting for an approval. Over it: an API brain's calls are
  answered with "write up now" and it gets no tools (2 rounds, then it ends); a runtime is killed (its own tools can't
  be refused) and resumed once without tools for the write-up (`wrapUp()`, 3 min max). `runtime` event `{type: "limit"}`.
- **Stops are stops:** a run whose signal fired is `cancelled`, even if the CLI handed back half a sentence. A cancelled
  task's report has no result and wakes nobody; `tasks_cancel` (an agent cancelling) posts no report at all.
- **Context size** (`src/core/context.ts`, layers): earlier turns as words only; tool output cut per message (50k
  chars for the last 8 messages, 1.2k older, `result_read` for the rest); max 60 messages; then a **budget** per
  request: `chat.max_context_tokens`, else 60% of the brain's `context_window`, else 100k tokens (× 3.5 chars). Over
  it, the oldest messages before the current turn are left out (with a note), then this turn's older tool results are
  squeezed to 2k. The current turn is never dropped. Runtime brains' transcript is capped at 80k chars. On top,
  auto-compaction summarises a chat at 80% of its window. Within one turn, a CLI agent's own context is the CLI's
  business (Claude Code auto-compacts); los bounds it with the step/time budget and the per-result cut.
- **What was sent, exactly:** each step logs a small `request` event (system prompt when it changed, `upto` = last
  message it could see, `after` = compaction point, budget, tool names, the CLI preface at step 0). `requestContext()`
  in loop.ts rebuilds the real body from it with the same functions (messages are append-only); the smoke test
  checks it's identical to what the brain received. UI: Inspect → Export context; API `GET /api/sessions/:id/context
  ?turn=&agent=&step=`. Chat/events APIs strip `system`/`preface` from these events.
- **Stall watchdog:** a CLI brain with no sign of life (no output, call or token) for `stall_minutes` (per brain,
  default 5; `opencode-free` 3) is killed and counts as "unreachable" (the agent's fallback, if any). Paused while
  los runs a tool or waits for you.
- **Live view survives navigation:** the server keeps each running answer's streamed text and thinking (`streamed`
  in server.ts, dropped when the run ends) and sends it with `live` in `GET /api/sessions/:id` (with `startedAt`), so
  a chat opened mid-answer continues where it is and the timer counts from the real start.
- **Agents only reach the public internet** (`src/core/net.ts`): `web_fetch`, `image_view` and the browser fallback
  go through `fetchPublic()`: http(s) only, no internal hostnames (no dot, .local/.lan/.internal…), and the IP each
  connection really goes to is checked (undici `Agent` lookup), redirects re-checked: no loopback, private, link-local
  (cloud metadata), CGNAT or IPv6 ULA. Exceptions: `web.allow_internal: [host, …]`. Tested: localhost, 169.254.169.254,
  `browser:9222`, `127.0.0.1.nip.io` and a public redirect to 127.0.0.1 are all refused.
- **Images in agent messages from other sites don't load by themselves** (DOMPurify hook in app.js → "click to
  load"): an agent steered by a page could otherwise leak data through an image URL.
- **ripgrep** is always called with `-e <pattern> --` (a query like `--pre=…` would otherwise run a program).
- **Web:** `web_search` uses SearXNG if `web.searxng_url` is set, else scrapes DuckDuckGo's HTML page. `web_fetch` is
  local (no third-party reader, by choice): mode `article` (Readability, no link URLs unless `links: true`) or `page`
  (whole page minus nav/footers/cookie banners), PDFs via pdftotext, `render: true` or an empty/blocked page → the
  browser. Shops: structured data (product, price, stock) on top as "Page data". From this server many Norwegian
  shops and search engines rate-limit or block; los moves to a home network later, where they shouldn't.

### Brains

- **Free brain** `opencode-free` (opencode/big-pickle, cost 0): Mira and Finn use it (to save tokens), falling back to
  claude-code → claude-2. Los stays on Claude (tested: the free model misread Norwegian requests, wrong schedules).
  The free tier refuses anything but plain opencode ("can only be used from within OpenCode"): switching off its
  built-in tools (`tools`), denying them (`permission`) or a custom agent prompt are all refused (re-tested
  2026-10-01). What works: the tools stay *declared*, and `src/brains/opencode-guard.js` (a `tool.execute.before`
  plugin, passed in `OPENCODE_CONFIG_CONTENT`) refuses to *run* any that isn't `los_*`, pointing at the los tool to
  use. So every call goes through los. The refusals still count toward the step budget. Our system prompt is
  prepended to the first message. The free model is slow to start (~30 s) and sometimes queues for minutes.
  `--thinking` adds its reasoning parts (allowed on the free tier; the model doesn't always reason). `run --format
  json` sends whole parts, not tokens, so opencode text appears part by part (each part goes out as a delta), not
  word by word. Token streaming would need `opencode serve` + its event stream instead of `run`.
- **Types:** `openai`, `anthropic` (API brains), `claude-code`, `codex`, `opencode` (CLI agents via session.ts),
  `cli` (any command, text only, no tools).
- **`account`** gives a runtime its own login dir under `data/accounts/`. A `claude-code` brain *without* `account`
  uses the host login (brain `claude-code`). `claude-2` is a second Claude account.
- **Login flows** (Brains page): Claude runs `claude auth login` (prints a URL, then reads the pasted code from stdin).
  Codex runs `codex login --device-auth` (prints a device code). opencode uses API keys in env, or its free `opencode/*` models.
- **Never log out the host login from los.** `logout()` refuses for `claude-code` without `account`, because that
  would log out Claude Code on the server too. "Log in again" on it is fine and fixes the host as well.
- **Status:** re-checked every 15 min. For Claude, the plan-usage call doubles as a token check: a revoked
  login still says `loggedIn: true` in `claude auth status`.
- **Plan limits:** Claude uses `GET https://api.anthropic.com/api/oauth/usage`, an **undocumented** endpoint
  (what Claude Code's `/usage` uses) with header `anthropic-beta: oauth-2025-04-20` and the OAuth access token from
  `.credentials.json`. Setup tokens (`CLAUDE_CODE_OAUTH_TOKEN`) can't read it. Codex limits are read from the newest
  rollout file in `CODEX_HOME/sessions` (`rate_limits`). Untested: no Codex login yet.
- **Usage through los:** `usage` events (`brain`, `input`, `output`, `cached`, `cost`, `ms`) in the `events` table.
- **Runtime sessions: fresh every turn** (2026-10-01, to stop re-sending old tool output). A CLI agent starts a new
  session each turn and gets the conversation so far as *words only* (`runtimeHistory()`: messages and answers, no
  tool calls/results/narration from earlier turns). Within a turn it keeps its own work. The only resume left is the
  limit write-up (`currentRef()`: the session this turn started). Same rule for API brains in `chatView()`.
- **History is los's, not the brain's.** `messages` holds the full structured conversation for every brain (user →
  assistant[+tool calls] → tool → …, `brain` on assistant rows), since the loop runs every tool call. What a brain is
  *sent* is lean: earlier turns as words only (API brains as messages via `chatView()`, runtime brains as a
  `<conversation_so_far>` transcript via `runtimeHistory()`); everything is still in the log (Inspect, Events).
- **Compaction** (`POST /api/sessions/:id/compact {brain}`, Context card in the chat): a brain the user picks
  summarises everything since the last compaction → `compact` event (`summary`, `upto` message id). After it,
  model brains load only messages after `upto`, runtime refs from before it are ignored (fresh session), and the
  summary goes in the system prompt. Claude Code still auto-compacts its own session (`compact_boundary` event).
- **Context meter:** `context` events (`used`, `window`, `model`) after each turn. Claude: last API call's
  input+cache+output, window from `modelUsage[].contextWindow`. Model brains: `context_window` in the brain config.
- **System prompt:** Claude gets los's prompt via `--system-prompt` (replacing its own). Codex/opencode/cli have no
  system-prompt flag, so it's prepended to the first prompt only.

### Chats, agents, @mentions, handoffs

- **Agents** (`config/agents/<name>.md`): the file name is the name and the @handle (`mira.md` → Mira, `@mira`).
  Frontmatter: `brain`, optional `emoji` (and `name` only when the display name isn't just the capitalised handle).
  The body is the personality; its first sentence is the one-liner other agents and the UI show (`title`). Every
  agent may use every tool (`tools`/`allow` default `*`). Expert knobs still read if present: `max_steps` (40),
  `max_minutes` (20), `auto_approve`, `private_access`, `workdir`. The Team page edits name/avatar/brain/personality
  (`PUT /api/agents/:h {agent}` → `agentMarkdown()`, keeps expert knobs) or the raw file (`{raw}`).
  Handles were renamed 2026-10-01 (assistant→los, researcher→mira, coder→finn, mail-clerk→vera; one-time migration
  at `PRAGMA user_version` 1).
- **Sessions** have `kind` `chat` | `task`. A chat has a lead (`sessions.agent`, `default_agent` = los for new chats;
  changeable in the details panel) and `members` (who has taken part, for faces). Home, DMs and rooms were migrated to
  plain chats. A new chat is only created on its first message (`/chat/new?lead=…` in the UI).
- **Who answers** (`post()` in server.ts): everyone the message @mentions (`@handle`/`@Name`; `@team` = everyone,
  user only), else the lead. The user message is saved once; each addressee gets a run with `turn` = its id. One run
  per agent per chat (`chat:<session>:<agent>`), several agents in parallel.
- **Handoffs** (`handoffs()`): when a run ends, its answer's @mentions (not inside code, inline code or quotes, not
  itself, not credits like "Ollie (@ollie)", which models copy from los's own labels) each get a turn (the same two
  agents at most twice per message from you: a question and its answer, no thank-you ping-pong): a `user` message with `name = 'handoff'`, `agent` = target, shown as "Mira → Finn". Max 8
  handoffs since your last message (`MAX_HOPS`), then an error note asks you to continue.
- **Hand-backs** (`handBack()`, 2026-10-02): an agent that finishes a handed-over turn *without* @mentioning anyone
  gives the turn back to whoever asked (a `handoff` message "X (@x) finished what you handed over…", shown as
  "Mira ↩ Los · done"), so the asker can hand on the next step or wrap up. If others the asker handed work to are
  still working, the last to finish hands back. Hand-backs count toward `MAX_HOPS` but not the two-per-pair limit.
  Otherwise nothing triggers an agent: a name without @ does nothing, and nobody is woken by a report.
- **Credits aren't mentions:** `Finn (@finn)` / `Finn @finn:` (los's own labels, which models copy) are ignored;
  `for Finn (@finn can build…` counts (fixed 2026-10-02, it silently dropped a handoff).
- **Inbox:** a message for an agent that's already working in that chat goes to its inbox: delivered appended to its
  next tool result ("STOP AND READ: new message(s)…", `runtime` event `{type: "inbox"}`), or, if the run ends first,
  as a new turn right after.
- **What an agent sees** (`chatView()`): its own work *in this turn* in full, its earlier turns as words only;
  everyone else's *words* only (other agents' tool calls
  and results are stored but not sent); nothing newer than its turn except its own work (keeps tool calls next to
  their results while others work in parallel); handoff notes meant for others are left out. Runtime brains' missed-
  turns transcript follows the same rule (`ownWorkOnly()` in history.ts). Other agents' messages are labelled
  `[Name (@handle) said:]`. CLI sessions resume per brain **and** agent (`runtime` events carry `agent`).
- **Every message has `turn` and `agent`** (assistant/tool rows: the run they belong to), and so does every event
  (`events.agent`). The UI groups by (turn, agent): one block per run, tool calls folded, live while working.
  **Inspect** (`GET /api/sessions/:id/inspect?turn=&agent=`) shows a run in full: every call, whole result, approval,
  limit, inbox delivery, cost. `GET /api/sessions/:id` sends tool results cut to 2000 chars and no `output`.
- **System prompt** starts with who the agent is (its personality), the chat, the teammates (`@handle emoji: first
  sentence`), how to hand off, and why this turn (handoff / @team). It also says how to show files/images.
- **Private access grant:** `private_access: true` lets an agent read private items even on a cloud brain
  (`sees()` in loop.ts = local brain OR grant; used for tools, plugin context and the private-session guard).

### Your messages: editing, files, variables

- **Edit** (`POST /api/sessions/:id/messages/:mid/edit {input}`, ✎ on your messages): stops whoever is working,
  saves the new message (`edit_of` = the old one) and sets `archived` = new id on the old message and everything after
  it. Archived rows are out of every view (`chatView`: `archived IS NULL OR archived > until`, so a context export of a
  request from before the edit still rebuilds as it was; `loadMessages`, history, export, counters). The UI shows
  "edited · show earlier version" (faded). Memories saved or files written in the old branch stay.
- **Chat files:** each chat gets a workspace folder on first use, `chats/<date>-<slug>-<id6>` (`sessions.folder`).
  `POST /api/sessions/:id/files?name=` (raw, ≤50 MB, sanitised name, never overwrites), `GET …/files`. The composer
  attaches any file (📎, paste, drop on the chat; a new chat is created on the first file) as `![x](/files/…)` /
  `[x](/files/…)`; the details panel lists the folder. The system prompt tells agents the folder and its newest files.
- **Chats:** search (`/api/sessions?q=`, sidebar, Ctrl+K), archive (`sessions.archived`, PATCH `{archived}`), export
  as Markdown (`GET …/markdown`) or JSON. Shortcuts: Ctrl/Cmd+K search, Alt+N new chat, / focus the composer.
- **Variables** (`src/core/profile.ts`): `{{name}} {{username}} {{date}} {{time}} {{weekday}} {{timezone}}` are filled
  in the whole system prompt (personalities say `{{name}}` instead of a hard-coded owner) and in agent descriptions
  shown in the UI.

### Images

- **`image_view(source)`** (`src/plugins/images/`): a workspace path, `/files/…` link or `https://` URL; PNG/JPEG/GIF/WebP
  (sniffed from the bytes), max 5 MB; private paths follow the usual rules. The tool's text result carries a marker
  `⟦image:<id>⟧` (`src/core/images.ts`, picture held in memory for an hour); the log stores only the note.
  Delivery per brain: CLI agents get a real MCP image block (session.ts `takeImages` → mcp/server.ts), the
  Anthropic API brain an image inside the tool_result, OpenAI-style brains a text note (tool messages are text-only).
  Verified live: Claude Code describes the image correctly.
- **Ollie** (`config/agents/ollie.md`, claude-code) is the one who looks. The free-model agents can't see images;
  their personalities say to @mention Ollie with the image link. Tested chain: Mira → @ollie → @mira → answer.
- **Kai** (`config/agents/kai.md`, claude-2, 2026-10-02) scouts money: businesses with weak websites as leads, tool/
  service ideas. His file deliberately doesn't name Ollie: he finds the design reviewer with `team_find` ("review a
  website's design from screenshots" → ollie), so Ollie's first paragraph carries those words. He never contacts leads.
- **Attaching:** the composer's 📎 (or pasting an image) uploads to `uploads/<date>/<time>-<name>` in the workspace
  and puts `![name](/files/…)` in the message; your messages show those as thumbnails.

### Workspace and /files

- One folder, `data/workspace`, shared by you and every agent without its own `workdir`; also the knowledge source
  `workspace` (indexed by Index now / `npm run ingest`). API: `GET /api/workspace?dir=`, `/search?q=`,
  `POST /folder`, `PUT /file?path=&private=1`, `PATCH ?path= {private|to}`, `DELETE ?path=`.
- **Privacy** on files *and folders* (`file_flags`, source `workspace`, nearest flag wins, setting a folder clears
  flags below it). files_* tools refuse private paths for agents that may not see private data. Shell commands are
  NOT covered (an agent with shell_run can still `cat` a private file).
- **Three words, kept apart:** 🔒 **private** is about AI (only local models or agents granted access may read it);
  🌐 **shared** is about the web (a share link anyone can open); everything else is **just yours** (you open it
  through los). Never say "public" for files: it collided with "private" in the UI.
- **`/files/<path>`** (logged in) 302s to `/f/<view token>/<path>`. The view token (`auth.viewToken(scope)`) is a
  signed, **scoped** and **expiring** (12 h) bearer link: it opens the opened file's folder (so a page's own
  assets load) or, at the top level, that file only; nothing else, nothing after it expires (`viewScope()` +
  `viewable()`, paths normalised so `../` can't leave the scope). It needs no cookie because a sandboxed page or the
  files address can't send los's. (Before 2026-10-01 it was one daily key for the whole workspace.) Served inline (or
  `?download=1` → attachment). A folder with `index.html` serves as a site.
  - Without `web.files_url`: served from los's own address with `CSP: sandbox allow-scripts …` (opaque origin: can't
    reach los, but also **no localStorage/IndexedDB**: pages that save state can't).
  - With `web.files_url` (e.g. `https://los-files.tjlabs.no`, a second hostname proxied to the same container):
    `/files/` redirects there, and that host serves only `/f/<token>/…`, without the sandbox: pages get an origin of
    their own (storage works). Still safe: the login cookie is host-only, los sends no CORS headers, and non-GET API
    calls need `X-Los` (preflight). Needs a DNS record + Caddy site (`tls internal`) for the hostname. Note: a
    two-level name like `files.los.tjlabs.no` isn't covered by Cloudflare's free certificate; use `los-files.…`.
    This box: `los-files.tjlabs.no` (`/etc/caddy/sites/los-files.tjlabs.no.caddy`, matched by Host).
  - Or a second port: `FILES_PORT` (env) makes los also listen there and treat every request on it as the files
    address; `files_url: http://host:<port>`. For setups without subdomains (another port is another origin).
- **Share links** (`public_links` table, `src/core/workspace.ts`): a file or folder you (Workspace page 🌐, `PATCH
  /api/workspace?path= {shared}`) or an agent (`files_share`, sideEffect → asks you) share gets a permanent link
  `/s/<random 22 chars>/…`, served to anyone without login (own origin on the files address, sandboxed on los's).
  A shared folder serves everything under it (`../` can't leave it) and works as a site. Private always wins
  (a private path is never served; making something private drops share links at/under it; private paths can't be
  shared). Moves keep links (`moveShared`), deletes drop them. Without `web.files_url` the link is relative to los.
- Chat Markdown: highlight.js (`/vendor/hljs.js`, served from `@highlightjs/cdn-assets`) + copy buttons, lazy images,
  `/files/` links rendered as file chips (`enhance()` in app.js).

### Jobs, tasks, reports

- **Tasks** are for work that isn't part of a conversation: later (`run_at`), scheduled jobs, or long background work.
  Work *now* happens in the chat via @mentions. `report_to` = chat that gets the result (set by `tasks_create` from a
  chat; tasks started by a task don't report, their parent uses `tasks_wait`/`tasks_get`), `job_id`. Statuses:
  queued, running, waiting (blocked on your approval), done, failed, cancelled. Workers: `settings.worker.concurrency`.
- **Reports:** `report()` inserts an assistant message with `name = 'report'`, `brain = 'task:<id>'` into
  `report_to`. Every brain sees it next turn. A private result is not copied (it would taint the chat). Reports wake
  nobody (wake-ups were removed with the chat rework).
- **Jobs** (`jobs` table): `schedule` is 5-field cron in the owner's timezone or `every 30m/2h/1d`. The scheduler
  (every 20s) queues a task per due job (skipped if the last one is still open) and moves `next_run` on.
- **Approvals** (`src/core/control.ts`): chats wait 15 min for an answer in the chat; background tasks wait up to
  24 h (status `waiting`, "Needs you" on the Tasks page). Answer: `POST /api/approvals/:id {granted}`.
- **Stop:** `POST /api/sessions/:id/stop {agent?}` (one agent or everyone in the chat) / `POST /api/tasks/:id/cancel`. The
  loop's AbortSignal kills a CLI brain mid-step and aborts API fetches.
- **No per-chat brain switching** (removed on purpose): the brain belongs to the agent (Team page).
- **Fallback belongs to the agent** (the owner's rule: a brain is linked to an agent, nothing switches it silently):
  optional `fallback: <brain>` in the agent file (Team page "Fallback brain"). Used when the brain fails on the
  turn's first step with a limit/auth/unreachable error, or goes silent for its `stall_minutes` at any step (then the
  fallback starts the turn over). No fallback → the run ends with the error and a ↻ Retry button
  (`POST /api/sessions/:id/retry {turn, agent}`). Brains have no fallbacks of their own any more.
- **Streaming:** brains get `onDelta`; the loop publishes `{sessionId, turn, agent, brain, text|thinking}` on bus `delta`
  → SSE event `delta`. Not stored; the finished message is. openai.ts/anthropic.ts stream SSE (a server that
  answers plain JSON still works); Claude Code uses `--include-partial-messages`. Thinking → `reasoning` events.
- **Auto-compaction:** after a chat turn (only when no agent is still working there), if `context.used` ≥ `chat.auto_compact` × window (default 0.8; unknown
  window: 160k), the chat is compacted with the brain that answered (`compact` event with `auto: true`).
- **Notifications:** browser notifications (🔔 in the nav) for answers, reports and approvals while the tab is hidden.

### Boards (kanban, 2026-10-02)

- **Tables** `boards` (columns JSON `[{name, done?}]`, `owner` agent, `agents_move`, `bypass`, `report_to`), `cards`
  (`col`, `assignee` = `me` | agent | null, `key` unique per board for dedupe, `priority` 0–2, `passes`, `bypass`),
  `card_events` (created / moved / assigned / comment / updated / result). `tasks.card_id` links card work.
- **Agent queue** (`queueCards()`, on every assignment and in `scheduleDue` every 20 s): an agent with cards assigned
  (not in a done column) gets **one** card task at a time, priority then oldest first. When it ends
  (`afterCardTask()`), the result is logged on the card and a card the agent left with itself goes back to `me`.
- **Rules:** only you move cards between columns unless the board has `agents_move`; agents must comment when they
  reassign; agent→agent passes are capped at 5 (`MAX_PASSES`) until you touch the card; only you set bypass (board or
  card → the card task's bypass). Agents see their boards (owned or with cards assigned) + your recent moves/comments
  in the system prompt (`boardsContext()`), which is how Kai learns from rejected leads.
- **UI** `/boards`, `/boards/:id` (drag between columns, card drawer with activity); nav badge = cards waiting for you
  (`needsYou()`, also `cardsForYou` in `/api/overview`). Only `/files/…` card images are shown (no web images).
- **Leads:** board "Leads" (owner kai, columns New / Approved / Contacted / Won / Lost / Not a lead), chat "Leads",
  job "Daily lead hunt" (`0 12 * * 1-5`, kai, reports to that chat). Kai uses the domain as key and files sites he
  rejected under "Not a lead", so nothing is checked twice.

### Events

Everything goes in `events` (`session_id`, `task_id`, `turn` = id of the message that started the run, `agent`,
`type`, `data` JSON) and is published on the in-process `bus` → SSE. UI notices use `bus.emit("ui", {kind, …})`
(kinds: `run`, `tasks`, `approvals`, `report`, `ingest`, `config`, `brains`, `brain-auth`, `brain-login`).
Event types beyond the obvious: `reasoning`, `context`, `compact`, `usage`, `runtime` (refs, rate limits, fallback,
`limit`, `inbox`).

## Things that are deliberately off / known limits

- **No local LLM on this box** (4 CPU, 7.6 GB RAM, no GPU). `local`/`local-small` (Ollama) are unreachable, so
  Vera, enrichment and embeddings don't work. Search is keyword-only (FTS5).
- **Privacy is per item** (`src/core/privacy.ts`), the owner's choice (2026-10-01): every memory and document has a
  `private` flag. Cloud brains never get private rows (`seen()` in the SQL); a local brain reading one taints the chat
  (`touched()` → `sessions.private`, then cloud brains are refused). Defaults: memories `privacy.memory_default`
  (public), documents their source's `private` (imap → private, files → public), per file via `file_flags`
  (Files page toggle / upload checkbox; wins over the default and survives re-ingest). Attachments follow their mail.
  Public memories are injected into every system prompt (memory plugin `context()`); private ones only via search.
  `privacy.local_only` still hides whole tools (now empty).
- **Routing:** `\b(code|repo|bug|refactor|test|PR)\b` routes tasks *without an agent* to `finn`, so any such task
  mentioning "test" goes there. Los normally names the agent.
- **Anthropic API brain** streams text but doesn't use extended thinking (it would need signed thinking blocks
  stored per turn).
- **Shell reach:** `shell_run` (and `codex` with `-s danger-full-access`) runs inside the container, which includes
  the mounted `~/.claude` and `data/`. Hence approval by default ("Allow for this chat" to stop asking in one chat).

## Testing

- `npm run typecheck` on the host.
- The smoke test needs `pdftotext`, which the host doesn't have, so run it in the image:
  `docker run --rm -v $PWD/config:/app/config:ro --entrypoint node_modules/.bin/tsx los test/smoke.ts`.
- **API with curl:** the cookie is `Secure`, so curl won't send it over plain http from a jar. Log in with
  `curl -D - -X POST localhost:7001/login --data-urlencode username=toffe --data-urlencode password=…`,
  then pass `-H "Cookie: los_session=…"` (and `-H "X-Los: 1"` for writes).
- **Headless screenshots:** the open SSE stream keeps the page from going idle, so add `?static` to the URL
  (skips the stream). Behind the login, set the cookie through the DevTools protocol (`Network.setCookie`, with
  `secure: false` over plain http). The `browser` service works for this: run a script on a network the browser is on
  (`docker network connect <net> los-browser`, and resolve it as `los-browser`).
- **End-to-end on real data without touching it:** copy `data/` (`sqlite3 .backup` + workspace/accounts) somewhere,
  `docker network create los-test-net; docker run -d --name los-test --network los-test-net -e LOS_WORKER=0 -v <copy>:/app/data -v $PWD/config:/app/config:ro los`,
  set a throwaway password inside it (`npm run password -- toffe`), drive the API, then `docker rm -f los-test`.
- **Events page:** tool results ride on their call's row (`GET /api/events` pairs them: status, preview, duration;
  `GET /api/events/:id/full` gives the whole arguments + result when a row is opened). Chevron opens a row, `{ }`
  toggles prettified vs exactly-as-sent (remembered in localStorage).
- **Static files** are served with `no-cache` + ETag, so a rebuild reaches open browsers on the next load.

## Build gotchas

- **Base image is `node:24-slim`.** better-sqlite3 has no Node 22 prebuild here, so a `deps` stage with
  python3/make/g++ compiles it.
- **Global CLIs in the image:** `@anthropic-ai/claude-code`, `@openai/codex`, `opencode-ai`, plus `poppler-utils` for PDFs.
  `DISABLE_AUTOUPDATER=1`, so update by rebuilding.
- **`tsx` is a runtime dependency** (the server and the MCP bridge run TypeScript directly).
