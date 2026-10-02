// The autonomous side: a pool of workers that claim queued tasks and run them, a scheduler that turns due jobs into
// tasks, and reports: a finished task's result is posted into the chat that asked for it (usually Home).
import type { App } from "../app.js";
import type { AgentEvent } from "../types.js";
import { runAgent } from "../core/loop.js";
import { createSession, getSession } from "../core/session.js";
import { approvals, runs } from "../core/control.js";
import { bus } from "../core/events.js";
import { nextRun, sqlUtc } from "../core/time.js";
import { claimNext, createTask, finishTask, route, setStatus, type TaskRow } from "./queue.js";
import { afterCardTask, queueCards } from "../core/boards.js";

const APPROVAL_WAIT = 24 * 3600_000; // a background task waits up to a day for your OK
const ui = (kind: string, data: Record<string, unknown> = {}) => bus.emit("ui", { kind, ...data });

export async function runTask(app: App, task: TaskRow, onEvent?: (e: AgentEvent) => void) {
  const { db } = app;
  const agentName = route(app.settings, task);
  const agent = app.settings.agents[agentName];
  if (!agent) {
    finishTask(db, task.id, "failed", `unknown agent "${agentName}"`, false);
    return report(app, task.id);
  }
  const sessionId = createSession(db, agent.name, task.title, "task");
  db.prepare("UPDATE tasks SET agent = ?, session_id = ? WHERE id = ?").run(agent.name, sessionId, task.id);
  if (task.bypass) db.prepare("UPDATE sessions SET bypass = 1 WHERE id = ?").run(sessionId);
  const key = `task:${task.id}`;
  const signal = runs.start({ key, kind: "task", taskId: task.id, sessionId, agent: agent.name, title: task.title });
  ui("tasks");
  const started = Date.now();
  try {
    const result = await runAgent(app, {
      sessionId, agent, brain: task.brain ?? undefined, taskId: task.id, input: task.prompt, onEvent, signal,
      // Nobody is watching: the task pauses ("waiting") until you approve or deny it from the UI.
      approve: async (call) => {
        setStatus(db, task.id, "waiting");
        ui("tasks");
        try { return await approvals.request({ sessionId, taskId: task.id, call, timeoutMs: APPROVAL_WAIT, signal }); }
        finally { if (!signal.aborted) { setStatus(db, task.id, "running"); ui("tasks"); } }
      },
    });
    finishTask(db, task.id, signal.aborted ? "cancelled" : "done", result, !!getSession(db, sessionId)!.private);
  } catch (e) {
    finishTask(db, task.id, signal.aborted ? "cancelled" : "failed", (e as Error).message, !!getSession(db, sessionId)!.private);
  } finally {
    runs.end(key);
    db.prepare("UPDATE tasks SET updated_at = datetime('now') WHERE id = ?").run(task.id);
    report(app, task.id, Date.now() - started);
    try { afterCardTask(app, db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as TaskRow); }
    catch (e) { console.warn(`card follow-up for task #${task.id} failed: ${(e as Error).message}`); }
    ui("tasks");
  }
}

/** Post a finished task's result into the chat that asked for it, as a message the assistant sees next turn. */
export function report(app: App, taskId: number, ms?: number) {
  const { db } = app;
  const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
  if (!t?.report_to || !getSession(db, t.report_to)) return;
  const job = t.job_id ? db.prepare("SELECT title FROM jobs WHERE id = ?").get(t.job_id) as { title: string } | undefined : undefined;
  const who = t.agent ? app.settings.agents[t.agent]?.displayName ?? t.agent : "an agent";
  const head = `${job ? `Scheduled job "${job.title}"` : `Background task #${t.id} "${t.title}"`}` +
    ` ${t.status === "done" ? "finished" : t.status === "cancelled" ? "was cancelled" : "failed"}` +
    ` (${who}${ms ? `, ${Math.round(ms / 1000)}s` : ""}${t.bypass ? ", ⚠ bypass on: ran tools without asking" : ""}).`;
  // A private result would make the whole chat private (and lock it to local brains), so only say where it is.
  const target = getSession(db, t.report_to)!;
  // A cancelled run's "result" is whatever it was saying when it was stopped: not worth posting as if it were one.
  const body = t.status === "cancelled" ? "It was stopped before it finished, so there's no result."
    : t.private && !target.private
    ? "The result contains private data, so it isn't shown here. Open it under Tasks (only local brains can read it)."
    : (t.result ?? "").trim() || "(no result)";
  db.prepare("INSERT INTO messages (session_id, role, content, name, brain, agent) VALUES (?, 'assistant', ?, 'report', ?, ?)")
    .run(t.report_to, `${head}\n\n${body}`, `task:${t.id}`, t.agent);
  ui("report", { sessionId: t.report_to, taskId: t.id });
  ui("run", { sessionId: t.report_to, running: false });
}

