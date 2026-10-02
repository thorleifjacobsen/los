// Sessions = persisted conversations:
//   chat  a conversation with the team. The lead (`sessions.agent`, Los by default) answers; anyone @mentioned —
//         by you or by another agent — answers too, in the same chat, where you can watch it.
//   task  a background task's own conversation (scheduled jobs, "later" work; listed under Tasks, not as a chat)
// Every message records its turn (`turn` = id of the user/handoff message that started that agent's run) and its
// agent (author, or who a user message was addressed to), because several agents can work in one chat at once.
import type { DB } from "../db/index.js";
import type { Message } from "../types.js";

export type SessionKind = "chat" | "task";
export type SessionRow = {
  id: string; agent: string; title: string | null; private: number; tools: string; brain: string | null;
  kind: SessionKind; members: string | null; allow: string; folder: string | null; archived: number; bypass: number;
};

export function createSession(db: DB, agent: string, title?: string, kind: SessionKind = "chat"): string {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO sessions (id, agent, title, kind, members) VALUES (?, ?, ?, ?, ?)")
    .run(id, agent, title ?? null, kind, kind === "chat" ? JSON.stringify([agent]) : null);
  return id;
}

/** Who has taken part in a chat (the lead first). Only for showing faces: anyone on the team can be @mentioned. */
export function membersOf(s: SessionRow, everyone: string[]): string[] {
  const m = (s.members ? JSON.parse(s.members) : [s.agent]) as string[];
  return [...new Set([s.agent, ...m])].filter((x) => everyone.includes(x));
}
export function join(db: DB, s: SessionRow, handle: string) {
  const m = s.members ? (JSON.parse(s.members) as string[]) : [s.agent];
  if (!m.includes(handle)) db.prepare("UPDATE sessions SET members = ? WHERE id = ?").run(JSON.stringify([...m, handle]), s.id);
}

type Who = { name: string; displayName: string };
/**
 * The teammates a message @mentions, in order: @handle or @Name. Mentions inside code, inline code or quotes don't
 * count (an agent quoting "@Finn said…" isn't asking Finn). `@team` → `team: true` (only honoured from the user).
 */
