// The web UI's backend: a JSON API over the same App the CLI uses, plus one SSE stream of everything that happens.
// No framework — a route table over node:http. Auth is Caddy's job (basic_auth in front of this).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, mkdirSync, createReadStream, renameSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve, extname, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type { App } from "../app.js";
import { loadAgents, agentMarkdown } from "../config.js";
import { runAgent, workdir, requestContext } from "../core/loop.js";
import { compactSession } from "../core/history.js";
import { createSession, getSession, membersOf, addressees, mentions, join as joinChat, saveMessage, allowIn } from "../core/session.js";
import { approvals, runs } from "../core/control.js";
import { BoardError, ME, addCard, cardEvents, columnsOf, createBoard, deleteCard, getBoard, getCard, needsYou, parseColumns, updateCard, type BoardRow, type CardRow } from "../core/boards.js";
import { checkSchedule, fmtLocal, nextRun, sqlUtc, parseWhen } from "../core/time.js";
import { exportConversation } from "../core/conversation.js";
import { WORKSPACE, wsPath, listDir, searchWorkspace, isPrivatePath, setShared, resolveShared, moveShared, dropShared } from "../core/workspace.js";
import { bus, makeEmitter, type LoggedEvent } from "../core/events.js";
import { createTask } from "../tasks/queue.js";
import { syncSource } from "../connectors/index.js";
import { SUPPORTED } from "../knowledge/extract.js";
import { search } from "../knowledge/search.js";
import { mcpStatus } from "../mcp/client.js";
import { getBrain } from "../brains/index.js";
import { sourcePrivate } from "../core/privacy.js";
import { createAuth } from "./auth.js";
import QRCode from "qrcode";
import { fill } from "../core/profile.js";
import { createBrainManager, BRAIN_TYPES } from "../brains/manage.js";

const webRoot = fileURLToPath(new URL("../../web/", import.meta.url));
const nodeModules = fileURLToPath(new URL("../../node_modules/", import.meta.url));

type Req = IncomingMessage & { params: Record<string, string>; query: URLSearchParams };
type Handler = (req: Req, res: ServerResponse) => unknown;

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const bad = (msg: string) => new HttpError(400, msg);
const notFound = (what = "not found") => new HttpError(404, what);

/** App-level notices for the UI (runs starting/ending, approvals, ingest progress, worker state). */
const notify = (kind: string, data: Record<string, unknown> = {}) => bus.emit("ui", { kind, ...data });

