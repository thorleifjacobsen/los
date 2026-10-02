// What a brain knows of the conversation. Model brains are sent the stored messages every step. Runtime brains
// (Claude Code, Codex, …) keep their own session per brain, so a brain that missed turns (the chat switched brains,
// or it never answered here before) is handed those turns as text. Compaction replaces everything up to a message
// with a summary written by a brain of the user's choice; after it, every brain starts from the summary.
import type { App } from "../app.js";
import type { DB } from "../db/index.js";
import { getBrain } from "../brains/index.js";
import { makeEmitter } from "./events.js";
import { getSession } from "./session.js";

export type Compaction = { id: number; brain: string; summary: string; upto: number };
type Row = { id: number; role: "user" | "assistant" | "tool"; content: string; brain: string | null; agent: string | null; tool_calls: string | null; tool_call_id: string | null; name: string | null };

const PER_MESSAGE = 6_000;      // chars of one message in a handed-over transcript
const TRANSCRIPT = 80_000;      // chars of the whole transcript (the oldest part goes first)

export function lastCompaction(db: DB, sessionId: string): Compaction | undefined {
  const r = db.prepare("SELECT id, data FROM events WHERE session_id = ? AND type = 'compact' ORDER BY id DESC LIMIT 1")
    .get(sessionId) as { id: number; data: string } | undefined;
  if (!r) return;
  const d = JSON.parse(r.data);
  return { id: r.id, brain: d.brain, summary: d.summary, upto: d.upto };
}

/** The stored messages with after < id < before: user, assistant (text and/or tool calls) and tool results. */
function textMessages(db: DB, sessionId: string, after: number, before = Number.MAX_SAFE_INTEGER): Row[] {
  return db.prepare(`SELECT id, role, content, brain, agent, tool_calls, tool_call_id, name FROM messages WHERE session_id = ? AND archived IS NULL AND id > ? AND id < ?
    AND (trim(content) != '' OR tool_calls IS NOT NULL) ORDER BY id`).all(sessionId, after, before) as Row[];
}

/** The same rule as chatView(): other agents' words, not their tool calls/results; no handoffs meant for others. */
function ownWorkOnly(rows: Row[], me: string, turn: number): Row[] {
  const mine = new Set<string>();
  const out: Row[] = [];
  for (const r of rows) {
    if (r.role === "assistant" && r.agent === me && r.tool_calls) for (const c of JSON.parse(r.tool_calls)) mine.add(c.id);
    if (r.role === "tool" && !mine.has(r.tool_call_id ?? "")) continue;
    if (r.role === "user" && r.name === "handoff" && r.agent !== me && r.id !== turn) continue;
    if (r.role === "assistant" && r.agent !== me) {
      if (r.content.trim()) out.push({ ...r, tool_calls: null });
      continue;
    }
    out.push(r);
  }
  return out;
}

function transcript(app: App, rows: Row[]) {
  const label = (r: Row) => (r.agent && app.settings.agents[r.agent]?.displayName) || (r.brain && app.settings.brains[r.brain]?.label) || "assistant";
  const cut = (s: string) => (s.length > PER_MESSAGE ? s.slice(0, PER_MESSAGE) + " …[cut]" : s);
  const short = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …" : s);
  let text = rows.map((r) => {
    if (r.role === "user" && r.name === "handoff") return `[${cut(r.content)}]`;
    if (r.role === "user") return `User: ${cut(r.content)}`;
    if (r.name === "report") return `[Report posted to this chat] ${cut(r.content)}`;
    if (r.role === "tool") return `  ↳ result of ${r.name}: ${short(r.content.replace(/\s+/g, " "), 400)}`;
    const calls = (JSON.parse(r.tool_calls ?? "[]") as { name: string; args: unknown }[])
      .map((c) => `  → called ${c.name}(${short(JSON.stringify(c.args), 300)})`);
    return [r.content.trim() && `${label(r)}: ${cut(r.content)}`, ...calls].filter(Boolean).join("\n");
  }).join("\n\n");
  if (text.length > TRANSCRIPT) text = "…[older messages left out]\n\n" + text.slice(-TRANSCRIPT);
  return text;
}

