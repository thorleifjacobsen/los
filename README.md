# los

*los* (Norwegian: harbour pilot). A personal AI assistant shaped like a chat app: a team of agents (Los, Mira, Finn,
Vera, Ollie), each just a name, a personality and a brain, and **chats** with them. Los answers; @mention a teammate
(or @team) to bring them in, and agents bring each other in the same way, visibly, in the chat. It remembers you,
streams answers and thinking live, takes files and images in the chat, and sets up **jobs** ("every weekday at
07:30…") and tasks for later that report back. Your own tools, MCP servers, any LLM per agent (one protocol for all
of them, Claude Code included), per-item privacy, share links for workspace files, and a private search index over
your mail and documents. Installing it elsewhere: `INSTALL.md`. How it works inside: `CLAUDE.md`.

Everything lives in one SQLite file. No Redis, no vector DB server, no framework.

```
npm install
npm test                 # end-to-end smoke test, no real LLM needed
npm run ingest           # index mail + files from the sources in settings.yaml
npm run chat             # talk to the default agent
npm run task -- "Go through this week's mail and add action items as todos" --agent vera
npm run worker           # run queued tasks
npm run tools -- --agent mira   # what can this agent see?
```

Needs Node 22+, `pdftotext` (poppler-utils) for PDFs, and Ollama (or any OpenAI-compatible server) for local models.
For local models: `ollama pull qwen3:14b qwen3:4b bge-m3`.

## Running on this server

`/var/www/los` is a single deployment, with no dev/prod split. The `los` container runs the web UI and the task worker,
next to `los-searxng` (web search) and `los-browser` (optional, JavaScript pages), on their own network.

```
docker compose up -d --build     # rebuild after code changes (src/, web/)
docker logs -f los
docker exec -it los node_modules/.bin/tsx src/cli/chat.ts   # terminal chat, same db
```

- **Web:** https://los.tjlabs.no → `127.0.0.1:7001` (behind Cloudflare Access too). Login form built into los (one
  user, `data/auth.json`, optional two-factor on the Profile page); reset it with
  `docker exec -it los npm run password -- toffe`. Workspace pages and share links: https://los-files.tjlabs.no.
- **Brains:** each agent picks one (and optionally a fallback) on the Team page. `claude-code` uses the host's login
  (`~/.claude` is mounted), so no API key is needed; Mira and Finn use opencode's free model. Every turn starts a fresh
  CLI session with the conversation so far as words (earlier tool output isn't re-sent).
  Every brain speaks one protocol (OpenAI chat-completions: system + messages + tools → text / tool calls) and
  los runs the loop for all of them. Claude Code, Codex and opencode are translated by `src/brains/session.ts`:
  their tool calls come back to los as ordinary tool calls (Claude Code has no built-in tools at all).
- **Brains page:** add/edit brains (Claude Code, Codex, opencode, any CLI, Anthropic/OpenAI-compatible APIs),
  each with its own env vars (`data/brain-env.json`, 0600) and, for runtimes, its own login under `data/accounts/<name>`.
  So two Claude accounts can run side by side. Logins (Claude: URL + code, Codex: device code) run from the browser,
  logins are re-checked every 15 min, and Claude/Codex plan limits plus los's own token counts are shown per brain.
- **Persistent:** `data/` (SQLite db, the shared workspace, logins) and `config/` (editable from the UI) are bind mounts.
- **Not available here yet:** no Ollama, so Vera, enrichment and embeddings are off (search is keyword-only).
  Point the `local` brain at an Ollama server to turn them on.

## The five ideas

**1. One loop.** `src/core/loop.ts`: ask the brain → run the tools it called → append results → repeat. Chat and autonomous tasks both use it.

**2. Brains are interchangeable.** `config/settings.yaml → brains` lists every LLM: Ollama, OpenRouter, OpenAI, Anthropic, and the runtimes Claude Code and Codex (which run their own loop; we hand them a prompt and log their events). An agent picks a brain, and any single task can override it: `--brain local-small`.

**3. Agents start small.** An agent gets `tool_search` plus the few tools in its `tools:` list. When it needs more, it calls `tool_search("read pdf")` and the matches are loaded into the session. `allow:` limits what it can ever find. Fewer tools = cheaper prompts and better tool choice, especially on small local models.

**4. Privacy is enforced in code, not in prompts.**
- Tools are `public` or `local-only` (knowledge, mail, memory by default — see `privacy.local_only`).
- A cloud brain can't load or call a local-only tool.
- Once a local-only tool runs in a session, the session is marked private and cloud brains are refused for it.
- Ingestion (summaries, tags, embeddings) refuses to run on a non-local brain.
- Task results from private sessions are hidden from cloud agents.

**5. Everything is a plugin.** Each folder in `src/plugins/` is auto-loaded. It declares its tables, its tools, and optionally text to inject into the system prompt (that's how the plan stays in view).

## Folder structure

```
config/
  settings.yaml        brains, sources, privacy, routing
  agents/*.md          one agent per file: frontmatter + system prompt
  mcp.json             external MCP servers (see mcp.example.json)
src/
  types.ts             ← read this first: the whole vocabulary
  app.ts               wires settings → db → plugins → MCP → registry
  core/                loop, sessions, context trimming, event log
  brains/              openai-compatible, anthropic, claude-code / codex
  tools/               registry + tool_search, defineTool/definePlugin
  mcp/                 MCP servers become plugins
  plugins/             todos, plan, memory, knowledge, mail, web, tasks
  knowledge/           extract → chunk → index → embed → hybrid search
  connectors/          where documents come from: files, IMAP
  tasks/               queue (the tasks table), worker, routing
  db/                  schema.sql + opener (WAL, FTS5, sqlite-vec)
  cli/                 chat, worker, ingest, task, tools
test/smoke.ts          fake LLM server, exercises everything
```

## Adding things

| Want | Do |
|---|---|
| A tool | Copy `src/plugins/todos/`, rename, edit. Name tools `<plugin>_<action>`. Mark `sideEffect: true` if it sends/deletes/pays. |
| An agent | New `config/agents/<name>.md` with `description`, `brain`, `tools`, `allow`. |
| An LLM | New entry under `brains:`. Anything OpenAI-compatible is `type: openai`. Set `local: true` only if it truly runs on your machine. |
| An MCP server | Add to `config/mcp.json`. Its tools appear as `<server>_<tool>` and are found via `tool_search`. Unannotated MCP tools require approval. |
| A data source | New file in `src/connectors/` yielding `RawItem`s, register it in `connectors/index.ts`, add it to `sources:`. |

## How lookup works

`npm run ingest` pulls new items from each source (IMAP is incremental by UID), extracts text (PDFs via pdftotext, mail via mailparser, attachments recursively), has the local `ingest` brain write a summary and tags, chunks it, and indexes each chunk twice: FTS5 (exact words, names, invoice numbers) and sqlite-vec (meaning). `knowledge_search` runs both and merges them with reciprocal rank fusion; `knowledge_read` returns the full document.

## Delegation

Agents delegate by creating tasks (`tasks_create`), optionally choosing the agent and brain. Tasks without an agent go through `routing:` rules, then `default_agent`. The worker runs them; side-effect tools are denied when no human is watching and show up as `approval` events.

## Not built yet (natural next steps)

- Scheduler (cron rows → tasks)
- Summarising old conversation instead of only trimming (`core/context.ts`)
- An LLM dispatcher agent for routing, beyond regex rules
- OCR for scanned PDFs (`knowledge/extract.ts`)