export function startWebServer(app: App, opts: { port: number; worker: { current: () => unknown } }) {
  const { db } = app;
  const filesPort = Number(process.env.FILES_PORT) || 0; // optional second port that serves workspace files only
  // A chat can have several agents working at once: one run per agent per chat. Compaction has its own key.
  const runKey = (sessionId: string, agent: string) => `chat:${sessionId}:${agent}`;
  const compactKey = (sessionId: string) => `compact:${sessionId}`;
  const working = (sessionId: string) => runs.list().filter((r) => r.kind === "chat" && r.sessionId === sessionId).map((r) => r.agent!);
  const compacting = (sessionId: string) => runs.has(compactKey(sessionId));
  const busy = (sessionId: string) => working(sessionId).length > 0 || compacting(sessionId);
  const ingest = { running: false, log: [] as string[], finishedAt: null as string | null };
  const claudeInfo = { version: null as string | null };
  execFile("claude", ["--version"], (err, out) => { claudeInfo.version = err ? null : out.trim(); });

  const configDir = () => join(app.settings.root, "config");
  const brains = createBrainManager(app, notify);
  /** Set a file's or folder's privacy (and its indexed documents' + attachments'), remembered so a re-ingest keeps it.
   *  Flags set further down inside a folder are cleared: the folder's choice now holds for everything in it. */
  const setDocPrivacy = (source: string, externalId: string, isPrivate: boolean) => db.transaction(() => {
    db.prepare("DELETE FROM file_flags WHERE source = ? AND external_id LIKE ? || '/%'").run(source, externalId);
    db.prepare("INSERT INTO file_flags (source, external_id, private) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET private = excluded.private")
      .run(source, externalId, isPrivate ? 1 : 0);
    const ids = (db.prepare("SELECT id FROM documents WHERE source = ? AND (external_id = ? OR external_id LIKE ? || '/%')").all(source, externalId, externalId) as { id: number }[]).map((d) => d.id);
    for (const id of ids) db.prepare("UPDATE documents SET private = ? WHERE id = ? OR parent_id = ?").run(isPrivate ? 1 : 0, id, id);
  })();
  const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

  // ── chat runs ──
  // Who answers: everyone a message @mentions (the whole team for @team), else the chat's lead. When an agent's
  // answer @mentions teammates, each of them gets a turn in the same chat (a "handoff"), visible to you. A message
  // for an agent that's already working goes to its inbox: it gets it with its next tool result, or right after.
  const MAX_HOPS = 8; // handoffs in a row without a word from you; then they stop and wait
  const inbox = new Map<string, { id: number; text: string }[]>();
  const turnOf = new Map<string, number>(); // run key → the message its turn started at (for the UI)
  // What a running answer has streamed so far (text and thinking aren't stored until the step ends), so a chat
  // opened mid-answer shows it instead of starting from nothing. Dropped when the run ends.
  const streamed = new Map<string, { text: string; thinking: string; gap: boolean }>();
  bus.on("delta", (d: { sessionId: string; agent: string; text?: string; thinking?: string }) => {
    const b = streamed.get(runKey(d.sessionId, d.agent));
    if (!b) return;
    if (d.text) { if (b.gap && b.text) b.text += "\n\n"; b.gap = false; b.text = (b.text + d.text).slice(-200_000); }
    if (d.thinking) b.thinking = (b.thinking + d.thinking).slice(-100_000);
  });
  bus.on("event", (e: LoggedEvent) => { // same spacing rule as the chat view: new text after a tool call or a finished text
    const b = e.sessionId && e.agent ? streamed.get(runKey(e.sessionId, e.agent)) : undefined;
    if (b && (e.event.type === "text" || e.event.type === "tool_call")) b.gap = true;
  });
  const live = (sessionId: string) => working(sessionId).map((agent) => {
    const key = runKey(sessionId, agent), r = runs.get(key), b = streamed.get(key);
    return { agent, turn: turnOf.get(key) ?? null, startedAt: r?.startedAt ?? null, text: b?.text ?? "", thinking: b?.thinking ?? "" };
  });
  const toInbox = (key: string, m: { id: number; text: string }) => inbox.set(key, [...(inbox.get(key) ?? []), m]);
  const nameOf = (h: string) => app.settings.agents[h]?.displayName ?? h;

  function startRun(sessionId: string, handle: string, turn: number) {
    const session = getSession(db, sessionId);
    if (!session) throw notFound("no such session");
    const agent = app.settings.agents[handle];
    if (!agent) throw bad(`agent "${handle}" no longer exists`);
    if (compacting(sessionId)) throw new HttpError(409, "this chat is being compacted; try again in a moment");
    joinChat(db, session, handle);
    const key = runKey(sessionId, handle);
    const signal = runs.start({ key, kind: "chat", sessionId, agent: handle, title: session.title ?? "chat" });
    turnOf.set(key, turn);
    streamed.set(key, { text: "", thinking: "", gap: false });
    notify("run", { sessionId, running: true, agent: handle });
    runAgent(app, {
      sessionId, agent, turn, signal,
      approve: (call) => approvals.request({ sessionId, agent: handle, call, timeoutMs: 15 * 60_000, signal }), // nobody answered → deny
      takeInbox: () => { const q = inbox.get(key) ?? []; inbox.delete(key); return q.map((m) => m.text); },
    })
      .catch(() => null) // already logged as an error event by the loop
      .then((answer) => {
        runs.end(key);
        turnOf.delete(key);
        streamed.delete(key);
        notify("run", { sessionId, running: false, agent: handle, preview: answer ? String(answer).replace(/\s+/g, " ").slice(0, 160) : undefined });
        // Messages that came in too late to hand over during the run: a new turn, starting at the last of them.
        const left = inbox.get(key);
        inbox.delete(key);
        try {
          if (left?.length && !signal.aborted) startRun(sessionId, handle, left.at(-1)!.id);
          if (answer && !signal.aborted && !handoffs(sessionId, handle, answer) && !left?.length) handBack(sessionId, handle, turn, answer);
        } catch (e) { console.warn(`follow-up in ${sessionId} failed: ${(e as Error).message}`); }
        if (!busy(sessionId)) autoCompact(sessionId);
      });
  }

  /** Handoffs since your last message: past MAX_HOPS they stop (an error note asks you to carry on). */
  function hopsLeft(sessionId: string, from: string) {
    const yours = (db.prepare("SELECT max(id) AS id FROM messages WHERE session_id = ? AND role = 'user' AND (name IS NULL OR name = 'team') AND archived IS NULL").get(sessionId) as any).id ?? 0;
    const hops = (db.prepare("SELECT count(*) AS n FROM messages WHERE session_id = ? AND name = 'handoff' AND id > ? AND archived IS NULL").get(sessionId, yours) as any).n;
    if (hops < MAX_HOPS) return yours;
    makeEmitter(db, { sessionId })({ type: "error", message: `${MAX_HOPS} handoffs in a row without you, so ${nameOf(from)}'s turn wasn't passed on. Write something to carry on.` });
    return null;
  }
  const handTo = (sessionId: string, h: string, note: string, text: string) => {
    const id = saveMessage(db, sessionId, { role: "user", content: note }, { agent: h, name: "handoff" });
    if (working(sessionId).includes(h)) toInbox(runKey(sessionId, h), { id, text });
    else startRun(sessionId, h, id);
  };

  /** An agent's answer @mentions teammates: each gets a turn (or, if it's busy, the message in its inbox). False: it mentioned nobody. */
  function handoffs(sessionId: string, from: string, answer: string) {
    const { handles } = mentions(answer, Object.values(app.settings.agents), from);
    if (!handles.length) return false;
    const yours = hopsLeft(sessionId, from);
    if (yours === null) return true;
    // Between the same two agents: a question and its answer (2 handoffs) per message from you, then they stop
    // (no "thanks" / "anything else?" ping-pong). Hand-backs don't count: they aren't anyone asking.
    const pair = (a: string, b: string) => (db.prepare(`SELECT count(*) AS n FROM messages WHERE session_id = ? AND name = 'handoff' AND id > ?
      AND ((agent = ? AND content LIKE ?) OR (agent = ? AND content LIKE ?))`).get(sessionId, yours, a, `%(@${b}) mentioned you%`, b, `%(@${a}) mentioned you%`) as any).n;
    for (const h of handles) {
      if (pair(from, h) >= 2) { console.log(`handoff ${from} → ${h} skipped: they've already been back and forth`); continue; }
      handTo(sessionId, h, `${nameOf(from)} (@${from}) mentioned you in their message above. Read it and do what they ask of you; answer in this chat.`,
        `${nameOf(from)} (@${from}) wrote:\n${answer}`);
    }
    return true;
  }

  /**
   * An agent finished what a teammate handed it and @mentioned nobody: the turn goes back to whoever asked, so they
   * can hand on the next step or wrap up (nobody else would pick it up). If others that teammate handed work to are
   * still at it, the last one to finish hands back, so the asker sees every answer at once.
   */
  function handBack(sessionId: string, from: string, turn: number, answer: string) {
    const t = db.prepare("SELECT name, content FROM messages WHERE id = ?").get(turn) as { name: string | null; content: string } | undefined;
    if (t?.name !== "handoff") return;
    const to = /\(@([\w-]+)\) mentioned you/.exec(t.content)?.[1];
    if (!to || to === from || !app.settings.agents[to]) return;
    const asked = db.prepare("SELECT 1 FROM messages WHERE id = ? AND name = 'handoff' AND content LIKE ?");
    if (working(sessionId).some((h) => h !== to && asked.get(turnOf.get(runKey(sessionId, h)) ?? -1, `%(@${to}) mentioned you%`))) return;
    if (hopsLeft(sessionId, from) === null) return;
    handTo(sessionId, to, `${nameOf(from)} (@${from}) finished what you handed over; their answer is above. Carry on: if a teammate is ` +
      "needed for the next step, @mention them now with what they need; otherwise wrap up for the user in a few lines " +
      "(don't repeat their answer, and don't @mention anyone just to thank them).",
      `${nameOf(from)} (@${from}) finished:\n${answer}`);
  }

  /** Your message in a chat: saved once, then each addressee answers it (or gets it in its inbox if it's working). */
  function post(sessionId: string, input: string, editOf?: number) {
    const s = getSession(db, sessionId);
    if (!s || s.kind !== "chat") throw notFound("no such chat");
    const { handles, team } = addressees(input, Object.values(app.settings.agents), s.agent);
    // A title from the words, not from attachment links.
    const words = input.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
    if (!s.title && words) db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(words.slice(0, 60), sessionId);
    const busyNow = working(sessionId);
    const id = saveMessage(db, sessionId, { role: "user", content: input }, { agent: team ? undefined : handles[0], name: team ? "team" : undefined });
    if (editOf) {
      // The edit replaces the original and everything after it: archived (kept, inspectable), out of every view.
      db.prepare("UPDATE messages SET archived = ? WHERE session_id = ? AND id >= ? AND id < ? AND archived IS NULL").run(id, sessionId, editOf, id);
      db.prepare("UPDATE messages SET edit_of = ? WHERE id = ?").run(editOf, id);
    }
    for (const h of handles) {
      if (busyNow.includes(h)) toInbox(runKey(sessionId, h), { id, text: `${auth.displayName()} wrote:\n${input}` });
      else startRun(sessionId, h, id);
    }
    if (handles.some((h) => busyNow.includes(h))) notify("run", { sessionId, running: true });
    return { id, to: handles, team };
  }

  // Compact a chat in the background (manually, or automatically when its context is nearly full).
  function startCompaction(sessionId: string, brain: string, auto = false) {
    const s = getSession(db, sessionId)!;
    const key = compactKey(sessionId);
    runs.start({ key, kind: "compact", sessionId, title: "compacting" });
    notify("run", { sessionId, running: true, compacting: true });
    compactSession(app, s.id, brain, workdir(app, app.settings.agents[s.agent]?.workdir), auto)
      .catch((e) => makeEmitter(db, { sessionId: s.id })({ type: "error", message: `Compaction failed: ${(e as Error).message}` }))
      .finally(() => { runs.end(key); notify("run", { sessionId: s.id, running: false }); });
  }
  function autoCompact(sessionId: string) {
    const at = app.settings.chat?.auto_compact ?? 0.8;
    if (!at) return;
    const c = db.prepare("SELECT id, data FROM events WHERE session_id = ? AND type = 'context' ORDER BY id DESC LIMIT 1").get(sessionId) as { id: number; data: string } | undefined;
    if (!c) return;
    const { used, window, brain } = JSON.parse(c.data);
    const limit = window ? window * at : 160_000; // unknown window: assume a typical 200k model
    if (used < limit) return;
    const last = db.prepare("SELECT max(id) AS id FROM events WHERE session_id = ? AND type = 'compact'").get(sessionId) as { id: number | null };
    if (last.id && last.id > c.id) return;
    startCompaction(sessionId, brain, true);
  }

  // ── routes ──
  const routes: [string, RegExp, string[], Handler][] = [];
  const route = (method: string, path: string, h: Handler) => {
    const keys: string[] = [];
    const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    routes.push([method, re, keys, h]);
  };

  route("GET", "/api/overview", () => {
    const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
    const tasks = Object.fromEntries((db.prepare("SELECT status, count(*) n FROM tasks GROUP BY status").all() as any[]).map((r) => [r.status, r.n]));
    return {
      counts: {
        sessions: count("SELECT count(*) n FROM sessions WHERE id NOT IN (SELECT session_id FROM tasks WHERE session_id IS NOT NULL)"),
        messages: count("SELECT count(*) n FROM messages"),
        documents: count("SELECT count(*) n FROM documents WHERE parent_id IS NULL"),
        todos: count("SELECT count(*) n FROM todos WHERE done = 0"),
        memories: count("SELECT count(*) n FROM memories"),
        tools: app.registry.tools.size,
        agents: Object.keys(app.settings.agents).length,
        mcp: Object.keys(app.settings.mcp).length,
      },
      tasks,
      worker: opts.worker.current(),
      running: runs.list(),
      approvals: approvals.size,
      cardsForYou: needsYou(db),
      defaultAgent: app.settings.default_agent,
      claude: { version: claudeInfo.version, loggedIn: existsSync(join(claudeConfigDir(), ".credentials.json")) },
      // Only brains an agent relies on: an unused brain that was never logged in isn't worth a warning.
      brainsDown: Object.entries(brains.cachedStatus())
        .filter(([name, st]) => st.state === "logged-out" && Object.values(app.settings.agents).some((a) => a.brain === name))
        .map(([name, st]) => ({ name, detail: st.detail })),
      recentSessions: db.prepare(`SELECT s.id, s.agent, s.title, s.created_at,
          (SELECT max(created_at) FROM messages m WHERE m.session_id = s.id) AS last_at
        FROM sessions s WHERE s.id NOT IN (SELECT session_id FROM tasks WHERE session_id IS NOT NULL)
        ORDER BY coalesce(last_at, s.created_at) DESC LIMIT 6`).all(),
      recentTasks: db.prepare("SELECT id, title, status, agent, updated_at FROM tasks ORDER BY id DESC LIMIT 6").all(),
      activity: db.prepare(`SELECT date(created_at) AS day, count(*) AS n FROM events
        WHERE created_at >= datetime('now', '-13 days') GROUP BY day ORDER BY day`).all(),
    };
  });

  route("GET", "/api/stream", (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
    res.write("retry: 3000\n\n");
    const send = (type: string) => (data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const onAgent = send("agent"), onUi = send("ui"), onDelta = send("delta");
    bus.on("event", onAgent);
    bus.on("delta", onDelta);
    bus.on("ui", onUi);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000); // keeps Cloudflare/Caddy from closing it
    req.on("close", () => { clearInterval(ping); bus.off("event", onAgent); bus.off("ui", onUi); bus.off("delta", onDelta); });
    return KEEP_OPEN;
  });

  // Chats. Sessions that belong to a task are shown under Tasks, not here.
  const lastLine = db.prepare("SELECT content, agent, role, created_at FROM messages WHERE session_id = ? AND role != 'tool' AND trim(content) != '' AND (name IS NULL OR name NOT IN ('handoff')) AND archived IS NULL ORDER BY id DESC LIMIT 1");
  const chatRow = (c: any) => {
    const l = lastLine.get(c.id) as any;
    return { id: c.id, title: c.title, lead: c.agent, private: !!c.private, created_at: c.created_at, archived: !!c.archived,
      members: membersOf(c, Object.keys(app.settings.agents)), working: working(c.id),
      last: l ? { text: l.content.slice(0, 140), agent: l.role === "assistant" ? l.agent : null, at: l.created_at } : null };
  };
  route("GET", "/api/sessions", (req) => {
    const q = req.query.get("q");
    const arch = req.query.get("archived") === "1" ? 1 : 0;
    return (db.prepare(`SELECT s.*, (SELECT max(created_at) FROM messages m WHERE m.session_id = s.id) AS last_at FROM sessions s
      WHERE s.kind = 'chat' AND s.archived = ${arch} ${q ? "AND (s.title LIKE ? OR s.id IN (SELECT session_id FROM messages WHERE content LIKE ? AND archived IS NULL))" : ""}
      ORDER BY coalesce(last_at, s.created_at) DESC LIMIT 200`).all(...(q ? [`%${q}%`, `%${q}%`] : [])) as any[]).map(chatRow);
  });
  // A new chat. The lead answers when nobody is @mentioned (Los unless you pick someone).
  route("POST", "/api/sessions", async (req) => {
    const b = await body(req);
    const lead = String(b.lead ?? app.settings.default_agent);
    if (!app.settings.agents[lead]) throw bad(`unknown agent "${lead}"`);
    const id = createSession(db, lead, String(b.title || "").trim().slice(0, 80) || undefined);
    if (b.input && String(b.input).trim()) post(id, String(b.input).trim());
    notify("rooms");
    return { id };
  });
  // Tool output is stored in full; the chat only needs a taste of it (Inspect shows everything).
  const PREVIEW = 2000;
  const lighten = (e: any) => {
    const d = JSON.parse(e.data);
    if (d.type === "tool_result" && d.output) { d.long = d.output.length; delete d.output; }
    if (d.type === "request") { delete d.system; delete d.preface; } // the context export has them
    return { ...e, data: d };
  };
  route("GET", "/api/sessions/:id", (req) => {
    const s = getSession(db, req.params.id);
    if (!s) throw notFound("no such session");
    return {
      ...s,
      tools: JSON.parse(s.tools),
      allow: JSON.parse(s.allow ?? "[]"),
      members: membersOf(s, Object.keys(app.settings.agents)),
      working: working(s.id),
      live: live(s.id),
      running: working(s.id).length > 0,
      compacting: compacting(s.id),
      messages: db.prepare(`SELECT id, role, CASE WHEN role = 'tool' AND length(content) > ${PREVIEW} THEN substr(content, 1, ${PREVIEW}) ELSE content END AS content,
        CASE WHEN role = 'tool' THEN length(content) END AS length, tool_calls, tool_call_id, name, brain, agent, turn, archived, edit_of, created_at
        FROM messages WHERE session_id = ? ORDER BY id`).all(s.id),
      events: (db.prepare("SELECT id, turn, agent, type, data, created_at FROM events WHERE session_id = ? ORDER BY id").all(s.id) as any[]).map(lighten),
      plan: db.prepare("SELECT agent, turn, idx, text, status FROM plan_steps WHERE session_id = ? ORDER BY agent, idx").all(s.id),
      approvals: approvals.list({ sessionId: s.id }),
      task: db.prepare("SELECT id, title, status FROM tasks WHERE session_id = ?").get(s.id) ?? null,
    };
  });
  // Everything about one agent's run, in full: every event (with whole tool outputs) and every message it wrote.
  route("GET", "/api/sessions/:id/inspect", (req) => {
    const turn = Number(req.query.get("turn")), agent = req.query.get("agent");
    const s = getSession(db, req.params.id);
    if (!s || !turn) throw notFound("no such run");
    const msgs = db.prepare(`SELECT * FROM messages WHERE session_id = ? AND (id = ? OR (turn = ? AND role = 'assistant' AND (? IS NULL OR agent = ?)))
      ORDER BY id`).all(s.id, turn, turn, agent, agent) as any[];
    const ids = new Set(msgs.flatMap((m) => (m.tool_calls ? JSON.parse(m.tool_calls).map((c: any) => c.id) : [])));
    const results = (db.prepare("SELECT * FROM messages WHERE session_id = ? AND turn = ? AND role = 'tool'").all(s.id, turn) as any[]).filter((m) => ids.has(m.tool_call_id));
    return {
      turn: msgs.find((m) => m.id === turn) ?? null,
      messages: [...msgs.filter((m) => m.id !== turn), ...results].sort((x, y) => x.id - y.id),
      events: (db.prepare("SELECT id, type, agent, data, created_at FROM events WHERE session_id = ? AND turn = ? AND (? IS NULL OR agent = ? OR agent IS NULL) ORDER BY id")
        .all(s.id, turn, agent, agent) as any[]).map((e) => ({ ...e, data: JSON.parse(e.data) })),
    };
  });
  // The exact request one step of an agent's run sent, as an OpenAI chat-completions body: rebuilt from that step's
  // "request" note (system prompt, last visible message, budget, tools) over the append-only messages.
  // The exact request one step of an agent's run sent, as an OpenAI chat-completions body (requestContext()).
  route("GET", "/api/sessions/:id/context", (req) => {
    const turn = Number(req.query.get("turn")), want = req.query.get("step");
    if (!getSession(db, req.params.id) || !turn) throw notFound("no such run");
    try { return requestContext(app, req.params.id, turn, req.query.get("agent") ?? "", want == null ? undefined : Number(want)); }
    catch (e) { throw notFound((e as Error).message); }
  });
  route("PATCH", "/api/sessions/:id", async (req) => {
    const s = getSession(db, req.params.id);
    if (!s) throw notFound("no such session");
    const b = await body(req);
    if ("title" in b) db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(String(b.title).slice(0, 80), s.id);
    if ("archived" in b) db.prepare("UPDATE sessions SET archived = ? WHERE id = ?").run(b.archived ? 1 : 0, s.id);
    if ("bypass" in b) setBypass(s.id, !!b.bypass);
    if (b.lead) {
      if (!app.settings.agents[b.lead]) throw bad(`unknown agent "${b.lead}"`);
      db.prepare("UPDATE sessions SET agent = ? WHERE id = ?").run(b.lead, s.id);
      joinChat(db, s, b.lead);
    }
    notify("rooms");
    return { ok: true };
  });
  // Bypass: tools that need approval run without asking in this chat (or task session). Switching it on also lets
  // through whatever is waiting for an answer there right now.
  function setBypass(sessionId: string, on: boolean) {
    db.prepare("UPDATE sessions SET bypass = ? WHERE id = ?").run(on ? 1 : 0, sessionId);
    if (on) for (const a of approvals.list({ sessionId })) approvals.answer(a.id, true);
    console.log(`bypass ${on ? "ON" : "off"} for session ${sessionId}`);
  }
  route("DELETE", "/api/sessions/:id", (req) => {
    const id = req.params.id;
    if (busy(id)) throw new HttpError(409, "this chat is still working");
    db.transaction(() => {
      for (const sql of ["DELETE FROM messages WHERE session_id = ?", "DELETE FROM events WHERE session_id = ?",
        "DELETE FROM plan_steps WHERE session_id = ?", "DELETE FROM sessions WHERE id = ?"]) db.prepare(sql).run(id);
    })();
    notify("rooms");
    return { ok: true };
  });
  route("POST", "/api/sessions/:id/messages", async (req) => {
    const { input } = await body(req);
    if (!input || !String(input).trim()) throw bad("empty message");
    return post(req.params.id, String(input).trim());
  });
  // Summarise the chat so far with a brain of the user's choice; every brain continues from the summary.
  route("POST", "/api/sessions/:id/compact", async (req) => {
    const s = getSession(db, req.params.id);
    if (!s) throw notFound("no such session");
    if (busy(s.id)) throw new HttpError(409, "this chat is working; compact when it's done");
    const agent = app.settings.agents[s.agent];
    const brain = String((await body(req)).brain || s.brain || agent?.brain || "");
    if (!app.settings.brains[brain]) throw bad(`unknown brain "${brain}"`);
    startCompaction(s.id, brain);
    return { ok: true };
  });
  // The conversation as one standard JSON document (OpenAI Responses-style items).
  route("GET", "/api/sessions/:id/conversation", (req) => {
    const s = getSession(db, req.params.id);
    if (!s) throw notFound("no such session");
    return exportConversation(app, s.id);
  });
  // Edit one of your messages: the chat continues from the edited version. The original and everything after it are
  // archived (not deleted: still in Inspect/Events and shown on request), and the addressees answer the new text.
  route("POST", "/api/sessions/:id/messages/:mid/edit", async (req) => {
    const s = getSession(db, req.params.id), mid = Number(req.params.mid), input = String((await body(req)).input ?? "").trim();
    if (!s) throw notFound("no such chat");
    if (!input) throw bad("empty message");
    const m = db.prepare("SELECT * FROM messages WHERE id = ? AND session_id = ? AND role = 'user' AND archived IS NULL").get(mid, s.id) as any;
    if (!m || (m.name && m.name !== "team")) throw bad("only your own messages can be edited");
    // Whoever is still working on the old version stops first (their late output would land in the new branch).
    const busyNow = working(s.id);
    for (const a of busyNow) { inbox.delete(runKey(s.id, a)); runs.stop(runKey(s.id, a), "Stopped: the message was edited."); }
    const until = Date.now() + 5000;
    while (Date.now() < until && working(s.id).length) await new Promise((r) => setTimeout(r, 100));
    if (working(s.id).length) throw new HttpError(409, "couldn't stop everyone in time; try again");
    const r = post(s.id, input, mid);
    notify("rooms");
    return r;
  });
  // ── a chat's files: its own workspace folder (uploads land there, agents are told to save its files there) ──
  const slug = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "chat";
  function chatFolder(sessionId: string): string {
    const s = getSession(db, sessionId);
    if (!s) throw notFound("no such chat");
    if (s.folder) return s.folder;
    const folder = `chats/${new Date().toISOString().slice(0, 10)}-${slug(s.title ?? "chat")}-${s.id.slice(0, 6)}`;
    mkdirSync(wsPath(app, folder).full, { recursive: true });
    db.prepare("UPDATE sessions SET folder = ? WHERE id = ?").run(folder, s.id);
    return folder;
  }
  const fileLink = (rel: string) => `/files/${rel.split("/").map(encodeURIComponent).join("/")}`;
  route("POST", "/api/sessions/:id/files", async (req) => {
    const folder = chatFolder(req.params.id);
    const name = String(req.query.get("name") ?? "file").replace(/[\/\\]/g, "-").replace(/^\.+/, "").replace(/[^\p{L}\p{N}._ ()-]+/gu, "-").slice(0, 120) || "file";
    const dot = name.lastIndexOf("."), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
    let rel = `${folder}/${name}`;
    for (let i = 2; existsSync(wsPath(app, rel).full); i++) rel = `${folder}/${base} (${i})${ext}`; // never overwrite
    const { full } = wsErr(() => wsPath(app, rel));
    const data = await rawBody(req, 50 * 1024 * 1024);
    writeFileSync(full, data);
    notify("workspace");
    return { path: rel, url: fileLink(rel), size: data.length, image: /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(rel) };
  });
  route("GET", "/api/sessions/:id/files", (req) => {
    const s = getSession(db, req.params.id);
    if (!s) throw notFound("no such chat");
    if (!s.folder || !existsSync(wsPath(app, s.folder).full)) return { folder: s.folder ?? null, files: [] };
    const out: { path: string; name: string; size: number; modified: string; image: boolean; url: string }[] = [];
    const walk = (rel: string) => {
      for (const n of readdirSync(wsPath(app, rel).full)) {
        if (n.startsWith(".") || out.length >= 300) continue;
        const p = `${rel}/${n}`, st = statSync(wsPath(app, p).full);
        if (st.isDirectory()) walk(p);
        else out.push({ path: p, name: p.slice(s.folder!.length + 1), size: st.size, modified: st.mtime.toISOString(), image: /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(n), url: fileLink(p) });
      }
    };
    walk(s.folder);
    return { folder: s.folder, files: out.sort((a, b) => b.modified.localeCompare(a.modified)) };
  });
  // The whole visible conversation as Markdown (to keep or paste elsewhere).
  route("GET", "/api/sessions/:id/markdown", (req) => {
    const s = getSession(db, req.params.id);
    if (!s) throw notFound("no such chat");
    const rows = db.prepare(`SELECT role, content, agent, name, created_at FROM messages WHERE session_id = ? AND archived IS NULL
      AND role != 'tool' AND trim(content) != '' AND (name IS NULL OR name NOT IN ('handoff', 'wake')) AND tool_calls IS NULL ORDER BY id`).all(s.id) as any[];
    const who = (r: any) => r.role === "user" ? auth.displayName() : nameOf(r.agent ?? "assistant");
    return { name: `${slug(s.title ?? "chat")}.md`, markdown: `# ${s.title ?? "Chat"}\n\n` +
      rows.map((r) => `**${who(r)}** · ${r.created_at.slice(0, 16)} UTC${r.name === "report" ? " · report" : ""}\n\n${r.content.trim()}\n`).join("\n---\n\n") };
  });
  // Run an agent's turn again ({turn, agent}): after a stop, an error or a stalled brain. Same message, same agent.
  route("POST", "/api/sessions/:id/retry", async (req) => {
    const b = await body(req), turn = Number(b.turn), agent = String(b.agent ?? "");
    const s = getSession(db, req.params.id);
    if (!s || !turn || !app.settings.agents[agent]) throw bad("retry needs a chat, a turn and an agent");
    if (working(s.id).includes(agent)) throw new HttpError(409, `${nameOf(agent)} is already working here`);
    const m = db.prepare("SELECT id FROM messages WHERE id = ? AND session_id = ? AND role = 'user' AND archived IS NULL").get(turn, s.id);
    if (!m) throw notFound("no such message in this chat");
    startRun(s.id, agent, turn);
    return { ok: true };
  });
  // Stop one agent ({agent}) or everyone working in the chat.
  route("POST", "/api/sessions/:id/stop", async (req) => {
    const only = (await body(req)).agent;
    const who = working(req.params.id).filter((a) => !only || a === only);
    if (!who.length) throw new HttpError(409, "nothing is running in this chat");
    for (const a of who) { inbox.delete(runKey(req.params.id, a)); runs.stop(runKey(req.params.id, a)); }
    return { ok: true, stopped: who };
  });
  // {granted, always}: always = allow this tool for the rest of the chat (it won't ask again there).
  route("POST", "/api/approvals/:id", async (req) => {
    const b = await body(req);
    const ap = approvals.list().find((a) => a.id === req.params.id);
    if (!ap) throw notFound("approval expired");
    if (b.granted && b.always) allowIn(db, ap.sessionId, ap.call.name);
    approvals.answer(ap.id, !!b.granted);
    return { ok: true };
  });
  route("GET", "/api/approvals", () => approvals.list().map((a) => ({
    ...a, task: a.taskId ? db.prepare("SELECT id, title, agent FROM tasks WHERE id = ?").get(a.taskId) : null,
  })));

  // Tasks
  route("GET", "/api/tasks", (req) => {
    const status = req.query.get("status");
    return db.prepare(`SELECT id, title, status, agent, brain, parent_id, session_id, private, run_at, created_at, updated_at, report_to, job_id, bypass,
        substr(result, 1, 280) AS result FROM tasks ${status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT 300`)
      .all(...(status ? [status] : []));
  });
  route("POST", "/api/tasks", async (req) => {
    const b = await body(req);
    const prompt = String(b.prompt ?? "").trim();
    if (!prompt) throw bad("prompt is required");
    if (b.agent && !app.settings.agents[b.agent]) throw bad(`unknown agent "${b.agent}"`);
    if (b.brain && !app.settings.brains[b.brain]) throw bad(`unknown brain "${b.brain}"`);
    const id = createTask(db, {
      title: String(b.title || prompt.replace(/\s+/g, " ").slice(0, 70)), prompt,
      agent: b.agent || undefined, brain: b.brain || undefined, runAt: b.run_at ? parseWhen(app.settings, String(b.run_at)) : undefined,
      reportTo: b.report_to || undefined, bypass: !!b.bypass,
    });
    notify("tasks");
    return { id };
  });
  route("GET", "/api/tasks/:id", (req) => {
    const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(req.params.id)) as any;
    if (!t) throw notFound("no such task");
    return {
      ...t,
      events: db.prepare("SELECT id, type, data, created_at FROM events WHERE task_id = ? ORDER BY id").all(t.id),
      children: db.prepare("SELECT id, title, status, agent FROM tasks WHERE parent_id = ?").all(t.id),
    };
  });
  route("PATCH", "/api/tasks/:id", async (req) => {
    const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(req.params.id)) as any;
    if (!t) throw notFound("no such task");
    const b = await body(req);
    if ("bypass" in b) {
      db.prepare("UPDATE tasks SET bypass = ? WHERE id = ?").run(b.bypass ? 1 : 0, t.id);
      if (t.session_id) setBypass(t.session_id, !!b.bypass); // already started: its session too (and what it waits for)
    }
    notify("tasks");
    return { ok: true };
  });
  route("POST", "/api/tasks/:id/cancel", (req) => {
    const id = Number(req.params.id);
    if (runs.stop(`task:${id}`)) return { ok: true, stopping: true };
    const r = db.prepare("UPDATE tasks SET status = 'cancelled', result = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'queued'").run(id);
    if (!r.changes) throw new HttpError(409, "only queued or running tasks can be cancelled");
    notify("tasks");
    return { ok: true };
  });
  route("POST", "/api/tasks/:id/retry", (req) => {
    const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(req.params.id)) as any;
    if (!t) throw notFound("no such task");
    const id = createTask(db, { title: t.title, prompt: t.prompt, agent: t.agent ?? undefined, brain: t.brain ?? undefined, parentId: t.parent_id ?? undefined, bypass: !!t.bypass });
    notify("tasks");
    return { id };
  });
  route("DELETE", "/api/tasks/:id", (req) => {
    const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(req.params.id)) as any;
    if (!t) throw notFound("no such task");
    if (["running", "waiting"].includes(t.status)) throw new HttpError(409, "task is running");
    db.transaction(() => {
      db.prepare("UPDATE tasks SET parent_id = NULL WHERE parent_id = ?").run(t.id);
      db.prepare("DELETE FROM events WHERE task_id = ?").run(t.id);
      db.prepare("DELETE FROM tasks WHERE id = ?").run(t.id);
    })();
    notify("tasks");
    return { ok: true };
  });

  // Jobs: recurring schedules (the jobs_* tools write the same table).
  const jobView = (j: any) => ({ ...j, enabled: !!j.enabled, next_local: fmtLocal(app.settings, j.next_run), last_local: fmtLocal(app.settings, j.last_run),
    last_status: j.last_task ? (db.prepare("SELECT status FROM tasks WHERE id = ?").get(j.last_task) as any)?.status ?? null : null,
    report_title: j.report_to ? (db.prepare("SELECT title FROM sessions WHERE id = ?").get(j.report_to) as any)?.title ?? null : null });
  route("GET", "/api/jobs", () => (db.prepare("SELECT * FROM jobs ORDER BY id").all() as any[]).map(jobView));
  route("POST", "/api/jobs", async (req) => {
    const b = await body(req);
    if (!String(b.prompt ?? "").trim() || !String(b.schedule ?? "").trim()) throw bad("prompt and schedule are required");
    try { checkSchedule(b.schedule); } catch (e) { throw bad((e as Error).message); }
    if (b.agent && !app.settings.agents[b.agent]) throw bad(`unknown agent "${b.agent}"`);
    const id = Number(db.prepare("INSERT INTO jobs (title, prompt, schedule, agent, brain, report_to, next_run, bypass) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(String(b.title || b.prompt).slice(0, 80), b.prompt, b.schedule.trim(), b.agent || null, b.brain || null, b.report_to || null,
        sqlUtc(nextRun(app.settings, b.schedule)), b.bypass ? 1 : 0).lastInsertRowid);
    notify("tasks");
    return jobView(db.prepare("SELECT * FROM jobs WHERE id = ?").get(id));
  });
  route("PATCH", "/api/jobs/:id", async (req) => {
    const j = db.prepare("SELECT * FROM jobs WHERE id = ?").get(Number(req.params.id)) as any;
    if (!j) throw notFound("no such job");
    const b = await body(req);
    if (b.schedule) try { checkSchedule(b.schedule); } catch (e) { throw bad((e as Error).message); }
    const schedule = b.schedule?.trim() ?? j.schedule, enabled = b.enabled ?? !!j.enabled;
    const next = b.run_now ? sqlUtc(new Date()) : enabled ? sqlUtc(nextRun(app.settings, schedule)) : null;
    db.prepare("UPDATE jobs SET title = ?, prompt = ?, schedule = ?, agent = ?, enabled = ?, next_run = ?, bypass = ? WHERE id = ?")
      .run(b.title ?? j.title, b.prompt ?? j.prompt, schedule, "agent" in b ? b.agent || null : j.agent, enabled || b.run_now ? 1 : 0, next,
        "bypass" in b ? (b.bypass ? 1 : 0) : j.bypass, j.id);
    notify("tasks");
    return jobView(db.prepare("SELECT * FROM jobs WHERE id = ?").get(j.id));
  });
  // Boards (kanban): you are "me". The rules (agent queue, who may move cards) are in core/boards.ts.
  const boardOut = (b: BoardRow) => ({ ...b, columns: columnsOf(b), agents_move: !!b.agents_move, bypass: !!b.bypass,
    counts: Object.fromEntries((db.prepare("SELECT col, count(*) n FROM cards WHERE board_id = ? GROUP BY col").all(b.id) as any[]).map((r) => [r.col, r.n])),
    mine: (db.prepare("SELECT count(*) n FROM cards WHERE board_id = ? AND assignee = 'me'").get(b.id) as any).n,
    report_title: b.report_to ? (db.prepare("SELECT title FROM sessions WHERE id = ?").get(b.report_to) as any)?.title ?? null : null });
  const cardOut = (c: CardRow) => ({ ...c, tags: JSON.parse(c.tags), bypass: !!c.bypass,
    task: db.prepare("SELECT id, status, agent FROM tasks WHERE card_id = ? ORDER BY id DESC LIMIT 1").get(c.id) ?? null,
    comments: (db.prepare("SELECT count(*) n FROM card_events WHERE card_id = ? AND type IN ('comment', 'result')").get(c.id) as any).n });
  const boardsDo = <T>(fn: () => T): T => { try { return fn(); } catch (e) { if (e instanceof BoardError) throw bad(e.message); throw e; } };
  const boardBody = (b: any) => {
    if (b.owner && !app.settings.agents[b.owner]) throw bad(`unknown agent "${b.owner}"`);
    if (b.report_to && !getSession(db, b.report_to)) throw bad("no such chat");
    return b;
  };
  route("GET", "/api/boards", () => ({ boards: (db.prepare("SELECT * FROM boards ORDER BY id").all() as BoardRow[]).map(boardOut), needsYou: needsYou(db) }));
  route("POST", "/api/boards", async (req) => {
    const b = boardBody(await body(req));
    const id = boardsDo(() => createBoard(db, { name: String(b.name ?? ""), description: b.description || undefined,
      columns: parseColumns(b.columns ?? ["To do", "Doing", "Done (done)"]), owner: b.owner || null, agentsMove: !!b.agents_move, reportTo: b.report_to || null }));
    if (b.bypass) db.prepare("UPDATE boards SET bypass = 1 WHERE id = ?").run(id);
    return boardOut(getBoard(db, id));
  });
  route("GET", "/api/boards/:id", (req) => {
    const b = boardsDo(() => getBoard(db, req.params.id));
    return { ...boardOut(b), cards: (db.prepare("SELECT * FROM cards WHERE board_id = ? ORDER BY priority DESC, updated_at DESC").all(b.id) as CardRow[]).map(cardOut) };
  });
  route("PATCH", "/api/boards/:id", async (req) => {
    const old = boardsDo(() => getBoard(db, req.params.id));
    const b = boardBody(await body(req));
    const cols = b.columns ? boardsDo(() => parseColumns(b.columns)) : columnsOf(old);
    const used = (db.prepare("SELECT DISTINCT col FROM cards WHERE board_id = ?").all(old.id) as { col: string }[]).map((r) => r.col);
    const gone = used.filter((c) => !cols.some((x) => x.name === c));
    if (gone.length) throw bad(`these columns still have cards: ${gone.join(", ")}. Move them first.`);
    if (b.name && b.name.trim().toLowerCase() !== old.name.toLowerCase() && db.prepare("SELECT 1 FROM boards WHERE lower(name) = lower(?)").get(b.name.trim()))
      throw bad(`there's already a board called "${b.name.trim()}"`);
    db.prepare("UPDATE boards SET name = ?, description = ?, columns = ?, owner = ?, agents_move = ?, bypass = ?, report_to = ? WHERE id = ?").run(
      b.name?.trim() || old.name, "description" in b ? b.description || null : old.description, JSON.stringify(cols),
      "owner" in b ? b.owner || null : old.owner, "agents_move" in b ? (b.agents_move ? 1 : 0) : old.agents_move,
      "bypass" in b ? (b.bypass ? 1 : 0) : old.bypass, "report_to" in b ? b.report_to || null : old.report_to, old.id);
    notify("boards", { boardId: old.id });
    return boardOut(getBoard(db, old.id));
  });
  route("DELETE", "/api/boards/:id", (req) => {
    const b = boardsDo(() => getBoard(db, req.params.id));
    db.transaction(() => {
      db.prepare("DELETE FROM card_events WHERE card_id IN (SELECT id FROM cards WHERE board_id = ?)").run(b.id);
      db.prepare("DELETE FROM cards WHERE board_id = ?").run(b.id);
      db.prepare("DELETE FROM boards WHERE id = ?").run(b.id);
    })();
    notify("boards", { boardId: b.id });
    return { ok: true };
  });
  route("POST", "/api/boards/:id/cards", async (req) => {
    const b = await body(req);
    const id = boardsDo(() => addCard(app, req.params.id, { title: String(b.title ?? ""), body: b.body || undefined, link: b.link || undefined,
      image: b.image || undefined, tags: b.tags, key: b.key || undefined, column: b.column || undefined, assignee: b.assignee || null, priority: Number(b.priority) || 0 }, ME));
    if (b.bypass) db.prepare("UPDATE cards SET bypass = 1 WHERE id = ?").run(id);
    return cardOut(getCard(db, id));
  });
  route("GET", "/api/cards/:id", (req) => {
    const c = boardsDo(() => getCard(db, Number(req.params.id)));
    return { ...cardOut(c), events: cardEvents(db, c.id, 500),
      tasks: db.prepare("SELECT id, status, agent, created_at FROM tasks WHERE card_id = ? ORDER BY id DESC LIMIT 20").all(c.id) };
  });
  route("PATCH", "/api/cards/:id", async (req) => {
    const b = await body(req);
    const p: Record<string, unknown> = {};
    for (const k of ["title", "body", "link", "image", "tags", "column", "priority", "comment", "bypass"]) if (k in b) p[k] = b[k];
    if ("assignee" in b) p.assignee = b.assignee || null;
    return cardOut(boardsDo(() => updateCard(app, Number(req.params.id), p, ME)));
  });
  route("DELETE", "/api/cards/:id", (req) => {
    const id = Number(req.params.id);
    const t = db.prepare("SELECT id FROM tasks WHERE card_id = ? AND status IN ('queued', 'running', 'waiting')").get(id) as any;
    if (t) throw new HttpError(409, `task #${t.id} is working on this card; stop it first`);
    boardsDo(() => deleteCard(db, id));
    return { ok: true };
  });

  route("DELETE", "/api/jobs/:id", (req) => {
    db.prepare("DELETE FROM jobs WHERE id = ?").run(Number(req.params.id));
    notify("tasks");
    return { ok: true };
  });

  // The collaboration space: the team (with who's working right now) and the rooms, for the sidebar.
  const agentStatus = (name: string) => {
    const a = app.settings.agents[name];
    const run = runs.list().find((r) => r.agent === name);
    const st = a && brains.cachedStatus()[a.brain];
    return run ? { state: "working", detail: run.kind === "task" ? `on a task: ${run.title}` : "answering", sessionId: run.sessionId }
      : st && !st.ok ? { state: "away", detail: friendlyAway(a.brain, st) } : { state: "idle", detail: "" };
  };
  // Why a teammate can't work, in words for people (the Brains page has the technical detail).
  const friendlyAway = (brain: string, st: { state: string; detail: string }) => {
    const b = app.settings.brains[brain];
    if (st.state === "logged-out") return `away: ${b?.label ?? brain} needs logging in`;
    if (b?.local && /unreachable/i.test(st.detail)) return "away: needs a local model";
    if (/no .*key/i.test(st.detail)) return "away: needs an API key";
    return "away";
  };
  // ── profile: display name ({{name}} for the agents), password, two-factor login ──
  const profileView = () => ({ username: auth.username(), displayName: auth.displayName(), twoFactor: auth.twoFactor(), recoveryLeft: auth.recoveryLeft() });
  route("GET", "/api/profile", () => profileView());
  route("PUT", "/api/profile", async (req) => {
    const b = await body(req);
    if ("displayName" in b) auth.setDisplayName(String(b.displayName ?? ""));
    notify("config");
    return profileView();
  });
  route("POST", "/api/profile/password", async (req, res) => {
    const b = await body(req);
    const err = auth.changePassword(res, String(b.current ?? ""), String(b.next ?? ""));
    if (err) throw bad(err);
    return { ok: true };
  });
  route("POST", "/api/profile/2fa/start", async () => {
    if (auth.twoFactor()) throw bad("Two-factor login is already on. Turn it off first to set up a new phone.");
    const { secret, uri } = auth.startTwoFactor();
    return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  });
  route("POST", "/api/profile/2fa/confirm", async (req) => {
    const r = auth.confirmTwoFactor(String((await body(req)).code ?? ""));
    if (r.error) throw bad(r.error);
    return { recovery: r.recovery };
  });
  route("POST", "/api/profile/2fa/disable", async (req) => {
    const b = await body(req);
    const err = auth.disableTwoFactor(String(b.password ?? ""), String(b.code ?? ""));
    if (err) throw bad(err);
    return profileView();
  });
  route("POST", "/api/profile/2fa/recovery", async (req) => {
    const b = await body(req);
    const r = auth.newRecoveryCodes(String(b.password ?? ""), String(b.code ?? ""));
    if (r.error) throw bad(r.error);
    return { recovery: r.recovery };
  });

  // The sidebar: the team (with who's working right now) and the chats.
  route("GET", "/api/space", () => ({
    me: { name: auth.displayName() },
    agents: Object.values(app.settings.agents).sort((x, y) =>
      Number(y.name === app.settings.default_agent) - Number(x.name === app.settings.default_agent) ||
      Number(agentStatus(x.name).state === "away") - Number(agentStatus(y.name).state === "away") || x.displayName.localeCompare(y.displayName)).map((a) => ({
      handle: a.name, name: a.displayName, title: fill(app, a.title), emoji: a.emoji, description: fill(app, a.description), skills: a.skills,
      lead: a.name === app.settings.default_agent, status: agentStatus(a.name),
    })),
    archivedChats: (db.prepare("SELECT count(*) AS n FROM sessions WHERE kind = 'chat' AND archived = 1").get() as any).n,
    chats: (db.prepare(`SELECT s.*, (SELECT max(created_at) FROM messages m WHERE m.session_id = s.id) AS last_at FROM sessions s
      WHERE s.kind = 'chat' AND s.archived = 0 ORDER BY coalesce(last_at, s.created_at) DESC LIMIT 60`).all() as any[]).map(chatRow),
  }));

  // Agents: config/agents/<name>.md. Saved from the Team page's form ({agent}) or as raw markdown ({raw}).
  route("GET", "/api/agents", () => Object.values(app.settings.agents).map((a) => ({
    ...a, title: fill(app, a.title), description: fill(app, a.description), // the personality itself stays as written
    raw: readFileSync(join(configDir(), "agents", `${a.name}.md`), "utf8"),
    brainType: app.settings.brains[a.brain]?.type ?? null,
    local: !!app.settings.brains[a.brain]?.local,
    initial: app.settings.brains[a.brain] ? app.registry.initial(a, !!app.settings.brains[a.brain]?.local) : [],
    reachable: [...app.registry.tools.keys()].filter((n) => app.registry.permitted(a, !!app.settings.brains[a.brain]?.local, n)),
    sessions: (db.prepare("SELECT count(*) n FROM sessions WHERE agent = ?").get(a.name) as any).n,
    tasksDone: (db.prepare("SELECT count(*) n FROM tasks WHERE agent = ? AND status = 'done'").get(a.name) as any).n,
    status: agentStatus(a.name),
    isDefault: a.name === app.settings.default_agent,
  })));
  route("PUT", "/api/agents/:name", async (req) => {
    const name = req.params.name;
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw bad("agent names are lowercase letters, digits, - and _");
    const b = await body(req);
    const raw = b.raw ?? agentMarkdown(b.agent ?? {});
    const file = join(configDir(), "agents", `${name}.md`);
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    writeFileSync(file, String(raw));
    try {
      const agent = loadAgents(join(configDir(), "agents"))[name];
      if (!agent?.brain) throw new Error("frontmatter needs a `brain:`");
      if (!app.settings.brains[agent.brain]) throw new Error(`unknown brain "${agent.brain}"`);
    } catch (e) {
      before === null ? rmSync(file) : writeFileSync(file, before);
      throw bad((e as Error).message);
    }
    await app.reload();
    notify("config");
    return { ok: true };
  });
  route("DELETE", "/api/agents/:name", async (req) => {
    const name = req.params.name;
    if (name === app.settings.default_agent) throw bad("can't delete the default agent");
    const file = join(configDir(), "agents", `${basename(name)}.md`);
    if (!existsSync(file)) throw notFound("no such agent");
    rmSync(file);
    await app.reload();
    notify("config");
    return { ok: true };
  });

  // Tools & plugins
  route("GET", "/api/tools", () => ({
    plugins: [...app.registry.plugins.values()].map((p) => ({ name: p.name, description: p.description, privacy: p.privacy ?? "public" })),
    tools: [...app.registry.tools.values()].map((t) => ({
      name: t.name, plugin: t.plugin, description: t.description, tags: t.tags ?? [],
      privacy: app.registry.isLocalOnly(t.name) ? "local-only" : "public",
      sideEffect: !!t.sideEffect,
      parameters: app.registry.spec(t.name).parameters,
      agents: Object.values(app.settings.agents)
        .filter((a) => app.registry.permitted(a, !!app.settings.brains[a.brain]?.local, t.name)).map((a) => a.name),
    })),
  }));

  // MCP servers: config/mcp.json, editable as raw JSON; saving reconnects.
  route("GET", "/api/mcp", () => {
    const file = join(configDir(), "mcp.json");
    return {
      raw: existsSync(file) ? readFileSync(file, "utf8") : '{\n  "servers": {}\n}\n',
      example: existsSync(join(configDir(), "mcp.example.json")) ? readFileSync(join(configDir(), "mcp.example.json"), "utf8") : null,
      servers: Object.entries(app.settings.mcp).map(([name, cfg]) => ({
        name, transport: cfg.url ? "http" : "stdio", target: cfg.url ?? [cfg.command, ...(cfg.args ?? [])].join(" "),
        privacy: cfg.privacy ?? "public", envKeys: Object.keys(cfg.env ?? {}),
        status: mcpStatus.get(name) ?? null,
        tools: [...app.registry.tools.values()].filter((t) => t.plugin === `mcp_${name.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`)
          .map((t) => ({ name: t.name, description: t.description, sideEffect: !!t.sideEffect })),
      })),
    };
  });
  route("PUT", "/api/mcp", async (req) => {
    const { raw } = await body(req);
    try {
      const parsed = JSON.parse(String(raw));
      if (typeof parsed.servers !== "object" || parsed.servers === null) throw new Error('needs a top-level "servers" object');
    } catch (e) { throw bad(`invalid JSON: ${(e as Error).message}`); }
    writeFileSync(join(configDir(), "mcp.json"), String(raw));
    await app.reload();
    notify("config");
    return { ok: true };
  });

  // Settings
  route("GET", "/api/settings", () => ({
    raw: readFileSync(join(configDir(), "settings.yaml"), "utf8"),
    brains: Object.entries(app.settings.brains).map(([name, b]) => ({
      name, label: b.label ?? null, type: b.type, model: b.model ?? null, local: !!b.local, base_url: b.base_url ?? null,
      keySet: b.api_key_env ? !!process.env[b.api_key_env] : null, api_key_env: b.api_key_env ?? null,
      usedBy: Object.values(app.settings.agents).filter((a) => a.brain === name).map((a) => a.name),
    })),
    privacy: app.settings.privacy,
    routing: app.settings.routing,
    sources: app.settings.sources,
    defaultAgent: app.settings.default_agent,
    claude: { version: claudeInfo.version, loggedIn: existsSync(join(claudeConfigDir(), ".credentials.json")) },
  }));
  route("PUT", "/api/settings", async (req) => {
    const { raw } = await body(req);
    let parsed: any;
    try { parsed = parseYaml(String(raw)); } catch (e) { throw bad(`invalid YAML: ${(e as Error).message}`); }
    if (!parsed?.brains || !parsed?.default_agent) throw bad("settings need `brains` and `default_agent`");
    const file = join(configDir(), "settings.yaml");
    const before = readFileSync(file, "utf8");
    writeFileSync(file, String(raw));
    try {
      await app.reload();
      if (!app.settings.agents[app.settings.default_agent]) throw new Error(`default_agent "${app.settings.default_agent}" doesn't exist`);
    } catch (e) {
      writeFileSync(file, before);
      await app.reload();
      throw bad((e as Error).message);
    }
    notify("config");
    return { ok: true };
  });
  // Brains: the brain manager (add/edit/remove, login status, plan limits, login flows).
  const brainView = (name: string) => {
    const b = app.settings.brains[name];
    const dir = brains.accountDir(name);
    return {
      name, ...b, env: undefined,
      typeLabel: BRAIN_TYPES[b.type]?.label ?? b.type, runtime: BRAIN_TYPES[b.type]?.runtime ?? false,
      canLogin: BRAIN_TYPES[b.type]?.login ?? false, hasLimits: BRAIN_TYPES[b.type]?.limits ?? false,
      accountDir: dir ? dir.replace(app.settings.root + "/", "") : null,
      hostLogin: b.type === "claude-code" && !b.account,
      envKeys: brains.envKeys(name),
      usedBy: Object.values(app.settings.agents).filter((a) => a.brain === name).map((a) => a.name),
      status: brains.cachedStatus()[name] ?? null,
      login: brains.login(name),
    };
  };
  route("GET", "/api/brains", () => ({
    types: BRAIN_TYPES,
    brains: Object.keys(app.settings.brains).map(brainView),
    stats: brains.stats(),
  }));
  route("GET", "/api/brains/:name/status", async (req) => {
    const force = req.query.get("force") === "1";
    const [status, limits] = await Promise.all([brains.status(req.params.name, force), brains.limits(req.params.name, force)]);
    return { status, limits, login: brains.login(req.params.name) };
  });
  const saveBrain = (isNew: boolean) => async (req: Req) => {
    const b = await body(req);
    const name = isNew ? String(b.name ?? "").trim() : req.params.name;
    try { brains.save(name, b.config ?? {}, b.env ?? {}, isNew); } catch (e) { throw bad((e as Error).message); }
    await app.reload();
    notify("config");
    return brainView(name);
  };
  route("POST", "/api/brains", saveBrain(true));
  route("PUT", "/api/brains/:name", saveBrain(false));
  route("DELETE", "/api/brains/:name", async (req) => {
    try { brains.remove(req.params.name); } catch (e) { throw bad((e as Error).message); }
    await app.reload();
    notify("config");
    return { ok: true };
  });
  route("POST", "/api/brains/:name/login", async (req) => {
    try { return await brains.startLogin(req.params.name, { console: !!(await body(req)).console }); } catch (e) { throw bad((e as Error).message); }
  });
  route("GET", "/api/brains/:name/login", (req) => brains.login(req.params.name));
  route("POST", "/api/brains/:name/login/code", async (req) => {
    try { return brains.sendCode(req.params.name, String((await body(req)).code ?? "")); } catch (e) { throw bad((e as Error).message); }
  });
  route("DELETE", "/api/brains/:name/login", (req) => (brains.cancelLogin(req.params.name), { ok: true }));
  route("POST", "/api/brains/:name/logout", async (req) => {
    try { await brains.logout(req.params.name); } catch (e) { throw bad((e as Error).message); }
    notify("brains");
    return { ok: true };
  });
  route("POST", "/api/brains/:name/test", async (req) => {
    const name = req.params.name;
    const brain = getBrain(app.settings, name);
    const started = Date.now();
    const prompt = "Reply with exactly: ok";
    const text = await brain.complete({ system: "You are a connectivity test.", messages: [{ role: "user", content: prompt }], tools: [], cwd: workspace(app) })
      .then((r) => r.text).finally(() => brain.close?.());
    brains.status(name, true).catch(() => {});
    return { ok: true, reply: text.slice(0, 200), ms: Date.now() - started };
  });

  // Files: the inbox folder (what gets ingested) and the knowledge index (what got ingested).
  // Workspace: the shared folder (src/core/workspace.ts). Files are shown at /files/<path>.
  const wsErr = (fn: () => any) => { try { return fn(); } catch (e) { throw bad((e as Error).message); } };
  route("GET", "/api/workspace", (req) => {
    const dir = String(req.query.get("dir") ?? "");
    return wsErr(() => ({ dir: wsPath(app, dir).rel, private: isPrivatePath(db, wsPath(app, dir).rel), entries: listDir(app, dir), ingest, supported: [...SUPPORTED] }));
  });
  route("GET", "/api/workspace/search", async (req) => searchWorkspace(app, String(req.query.get("q") ?? "").trim() || "\u0000"));
  route("POST", "/api/workspace/folder", async (req) => {
    const path = String((await body(req)).path ?? "");
    const { full, rel } = wsErr(() => wsPath(app, path));
    if (existsSync(full)) throw bad("that already exists");
    mkdirSync(full, { recursive: true });
    notify("workspace");
    return { path: rel };
  });
  route("PUT", "/api/workspace/file", async (req) => {
    const { full, rel } = wsErr(() => wsPath(app, String(req.query.get("path") ?? "")));
    if (!rel || basename(rel).startsWith(".")) throw bad("bad file name");
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, await rawBody(req, 200 * 1024 * 1024));
    const priv = req.query.get("private");
    if (priv === "1") setDocPrivacy(WORKSPACE, rel, true);
    notify("workspace");
    return { path: rel };
  });
  route("PATCH", "/api/workspace", async (req) => {
    const b = await body(req);
    const { full, rel } = wsErr(() => wsPath(app, String(req.query.get("path") ?? "")));
    if (!rel || !existsSync(full)) throw notFound("no such file or folder");
    if ("private" in b) {
      setDocPrivacy(WORKSPACE, rel, !!b.private);
      if (b.private) dropShared(db, rel); // private wins: what was shared here stops being shared
    }
    let url: string | null | undefined;
    if ("shared" in b) url = wsErr(() => setShared(app, rel, !!b.shared));
    if (b.to) { // rename / move
      const to = wsErr(() => wsPath(app, String(b.to)));
      if (existsSync(to.full)) throw bad("something with that name is already there");
      mkdirSync(dirname(to.full), { recursive: true });
      renameSync(full, to.full);
      db.prepare("UPDATE file_flags SET external_id = ? || substr(external_id, ?) WHERE source = ? AND (external_id = ? OR external_id LIKE ? || '/%')")
        .run(to.rel, rel.length + 1, WORKSPACE, rel, rel);
      moveShared(db, rel, to.rel); // share links keep working after a move
    }
    notify("workspace");
    return { ok: true, ...(url !== undefined ? { url } : {}) };
  });
  route("DELETE", "/api/workspace", (req) => {
    const { full, rel } = wsErr(() => wsPath(app, String(req.query.get("path") ?? "")));
    if (!rel || !existsSync(full)) throw notFound("no such file or folder");
    rmSync(full, { recursive: true, force: true });
    dropShared(db, rel);
    notify("workspace");
    return { ok: true };
  });
  route("POST", "/api/ingest", async (req) => {
    if (ingest.running) throw new HttpError(409, "ingest is already running");
    const { source } = await body(req);
    ingest.running = true; ingest.log = []; ingest.finishedAt = null;
    const log = (line: string) => { ingest.log.push(line); notify("ingest", { line }); };
    notify("ingest", { running: true });
    (async () => {
      for (const src of app.settings.sources.filter((s) => !source || s.id === source)) {
        log(`syncing ${src.id}…`);
        try {
          const s = await syncSource(app, src, log);
          log(`${src.id}: ${s.added} added, ${s.updated} updated, ${s.skipped} unchanged`);
        } catch (e) { log(`${src.id} failed: ${(e as Error).message}`); }
      }
    })().finally(() => {
      ingest.running = false; ingest.finishedAt = new Date().toISOString();
      notify("ingest", { running: false });
    });
    return { ok: true };
  });
  route("GET", "/api/documents", async (req) => {
    const q = req.query.get("q");
    if (q) return { hits: await search(app, q, { limit: 25 }) };
    return {
      documents: db.prepare(`SELECT d.id, d.source, d.external_id, d.title, d.author, d.date, d.mime, d.summary, d.tags, d.parent_id, d.private,
          length(d.content) AS chars, d.created_at, (SELECT count(*) FROM documents c WHERE c.parent_id = d.id) AS attachments
        FROM documents d ORDER BY d.id DESC LIMIT 500`).all(),
    };
  });
  route("GET", "/api/documents/:id", (req) => {
    const d = db.prepare("SELECT * FROM documents WHERE id = ?").get(Number(req.params.id)) as any;
    if (!d) throw notFound("no such document");
    return {
      ...d, content: d.content.slice(0, 200_000), truncated: d.content.length > 200_000,
      chunks: (db.prepare("SELECT count(*) n FROM chunks WHERE document_id = ?").get(d.id) as any).n,
      attachments: db.prepare("SELECT id, title, mime FROM documents WHERE parent_id = ?").all(d.id),
    };
  });
  route("PATCH", "/api/documents/:id", async (req) => {
    const d = db.prepare("SELECT source, external_id, parent_id FROM documents WHERE id = ?").get(Number(req.params.id)) as any;
    if (!d) throw notFound("no such document");
    const top = d.parent_id ? db.prepare("SELECT source, external_id FROM documents WHERE id = ?").get(d.parent_id) as any : d;
    setDocPrivacy(top.source, top.external_id, !!(await body(req)).private); // attachments follow their mail
    return { ok: true };
  });
  route("DELETE", "/api/documents/:id", (req) => {
    const id = Number(req.params.id);
    const ids = [id, ...(db.prepare("SELECT id FROM documents WHERE parent_id = ?").all(id) as any[]).map((r) => r.id)];
    db.transaction(() => {
      for (const d of ids.reverse()) {
        const chunkIds = (db.prepare("SELECT id FROM chunks WHERE document_id = ?").all(d) as any[]).map((r) => r.id);
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chunks_vec'").get())
          for (const c of chunkIds) db.prepare("DELETE FROM chunks_vec WHERE rowid = ?").run(BigInt(c));
        db.prepare("DELETE FROM chunks WHERE document_id = ?").run(d);
        db.prepare("DELETE FROM documents WHERE id = ?").run(d);
      }
    })();
    return { ok: true };
  });

  // Notebook: todos, memories, mail drafts.
  route("GET", "/api/notes", () => ({
    todos: db.prepare("SELECT * FROM todos ORDER BY done, due IS NULL, due, id DESC").all(),
    memories: db.prepare("SELECT * FROM memories ORDER BY id DESC").all(),
    memoryDefault: app.settings.privacy.memory_default ?? "public",
    drafts: db.prepare("SELECT * FROM mail_drafts ORDER BY id DESC").all(),
  }));
  route("POST", "/api/todos", async (req) => {
    const { text, due } = await body(req);
    if (!text?.trim()) throw bad("empty todo");
    return { id: Number(db.prepare("INSERT INTO todos (text, due) VALUES (?, ?)").run(text.trim(), due || null).lastInsertRowid) };
  });
  route("PATCH", "/api/todos/:id", async (req) => {
    const b = await body(req);
    if ("done" in b) db.prepare("UPDATE todos SET done = ? WHERE id = ?").run(b.done ? 1 : 0, Number(req.params.id));
    if ("text" in b) db.prepare("UPDATE todos SET text = ? WHERE id = ?").run(String(b.text), Number(req.params.id));
    if ("due" in b) db.prepare("UPDATE todos SET due = ? WHERE id = ?").run(b.due || null, Number(req.params.id));
    return { ok: true };
  });
  route("DELETE", "/api/todos/:id", (req) => (db.prepare("DELETE FROM todos WHERE id = ?").run(Number(req.params.id)), { ok: true }));
  route("POST", "/api/memories", async (req) => {
    const { text, tags, private: priv } = await body(req);
    if (!text?.trim()) throw bad("empty memory");
    const p = priv ?? app.settings.privacy.memory_default === "private";
    return { id: Number(db.prepare("INSERT INTO memories (text, tags, private) VALUES (?, ?, ?)").run(text.trim(), tags || null, p ? 1 : 0).lastInsertRowid) };
  });
  route("PATCH", "/api/memories/:id", async (req) => {
    const b = await body(req);
    if ("private" in b) db.prepare("UPDATE memories SET private = ? WHERE id = ?").run(b.private ? 1 : 0, Number(req.params.id));
    return { ok: true };
  });
  route("DELETE", "/api/memories/:id", (req) => (db.prepare("DELETE FROM memories WHERE id = ?").run(Number(req.params.id)), { ok: true }));
  route("DELETE", "/api/drafts/:id", (req) => (db.prepare("DELETE FROM mail_drafts WHERE id = ?").run(Number(req.params.id)), { ok: true }));

  // Event log
  // The event log. Tool results ride along with their call (status, preview, how long it took) instead of being
  // separate rows; the full arguments and result come from /api/events/:id/full when a call is opened.
  route("GET", "/api/events", (req) => {
    const before = Number(req.query.get("before") ?? 0) || Number.MAX_SAFE_INTEGER;
    const type = req.query.get("type");
    const rows = db.prepare(`SELECT e.id, e.session_id, e.task_id, e.turn, e.agent, e.type, e.data, e.created_at, s.title AS session_title
      FROM events e LEFT JOIN sessions s ON s.id = e.session_id
      WHERE e.id < ? ${type ? "AND e.type = ?" : "AND e.type != 'tool_result'"} ORDER BY e.id DESC LIMIT 200`).all(before, ...(type ? [type] : [])) as any[];
    const result = db.prepare(`SELECT id, data, created_at FROM events WHERE type = 'tool_result' AND id > ?
      AND coalesce(session_id, '') = coalesce(?, '') AND json_extract(data, '$.id') = ? ORDER BY id LIMIT 1`);
    return rows.map((e) => {
      const d = JSON.parse(e.data);
      if (d.type === "tool_result" && d.output) { d.long = d.output.length; delete d.output; }
      if (d.type === "request") { if (d.system) d.system = `${d.system.length} chars`; if (d.preface) d.preface = `${d.preface.length} chars`; }
      if (d.type !== "tool_call") return { ...e, data: d };
      const r = result.get(e.id, e.session_id, d.call.id) as any;
      const rd = r && JSON.parse(r.data);
      return { ...e, data: d, result: r ? { ok: rd.ok, preview: rd.preview, at: r.created_at, ms: Date.parse(r.created_at.replace(" ", "T") + "Z") - Date.parse(e.created_at.replace(" ", "T") + "Z") } : null };
    });
  });
  route("GET", "/api/events/:id/full", (req) => {
    const e = db.prepare("SELECT * FROM events WHERE id = ?").get(Number(req.params.id)) as any;
    if (!e) throw notFound("no such event");
    const d = JSON.parse(e.data);
    if (d.type !== "tool_call") return { event: d };
    const r = db.prepare(`SELECT data, created_at FROM events WHERE type = 'tool_result' AND id > ? AND coalesce(session_id, '') = coalesce(?, '')
      AND json_extract(data, '$.id') = ? ORDER BY id LIMIT 1`).get(e.id, e.session_id, d.call.id) as any;
    const rd = r ? JSON.parse(r.data) : null;
    // los's own tools: the result as stored (in full) in the conversation. A runtime's built-ins: the event's output.
    const msg = e.session_id ? db.prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'tool' AND tool_call_id = ? ORDER BY id DESC LIMIT 1")
      .get(e.session_id, d.call.id) as any : null;
    return { call: d.call, ok: rd?.ok ?? null, result: msg?.content ?? rd?.output ?? rd?.preview ?? null, at: r?.created_at ?? null };
  });

  // ── login ──
  const auth = createAuth(join(app.settings.root, "data/auth.json"));
  if (!auth.configured()) console.warn("no data/auth.json: nobody can log in until you run `npm run password`");
  const safeNext = (n: unknown) => (typeof n === "string" && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/login") ? n : "/");
  const loginPage = (res: ServerResponse, status: number, o: { next?: string; user?: string; error?: string; pending?: string; host?: string } = {}) => {
    let html = readFileSync(join(webRoot, "login.html"), "utf8")
      .replace("<!--ERROR-->", o.error ? `<div class="msg-err">${escHtml(o.error)}</div>` : "")
      .replace("<!--NEXT-->", escHtml(safeNext(o.next)))
      .replace("<!--USER-->", escHtml(o.user ?? ""))
      .replace("<!--HOST-->", escHtml(o.host ?? ""));
    // Step 2 of a login with two-factor: the code from the authenticator app (or a recovery code).
    if (o.pending) html = html.replace(/<form class="card"[\s\S]*?<\/form>/, `<form class="card" method="post" action="/login">
      <h1>Two-factor code</h1>
      <p class="sub">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
      ${o.error ? `<div class="msg-err">${escHtml(o.error)}</div>` : ""}
      <input type="hidden" name="next" value="${escHtml(safeNext(o.next))}">
      <input type="hidden" name="pending" value="${escHtml(o.pending)}">
      <label class="field">Code<input class="input" name="code" inputmode="numeric" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" required autofocus></label>
      <button class="btn primary" type="submit">Continue</button>
    </form>`);
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...HARDEN, "content-security-policy": appCsp() });
    res.end(html);
  };
  const PUBLIC = new Set(["/style.css", "/favicon.svg", "/theme.js"]);
  try { filesOrigin = app.settings.web?.files_url ? new URL(app.settings.web.files_url).origin : ""; } catch { filesOrigin = ""; }

  // ── server ──
  const server = createServer(async (rq, res) => {
    const req = rq as Req;
    const url = new URL(req.url ?? "/", "http://x");
    req.query = url.searchParams;
    try {
      if (url.pathname === "/api/health") return res.end("ok");
      // The files address serves workspace pages and nothing else: no app, no API, no login. It's either a second
      // port (FILES_PORT, for setups without subdomains: localhost:8081 is its own origin) or web.files_url's host.
      const onFilesAddress = req.socket.localPort === filesPort || (!!filesHost() && req.headers.host === filesHost());
      // Share links (/s/<id>/…): what you shared, for anyone, no login. On the files address with an origin of its
      // own; on los's address sandboxed like any workspace page.
      const pub = url.pathname.match(/^\/s\/([\w-]+)(\/.*)?$/);
      if (pub) {
        if (!pub[2]) { res.writeHead(301, { location: `${url.pathname}/` }); return res.end(); }
        const rel = resolveShared(app, pub[1], decodeURIComponent(pub[2].slice(1)));
        if (!rel) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found (or no longer shared)."); }
        if (!url.pathname.endsWith("/") && statSync(wsPath(app, rel).full).isDirectory()) { res.writeHead(301, { location: `${url.pathname}/` }); return res.end(); }
        return serveWorkspaceFile(rel, url.searchParams.has("download"), res, onFilesAddress);
      }
      if (onFilesAddress) {
        const ff = url.pathname.match(/^\/f\/([\w.-]+)\/(.*)$/);
        if (ff && viewable(ff[1], decodeURIComponent(ff[2]))) return serveWorkspaceFile(decodeURIComponent(ff[2]), url.searchParams.has("download"), res, true);
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("Open workspace files from los (they get a fresh link each day).");
      }
      // Form posts to /login and /logout only from los's own pages (another site, or a page on the files address,
      // can't log you in as someone else or log you out).
      if ((url.pathname === "/login" || url.pathname === "/logout") && req.method === "POST" && req.headers.origin) {
        let same = false;
        try { same = new URL(String(req.headers.origin)).host === req.headers.host; } catch { /* malformed */ }
        if (!same) { res.writeHead(403, { "content-type": "text/plain" }); return res.end("cross-site form post refused"); }
      }
      if (url.pathname === "/login") {
        if (req.method === "POST") {
          const form = new URLSearchParams((await rawBody(req, 16 * 1024)).toString("utf8"));
          const next = form.get("next") ?? "/", host = String(req.headers.host ?? "");
          if (form.get("pending")) { // step 2: the two-factor code
            const r = auth.secondFactor(req, res, form.get("pending")!, form.get("code") ?? "");
            if (r.error) return loginPage(res, 401, r.error.startsWith("That took") ? { next, error: r.error, host } : { next, pending: form.get("pending")!, error: r.error, host });
          } else {
            const r = auth.login(req, res, form.get("username") ?? "", form.get("password") ?? "", form.get("remember") === "1");
            if (r.error) return loginPage(res, 401, { next, user: form.get("username") ?? "", error: r.error, host });
            if (r.pending) return loginPage(res, 200, { next, pending: r.pending, host });
          }
          res.writeHead(303, { location: safeNext(next) });
          return res.end();
        }
        if (auth.check(req)) { res.writeHead(303, { location: safeNext(url.searchParams.get("next")) }); return res.end(); }
        return loginPage(res, 200, { next: url.searchParams.get("next") ?? "/", host: String(req.headers.host ?? "") });
      }
      if (url.pathname === "/logout" && req.method === "POST") {
        auth.logout(res);
        res.writeHead(303, { location: "/login" });
        return res.end();
      }
      // Workspace files. /f/<token>/<path> needs no cookie, so a page previewed from the workspace (sandboxed, so it
      // can't touch los) still loads its own images and styles. The token changes daily; /files/<path> redirects.
      const f = url.pathname.match(/^\/f\/([\w.-]+)\/(.*)$/);
      if (f && viewable(f[1], decodeURIComponent(f[2]))) return serveWorkspaceFile(decodeURIComponent(f[2]), url.searchParams.has("download"), res);
      if (!PUBLIC.has(url.pathname) && !auth.check(req)) {
        if (url.pathname.startsWith("/api/")) throw new HttpError(401, "not logged in");
        res.writeHead(303, { location: `/login${url.pathname === "/" ? "" : `?next=${encodeURIComponent(url.pathname + url.search)}`}` });
        return res.end();
      }
      if (url.pathname.startsWith("/files/")) {
        const base = app.settings.web?.files_url?.replace(/\/$/, "") ?? "";
        // A link scoped to this file's folder (its page's assets load too), or to the file itself at the top level.
        const rel = decodeURIComponent(url.pathname.slice(7)).replace(/\/+$/, "");
        const scope = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : rel;
        res.writeHead(302, { location: `${base}/f/${auth.viewToken(scope)}/${url.pathname.slice(7)}${url.search}`, "cache-control": "no-store" });
        return res.end();
      }
      if (url.pathname.startsWith("/api/")) {
        // Defence in depth on top of the SameSite cookie: a custom header forces a CORS preflight we never allow.
        if (req.method !== "GET" && req.headers["x-los"] !== "1") throw new HttpError(403, "missing X-Los header");
        for (const [method, re, keys, h] of routes) {
          const m = method === req.method && url.pathname.match(re);
          if (!m) continue;
          req.params = Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const out = await h(req, res);
          if (out === KEEP_OPEN) return;
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...HARDEN });
          return res.end(JSON.stringify(out ?? null));
        }
        throw notFound(`no route ${req.method} ${url.pathname}`);
      }
      return serveStatic(url.pathname, req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  server.listen(opts.port, () => console.log(`los web on :${opts.port}`));
  // Optional second port for workspace files only (same handler; it serves nothing else there).
  if (filesPort && filesPort !== opts.port)
    createServer((rq, res) => server.emit("request", rq, res)).listen(filesPort, () => console.log(`workspace files on :${filesPort}`));

  /** May this viewing link open `path`? Only inside the scope it was made for, and only until it expires. */
  function viewable(token: string, path: string) {
    const scope = auth.viewScope(token);
    if (scope === null) return false;
    let rel: string;
    try { rel = wsPath(app, path).rel; } catch { return false; } // normalised: "a/../b" can't sneak out of the scope
    return rel === scope || (scope !== "" && rel.startsWith(scope + "/"));
  }
  /** Host of web.files_url, if set: workspace pages are served there on their own origin. */
  function filesHost() {
    try { return app.settings.web?.files_url ? new URL(app.settings.web.files_url).host : ""; } catch { return ""; }
  }
  // ownOrigin: served from the files address. The page has an origin of its own (localStorage, IndexedDB work) and
  // still can't reach los: the login cookie is host-only for los's address, and los sends no CORS headers.
  function serveWorkspaceFile(rel: string, download: boolean, res: ServerResponse, ownOrigin = false) {
    let p: string;
    try { p = wsPath(app, rel).full; } catch { res.writeHead(404); return res.end(); }
    if (!existsSync(p)) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
    if (statSync(p).isDirectory()) {
      if (existsSync(join(p, "index.html"))) p = join(p, "index.html"); // a website folder
      else { res.writeHead(404, { "content-type": "text/plain" }); return res.end("that's a folder"); }
    }
    const type = MIME[extname(p).toLowerCase()] ?? (isText(p) ? "text/plain; charset=utf-8" : "application/octet-stream");
    res.writeHead(200, {
      "content-type": type, "cache-control": "no-cache", "x-content-type-options": "nosniff",
      // The link itself is a key (view token): a page that links elsewhere mustn't hand it over in the Referer.
      "referrer-policy": "no-referrer",
      "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(basename(p))}`,
      // From los's own address, pages and SVGs run in a sandbox with an opaque origin: scripts work, but nothing can
      // reach los or its cookies (and no localStorage). From the files address they get a real origin of their own.
      ...(ownOrigin ? {} : { "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals" }),
    });
    createReadStream(p).pipe(res);
  }

  // ── restarts: a run lives in memory, so a restart would end it without a trace. On shutdown each chat run is
  // stopped with a note (shown in the chat) and remembered; after the restart, recent ones start again. ──
  const interruptedFile = join(app.settings.root, "data/interrupted.json");
  try {
    const list = JSON.parse(readFileSync(interruptedFile, "utf8")) as { sessionId: string; agent: string; turn: number; at: number }[];
    rmSync(interruptedFile, { force: true });
    for (const r of list) {
      if (Date.now() - r.at > 15 * 60_000 || !getSession(db, r.sessionId) || !app.settings.agents[r.agent]) continue;
      console.log(`resuming ${r.agent} in ${r.sessionId} (turn ${r.turn}), interrupted by the restart`);
      try { startRun(r.sessionId, r.agent, r.turn); } catch (e) { console.warn(`couldn't resume: ${(e as Error).message}`); }
    }
  } catch { /* nothing was interrupted */ }

  /** Stop every chat run for a restart (they resume afterwards). Resolves once they've ended, or after `waitMs`. */
  async function interruptAll(waitMs = 4000) {
    const list = runs.list().filter((r) => r.kind === "chat" && r.sessionId && r.agent)
      .map((r) => ({ sessionId: r.sessionId!, agent: r.agent!, turn: turnOf.get(r.key)!, at: Date.now() })).filter((r) => r.turn);
    if (!list.length) return;
    writeFileSync(interruptedFile, JSON.stringify(list));
    for (const r of list) { inbox.delete(runKey(r.sessionId, r.agent)); runs.stop(runKey(r.sessionId, r.agent), "Interrupted: los was restarted. It picks up again right after."); }
    const until = Date.now() + waitMs;
    while (Date.now() < until && runs.list().some((r) => r.kind === "chat")) await new Promise((r) => setTimeout(r, 100));
  }
  return Object.assign(server, { interruptAll });
}

const KEEP_OPEN = Symbol("keep-open");
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const workspace = (app: App) => {
  const dir = resolve(app.settings.root, "data/workspace");
  mkdirSync(dir, { recursive: true });
  return dir;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
  ".woff2": "font/woff2", ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".eml": "text/plain; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm",
  ".csv": "text/csv; charset=utf-8", ".xml": "text/xml; charset=utf-8", ".zip": "application/zip", ".wasm": "application/wasm",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
/** No null bytes in the first 4 KB: show it as text instead of downloading it (code, logs, yaml, …). */
function isText(p: string) {
  try {
    const fd = openSync(p, "r"), buf = Buffer.alloc(4096), n = readSync(fd, buf, 0, 4096, 0);
    closeSync(fd);
    return !buf.subarray(0, n).includes(0);
  } catch { return false; }
}

// Browser builds of the client libraries, served straight from node_modules.
const VENDOR: Record<string, string> = {
  "/vendor/marked.js": "marked/lib/marked.umd.js",
  "/vendor/purify.js": "dompurify/dist/purify.min.js",
  "/vendor/hljs.js": "@highlightjs/cdn-assets/highlight.min.js",
  "/vendor/hljs-light.css": "@highlightjs/cdn-assets/styles/github.min.css",
  "/vendor/hljs-dark.css": "@highlightjs/cdn-assets/styles/github-dark.min.css",
};

// The app's own pages: only its own scripts (no inline ones), its API and stream, workspace previews from the files
// address, Google Fonts; never framed by another site. Images may come from https: because a user can click to load
// one (agent messages don't load outside images by themselves, see app.js).
let filesOrigin = "";
export const appCsp = () => [
  "default-src 'self'", "script-src 'self'", "connect-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", `img-src 'self' data: blob: https: ${filesOrigin}`.trim(), `frame-src 'self' ${filesOrigin}`.trim(),
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");
const HARDEN = { "x-content-type-options": "nosniff", "referrer-policy": "same-origin", "x-frame-options": "DENY" };

function serveStatic(pathname: string, req: IncomingMessage, res: ServerResponse) {
  let file: string;
  if (VENDOR[pathname]) file = join(nodeModules, VENDOR[pathname]);
  else {
    file = safeJoin(webRoot, pathname === "/" ? "index.html" : pathname.slice(1));
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(webRoot, "index.html"); // SPA fallback
  }
  // Always revalidate, so a rebuild reaches open browsers at once; the ETag keeps it a cheap 304.
  const st = statSync(file);
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  if (req.headers["if-none-match"] === etag) { res.writeHead(304, { etag }); return res.end(); }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-cache",
    etag,
    ...HARDEN,
    ...(extname(file) === ".html" ? { "content-security-policy": appCsp() } : {}),
  });
  createReadStream(file).pipe(res);
}

function safeJoin(root: string, rel: string) {
  const p = resolve(root, rel);
  if (p !== root && !p.startsWith(root.endsWith("/") ? root : root + "/")) throw bad("bad path");
  return p;
}

function rawBody(req: IncomingMessage, limit = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, "too large")); req.destroy(); }
      else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

async function body(req: IncomingMessage): Promise<Record<string, any>> {
  const buf = await rawBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString("utf8")); } catch { throw bad("invalid JSON body"); }
}

export type { LoggedEvent };