/**
 * For a runtime brain (Claude Code, Codex, opencode) about to answer `turn`. Every turn starts a fresh CLI session
 * with the conversation so far as words only: messages and answers, no tool calls or results from earlier turns
 * (they're in the log, not re-sent). Within a turn the CLI keeps its own work, as it must.
 */
export function runtimeHistory(app: App, sessionId: string, _brainId: string, turn: number, agent: string) {
  const c = lastCompaction(app.db, sessionId);
  const said = wordsOnly(ownWorkOnly(textMessages(app.db, sessionId, c?.upto ?? 0, turn), agent, turn));
  const preface = !said.length ? "" : [
    "<conversation_so_far>",
    "The conversation so far (what was said; earlier tool calls and their results aren't repeated: look things up again if you need them):",
    "",
    transcript(app, said),
    "</conversation_so_far>",
    "",
    "",
  ].join("\n");
  return { ref: undefined, preface };
}

/** The CLI session this agent started in this turn, to resume it once for a write-up after it was cut off. */
export function currentRef(app: App, sessionId: string, brainId: string, turn: number, agent: string) {
  const r = app.db.prepare(`SELECT json_extract(data, '$.ref') AS ref FROM events WHERE session_id = ? AND turn = ? AND type = 'runtime'
    AND json_extract(data, '$.brain') = ? AND json_extract(data, '$.agent') = ? AND json_extract(data, '$.ref') IS NOT NULL ORDER BY id DESC LIMIT 1`)
    .get(sessionId, turn, brainId, agent) as { ref: string } | undefined;
  return { ref: r?.ref, preface: "" };
}

/** Only what was said: no tool calls, no tool results, no "let me check…" narration between calls. */
function wordsOnly(rows: Row[]): Row[] {
  return rows.filter((r) => r.role !== "tool" && !(r.role === "assistant" && r.tool_calls));
}

const SUMMARIZER = "You compress conversations so they can be continued later without the original. You only write the summary.";
const COMPACT_PROMPT = `Summarise the conversation below so an assistant can carry it on without seeing the original.
Keep: what the user wants and why, decisions made, facts about the user and their situation, names, numbers,
links, files and commands that matter, what was done (and by which tools), open questions and the very next step.
Drop: small talk, repetition, and anything that no longer matters. Use short headed sections and bullets.
Write in the language the user writes in. Output only the summary.

`;

/** Summarise the conversation so far with `brainId` and record it as a compaction. Returns the summary. */
export async function compactSession(app: App, sessionId: string, brainId: string, cwd: string, auto = false) {
  const { db } = app;
  const session = getSession(db, sessionId);
  if (!session) throw new Error(`no session ${sessionId}`);
  const brain = getBrain(app.settings, brainId);
  if (session.private && !brain.local) throw new Error(`this chat contains local-only data; brain "${brainId}" is not local`);
  const c = lastCompaction(db, sessionId);
  const rows = textMessages(db, sessionId, c?.upto ?? 0);
  if (!rows.length) throw new Error("nothing new to compact since the last time");

  const input = COMPACT_PROMPT +
    (c ? `<earlier_summary>\n${c.summary}\n</earlier_summary>\n\n` : "") +
    `<conversation>\n${transcript(app, rows)}\n</conversation>`;
  const emit = makeEmitter(db, { sessionId });
  const before = db.prepare("SELECT json_extract(data, '$.used') AS used FROM events WHERE session_id = ? AND type = 'context' ORDER BY id DESC LIMIT 1")
    .get(sessionId) as { used: number } | undefined;
  // No tools: Claude Code runs with none at all. No resume ref: a fresh CLI session that's never resumed.
  const summary = await brain.complete({
    system: SUMMARIZER, messages: [{ role: "user", content: input }], tools: [], cwd, resume: { preface: "" },
  }).then((r) => {
    if (r.usage) emit({ type: "usage", brain: brainId, ...r.usage });
    return r.text;
  }).finally(() => brain.close?.());
  if (!summary.trim()) throw new Error(`brain "${brainId}" returned an empty summary`);
  emit({ type: "compact", brain: brainId, summary: summary.trim(), upto: rows.at(-1)!.id, before: before?.used, auto });
  return summary.trim();
}