export function mentions(text: string, agents: Who[], self?: string): { handles: string[]; team: boolean } {
  let plain = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .split("\n").filter((l) => !/^\s*>/.test(l)).join("\n");
  // "Ollie (@ollie)" / "Ollie @ollie:" credits someone (it's how los labels other agents' messages, and models copy
  // it); it isn't asking them to do something. Only the closed forms: "for Finn (@finn can build…" is a real mention.
  for (const a of agents) {
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    plain = plain.replace(new RegExp(`${esc(a.displayName)}\\s*(?:\\(\\s*@${esc(a.name)}\\s*\\)|@${esc(a.name)}\\b(?=\\s*[:)\\]]))`, "giu"), a.displayName);
  }
  const handles: string[] = [];
  let team = false;
  for (const m of plain.matchAll(/(?:^|[\s(,;:])@([\p{L}\p{N}_-]+)/gu)) {
    const w = m[1].toLowerCase();
    if (w === "team" || w === "all" || w === "alle") { team = true; continue; }
    const a = agents.find((x) => x.name.toLowerCase() === w || x.displayName.toLowerCase() === w);
    if (a && a.name !== self && !handles.includes(a.name)) handles.push(a.name);
  }
  return { handles, team };
}
/** Who a user message goes to: everyone it @mentions (the whole team for @team), else the chat's lead. */
export function addressees(input: string, agents: Who[], lead: string): { handles: string[]; team: boolean } {
  const m = mentions(input, agents);
  if (m.team) return { handles: agents.map((a) => a.name), team: true };
  return { handles: m.handles.length ? m.handles : [lead], team: false };
}

export const getSession = (db: DB, id: string) =>
  db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;

type Row = { id: number; role: string; content: string; tool_calls: string | null; tool_call_id: string | null; name: string | null; agent: string | null; turn: number | null };
const toMessage = (r: Row): Message =>
  r.role === "tool"
    ? { role: "tool", toolCallId: r.tool_call_id!, name: r.name!, content: r.content }
    : r.role === "assistant"
      ? { role: "assistant", content: r.content, toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined, agent: r.agent ?? undefined }
      : { role: "user", content: r.content };

/** The conversation, optionally only after message id `after` (everything before it was compacted). */
export function loadMessages(db: DB, sessionId: string, after = 0): Message[] {
  return (db.prepare("SELECT * FROM messages WHERE session_id = ? AND id > ? AND archived IS NULL ORDER BY id").all(sessionId, after) as Row[]).map(toMessage);
}

/**
 * The conversation as one agent sees it in its run that started at message `turn`:
 * - its own work *in this turn* in full (tool calls and results); from earlier turns only what it said;
 * - everyone else's *words* only: other agents' tool calls and results are left out (they're stored, just not sent:
 *   most of a turn's tokens are tool output, and another agent's findings are in its answer);
 * - nothing that happened after its turn started except its own work (a chat can have several agents working at
 *   once; their messages reach it next turn), so tool calls and their results stay together.
 * Handoff notes addressed to someone else are left out too.
 */
export function chatView(db: DB, sessionId: string, me: string, turn: number, after = 0, until = Number.MAX_SAFE_INTEGER): Message[] {
  // Messages an edit archived are out, unless the edit came after `until` (a past request being rebuilt).
  const rows = db.prepare("SELECT * FROM messages WHERE session_id = ? AND id > ? AND id <= ? AND (archived IS NULL OR archived > ?) ORDER BY id")
    .all(sessionId, after, until, until) as Row[];
  const mine = new Set<string>();
  const out: Message[] = [];
  for (const r of rows) {
    if (r.role === "assistant" && r.agent === me && r.tool_calls) for (const c of JSON.parse(r.tool_calls)) mine.add(c.id);
    const own = (r.role === "assistant" && r.agent === me) || (r.role === "tool" && mine.has(r.tool_call_id!));
    if (r.id > turn && !own) continue;
    if (r.role === "tool" && !own) continue;
    // Earlier turns: words only. Tool calls and results stay in the log; this turn's work goes along in full.
    if (own && r.turn !== turn && (r.role === "tool" || r.tool_calls)) continue;
    if (r.role === "user" && r.name === "handoff" && r.agent !== me && r.id !== turn) continue;
    if (r.role === "assistant" && !own) {
      if (!r.content.trim()) continue;
      out.push({ role: "assistant", content: r.content, agent: r.agent ?? undefined });
      continue;
    }
    out.push(toMessage(r));
  }
  return out;
}

/** `by.agent`: who wrote an assistant message, or who a user message was addressed to. `by.turn`: the run it's part of. */
export function saveMessage(db: DB, sessionId: string, m: Message, by: { brain?: string; agent?: string; name?: string; turn?: number } = {}): number {
  return Number(db.prepare(
    "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, name, brain, agent, turn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    sessionId, m.role, m.content,
    m.role === "assistant" && m.toolCalls?.length ? JSON.stringify(m.toolCalls) : null,
    m.role === "tool" ? m.toolCallId : null,
    m.role === "tool" ? m.name : by.name ?? null,
    m.role === "assistant" ? by.brain ?? null : null,
    m.role === "tool" ? null : by.agent ?? null,
    m.role === "user" ? null : by.turn ?? null,
  ).lastInsertRowid);
}

export const markPrivate = (db: DB, id: string) => db.prepare("UPDATE sessions SET private = 1 WHERE id = ?").run(id);
export const saveTools = (db: DB, id: string, tools: string[]) =>
  db.prepare("UPDATE sessions SET tools = ? WHERE id = ?").run(JSON.stringify(tools), id);

/** Tools you allowed for the rest of a chat ("Allow for this chat"): they don't ask again there. */
export const allowedIn = (db: DB, id: string): string[] => JSON.parse(getSession(db, id)?.allow ?? "[]");
export function allowIn(db: DB, id: string, tool: string) {
  const a = allowedIn(db, id);
  if (!a.includes(tool)) db.prepare("UPDATE sessions SET allow = ? WHERE id = ?").run(JSON.stringify([...a, tool]), id);
}