/** Queue a task for each due job and move its next_run on. Skips a job whose last run hasn't finished yet. */
export function scheduleDue(app: App, now = new Date()) {
  const { db } = app;
  const due = db.prepare("SELECT * FROM jobs WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?").all(sqlUtc(now)) as any[];
  for (const j of due) {
    let next: string | null = null;
    try { next = sqlUtc(nextRun(app.settings, j.schedule, now)); } catch { /* bad schedule: disable below */ }
    const busy = j.last_task && db.prepare("SELECT 1 FROM tasks WHERE id = ? AND status IN ('queued', 'running', 'waiting')").get(j.last_task);
    let taskId = j.last_task;
    if (!busy) taskId = createTask(db, {
      title: j.title, agent: j.agent ?? undefined, brain: j.brain ?? undefined, reportTo: j.report_to ?? undefined, jobId: j.id, bypass: !!j.bypass,
      prompt: `${j.prompt}\n\n(This is the scheduled job "${j.title}", schedule ${j.schedule}. Your final answer is posted to the user's chat as a report, so write it as a short message to them. If there's nothing worth reporting, say so in one line.)`,
    });
    db.prepare("UPDATE jobs SET last_run = ?, last_task = ?, next_run = ?, enabled = ? WHERE id = ?")
      .run(sqlUtc(now), taskId, next, next ? 1 : 0, j.id);
  }
  if (due.length) ui("tasks");
  queueCards(app); // cards assigned to agents: one task per agent at a time
}

/** Run up to `concurrency` tasks at once, and check the job schedule every 20s. Returns a stop function. */
export function startWorkers(app: App, opts: { concurrency?: number; log?: (s: string) => void } = {}) {
  const log = opts.log ?? console.log;
  const max = Math.max(1, opts.concurrency ?? app.settings.worker?.concurrency ?? 3);
  let active = 0, stopped = false;
  const pump = () => {
    while (!stopped && active < max) {
      const task = claimNext(app.db);
      if (!task) return;
      active++;
      log(`▶ task #${task.id} "${task.title}"`);
      runTask(app, task).catch((e) => log(`task #${task.id} crashed: ${(e as Error).message}`)).finally(() => {
        active--;
        log(`■ task #${task.id} ${(app.db.prepare("SELECT status FROM tasks WHERE id = ?").get(task.id) as any)?.status}`);
        pump();
      });
    }
  };
  const tick = setInterval(pump, 2000);
  const sched = setInterval(() => { try { scheduleDue(app); pump(); } catch (e) { log(`scheduler: ${(e as Error).message}`); } }, 20_000);
  scheduleDue(app);
  pump();
  return {
    stop: () => { stopped = true; clearInterval(tick); clearInterval(sched); },
    state: () => ({ concurrency: max, active }),
  };
}

/** For `npm run worker` and tests: one loop, optionally until the queue is empty. */
export async function workLoop(app: App, opts: { once?: boolean; pollMs?: number; log?: (s: string) => void } = {}) {
  const log = opts.log ?? console.log;
  for (;;) {
    scheduleDue(app);
    const task = claimNext(app.db);
    if (task) {
      log(`▶ task #${task.id} "${task.title}"`);
      await runTask(app, task, (e) => e.type === "tool_call" && log(`  #${task.id} → ${e.call.name}`));
      log(`■ task #${task.id} ${(app.db.prepare("SELECT status FROM tasks WHERE id = ?").get(task.id) as { status: string }).status}`);
    } else if (opts.once) return;
    else await new Promise((r) => setTimeout(r, opts.pollMs ?? 2000));
  }
}
