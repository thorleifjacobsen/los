// Delegation: hand work to other agents as background tasks. A task started from a chat reports back into that chat
// when it finishes; an agent can also wait for its subtasks (a manager splitting up a job and collecting results).
import type { App } from "../../app.js";
import { definePlugin, defineTool, z } from "../../tools/define.js";
import { createTask, type TaskRow } from "../../tasks/queue.js";
import { runs } from "../../core/control.js";
import { bus } from "../../core/events.js";
import { fmtLocal, parseWhen, tzOf } from "../../core/time.js";

const OPEN = "('queued', 'running', 'waiting')";

export default (app: App) => {
  const view = (t: TaskRow, brainIsLocal: boolean) => ({
    id: t.id, title: t.title, status: t.status, agent: t.agent,
    // A private task's result may contain mail/document content.
    result: t.private && !brainIsLocal ? "[hidden: private result, only local agents can read it]" : t.result,
  });
  return definePlugin({
    name: "tasks",
    description: "Delegate work to other agents as background tasks, wait for them, and check their results",
    context: ({ db, sessionId }) => {
      const open = db.prepare(`SELECT id, title, status, agent, run_at FROM tasks WHERE report_to = ? AND status IN ${OPEN} ORDER BY id`).all(sessionId) as any[];
      if (!open.length) return undefined;
      return "Background tasks you started from this chat that are still open (each posts a report here when done):\n" +
        open.map((t) => `- #${t.id} "${t.title}" (${t.agent ?? "routed"}, ${t.status}${t.status === "queued" ? `, starts ${fmtLocal(app.settings, t.run_at)}` : ""})`).join("\n");
    },
    tools: [
      defineTool({
        name: "tasks_create",
        description: "Start a background task for an agent: something to do LATER (run_at, e.g. a reminder), or long work " +
          "nobody needs to watch. Its result is posted into this chat as a report when done (unless report is false). " +
          "For work now, @mention the teammate in your reply instead: they answer right here in the chat. For " +
          "something that repeats, use jobs_create.",
        tags: ["delegate", "background", "schedule", "later", "remind"],
        schema: z.object({
          title: z.string(),
          prompt: z.string().describe("Complete standalone instructions: the agent sees nothing else"),
          agent: z.string().optional().describe("Teammate's handle (team_find picks the right one). Default: routed"),
          brain: z.string().optional().describe("Override the agent's LLM for this task"),
          run_at: z.string().optional().describe(`When to start, "YYYY-MM-DD HH:MM" in the user's time zone (${tzOf(app.settings)}). Default: now`),
          report: z.boolean().optional().describe("Post the result into this chat when done (default true; tasks you start from a task report to you via tasks_wait/tasks_get instead)"),
        }),
        run: async (a, ctx) => {
          if (a.agent && !app.settings.agents[a.agent]) throw new Error(`unknown agent "${a.agent}" (see team_list)`);
          if (a.brain && !app.settings.brains[a.brain]) throw new Error(`unknown brain "${a.brain}"`);
          const runAt = a.run_at ? parseWhen(app.settings, a.run_at) : undefined;
          const id = createTask(ctx.db, {
            title: a.title, prompt: a.prompt, agent: a.agent, brain: a.brain, runAt, parentId: ctx.taskId,
            reportTo: a.report === false || ctx.taskId ? undefined : ctx.sessionId,
          });
          bus.emit("ui", { kind: "tasks" });
          return { task_id: id, status: "queued", starts: runAt ? fmtLocal(app.settings, runAt) : "now" };
        },
      }),
      defineTool({
        name: "tasks_wait",
        description: "Wait until background tasks finish (up to timeout_s) and return their results. For splitting work " +
          "into subtasks and collecting the answers. In a chat, prefer letting tasks report back instead of waiting.",
        tags: ["delegate", "await", "join", "collect"],
        schema: z.object({
          ids: z.array(z.number().int()).min(1),
          timeout_s: z.number().int().min(5).max(3600).optional().describe("Default 600"),
        }),
        run: async ({ ids, timeout_s = 600 }, ctx) => {
          const until = Date.now() + timeout_s * 1000;
          const get = () => ids.map((id) => ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined);
          for (;;) {
            const rows = get();
            const open = rows.filter((t) => t && ["queued", "running", "waiting"].includes(t.status));
            if (!open.length || Date.now() > until)
              return { finished: !open.length, tasks: rows.map((t, i) => t ? view(t, ctx.brainIsLocal) : { id: ids[i], status: "no such task" }) };
            await new Promise((r) => setTimeout(r, 2000));
          }
        },
      }),
      defineTool({
        name: "tasks_get",
        description: "Get a task's status and result",
        schema: z.object({ id: z.number().int() }),
        run: async ({ id }, ctx) => {
          const t = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
          return t ? view(t, ctx.brainIsLocal) : "no such task";
        },
      }),
      defineTool({
        name: "tasks_list",
        description: "List recent tasks, optionally by status (queued, running, waiting, done, failed, cancelled)",
        schema: z.object({ status: z.string().optional() }),
        run: async ({ status }, { db }) =>
          db.prepare(`SELECT id, title, status, agent, brain, run_at, updated_at FROM tasks ${status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT 30`)
            .all(...(status ? [status] : [])),
      }),
      defineTool({
        name: "tasks_cancel",
        description: "Cancel a queued task, or stop a running one. It won't report back: you already know it's stopped.",
        schema: z.object({ id: z.number().int() }),
        run: async ({ id }, { db }) => {
          // The agent cancelling it knows; a "was cancelled" report would only cost it another turn.
          db.prepare("UPDATE tasks SET report_to = NULL WHERE id = ?").run(id);
          if (runs.stop(`task:${id}`)) return "stopping";
          const r = db.prepare("UPDATE tasks SET status = 'cancelled', result = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'queued'").run(id);
          bus.emit("ui", { kind: "tasks" });
          return r.changes ? "cancelled" : "not queued or running";
        },
      }),
    ],
  });
};
