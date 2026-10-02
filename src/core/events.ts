import { EventEmitter } from "node:events";
import type { DB } from "../db/index.js";
import type { AgentEvent } from "../types.js";

export type LoggedEvent = { id: number; sessionId: string | null; taskId: number | null; turn: number | null; agent: string | null; event: AgentEvent };

/** Every event in this process is also published here; the web UI streams it over SSE. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Append-only event log. The CLI prints these; the web UI streams them. */
export function makeEmitter(
  db: DB, ids: { sessionId?: string; taskId?: number; turn?: number; agent?: string }, listener?: (e: AgentEvent) => void,
) {
  const insert = db.prepare("INSERT INTO events (session_id, task_id, turn, agent, type, data) VALUES (?, ?, ?, ?, ?, ?)");
  return (e: AgentEvent) => {
    const id = Number(insert.run(ids.sessionId ?? null, ids.taskId ?? null, ids.turn ?? null, ids.agent ?? null, e.type, JSON.stringify(e)).lastInsertRowid);
    listener?.(e);
    bus.emit("event", { id, sessionId: ids.sessionId ?? null, taskId: ids.taskId ?? null, turn: ids.turn ?? null, agent: ids.agent ?? null, event: e } satisfies LoggedEvent);
  };
}
