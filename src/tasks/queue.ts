// The task queue is just the `tasks` table. No Redis, no broker.
import type { DB } from "../db/index.js";
import type { Settings } from "../config.js";

export type TaskRow = {
  id: number; title: string; prompt: string; status: string; agent: string | null; brain: string | null;
  parent_id: number | null; session_id: string | null; result: string | null; private: number; run_at: string;
  report_to: string | null; job_id: number | null; requested_by: string | null; bypass: number; created_at: string; updated_at: string;
};

export function createTask(db: DB, t: {
  title: string; prompt: string; agent?: string; brain?: string; parentId?: number; runAt?: string; reportTo?: string; jobId?: number; requestedBy?: string;
  bypass?: boolean; // only from the user (UI/API) or a job they set it on, never from an agent's tool call
}) {
  return Number(db.prepare(`INSERT INTO tasks (title, prompt, agent, brain, parent_id, run_at, report_to, job_id, requested_by, bypass)
    VALUES (?, ?, ?, ?, ?, coalesce(?, datetime('now')), ?, ?, ?, ?)`)
    .run(t.title, t.prompt, t.agent ?? null, t.brain ?? null, t.parentId ?? null, t.runAt ?? null, t.reportTo ?? null, t.jobId ?? null, t.requestedBy ?? null, t.bypass ? 1 : 0).lastInsertRowid);
}

/** Atomically claim the next due task, so several workers can run side by side. */
export function claimNext(db: DB): TaskRow | undefined {
  return db.prepare(`UPDATE tasks SET status = 'running', updated_at = datetime('now')
    WHERE id = (SELECT id FROM tasks WHERE status = 'queued' AND run_at <= datetime('now') ORDER BY run_at, id LIMIT 1)
    RETURNING *`).get() as TaskRow | undefined;
}

export function setStatus(db: DB, id: number, status: string) {
  db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

export function finishTask(db: DB, id: number, status: "done" | "failed" | "cancelled", result: string, isPrivate: boolean) {
  db.prepare("UPDATE tasks SET status = ?, result = ?, private = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, result, isPrivate ? 1 : 0, id);
}

/** Which agent does a task? Explicit > first matching routing rule > default agent. */
export function route(settings: Settings, task: Pick<TaskRow, "agent" | "title" | "prompt">): string {
  if (task.agent) return task.agent;
  const text = `${task.title}\n${task.prompt}`;
  const rule = settings.routing.find((r) => new RegExp(r.match, "i").test(text));
  return rule?.agent ?? settings.default_agent;
}
