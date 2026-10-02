// A conversation as one standard JSON document, in OpenAI's Responses "items" shape:
//   message (system / user / assistant), function_call, function_call_output, reasoning.
// The messages table is the same history in Chat Completions shape; this is the portable view of it. The system
// item is the agent's own prompt: los adds the live parts (time, memories, plan, summary) when it sends a turn.
import type { App } from "../app.js";
import { getSession } from "./session.js";

type Item =
  | { type: "message"; role: "system" | "user" | "assistant"; content: { type: "input_text" | "output_text"; text: string }[]; brain?: string; report?: boolean; created_at?: number }
  | { type: "function_call"; id: string; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; summary: { type: "summary_text"; text: string }[]; brain?: string };

const unix = (ts: string) => Math.floor(new Date(ts.replace(" ", "T") + "Z").getTime() / 1000);

export function exportConversation(app: App, sessionId: string) {
  const { db } = app;
  const s = getSession(db, sessionId)!;
  const agent = app.settings.agents[s.agent];
  const msgs = db.prepare("SELECT * FROM messages WHERE session_id = ? AND archived IS NULL ORDER BY id").all(sessionId) as any[];
  // Visible thinking is stored as events per turn; it goes right after that turn's user message.
  const thinking = new Map<number, string[]>();
  for (const e of db.prepare("SELECT turn, data FROM events WHERE session_id = ? AND type = 'reasoning' ORDER BY id").all(sessionId) as any[])
    (thinking.get(e.turn) ?? thinking.set(e.turn, []).get(e.turn)!).push(JSON.parse(e.data).text);
  const compactions = (db.prepare("SELECT data, created_at FROM events WHERE session_id = ? AND type = 'compact' ORDER BY id").all(sessionId) as any[])
    .map((c) => ({ ...JSON.parse(c.data), created_at: c.created_at }));

  const items: Item[] = [{ type: "message", role: "system", content: [{ type: "input_text", text: agent?.system ?? "" }] }];
  for (const m of msgs) {
    if (m.role === "user") {
      items.push({ type: "message", role: "user", content: [{ type: "input_text", text: m.content }], created_at: unix(m.created_at) });
      for (const t of thinking.get(m.id) ?? []) items.push({ type: "reasoning", summary: [{ type: "summary_text", text: t }] });
    } else if (m.role === "tool") {
      items.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content });
    } else {
      if (m.content?.trim()) items.push({
        type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }],
        brain: m.brain ?? undefined, ...(m.name === "report" && { report: true }), created_at: unix(m.created_at),
      });
      for (const c of m.tool_calls ? JSON.parse(m.tool_calls) : [])
        items.push({ type: "function_call", id: `fc_${c.id}`, call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) });
    }
  }
  return {
    id: `conv_${s.id}`,
    object: "conversation",
    created_at: unix((db.prepare("SELECT created_at FROM sessions WHERE id = ?").get(sessionId) as any).created_at),
    metadata: { title: s.title, agent: s.agent, kind: s.kind, brain: s.brain, private: !!s.private, compactions },
    items,
  };
}
