// Jobs: recurring work ("every weekday at 07:30, summarise my mail"). The worker queues a task each time a job is
// due (src/tasks/worker.ts scheduleDue) and the result is posted into the chat that created the job.
import type { App } from "../../app.js";
import { definePlugin, defineTool, z } from "../../tools/define.js";
import { checkSchedule, fmtLocal, nextRun, sqlUtc, tzOf } from "../../core/time.js";
import { bus } from "../../core/events.js";

type Job = { id: number; title: string; prompt: string; schedule: string; agent: string | null; brain: string | null;
  report_to: string | null; enabled: number; next_run: string | null; last_run: string | null; last_task: number | null };

export default (app: App) => {
  const show = (j: Job) => ({
    id: j.id, title: j.title, schedule: j.schedule, agent: j.agent ?? "routed", enabled: !!j.enabled,
    next_run: fmtLocal(app.settings, j.next_run), last_run: fmtLocal(app.settings, j.last_run), prompt: j.prompt,
  });
  const changed = () => bus.emit("ui", { kind: "tasks" });
  const SCHEDULE = `When it runs, in the user's time zone (${tzOf(app.settings)}): 5-field cron ("0 10 * * *" = 10:00 daily, ` +
    `"30 7 * * 1-5" = 07:30 on weekdays, "0 9 1 * *" = 09:00 on the 1st) or an interval ("every 30m", "every 2h", "every 1d")`;
  return definePlugin({
    name: "jobs",
    description: "Recurring scheduled jobs: things that should run again and again on a schedule",
    context: ({ db, sessionId }) => {
      const jobs = db.prepare("SELECT * FROM jobs WHERE report_to = ? ORDER BY id").all(sessionId) as Job[];
      if (!jobs.length) return undefined;
      return "Scheduled jobs that report to this chat:\n" + jobs.map((j) =>
        `- job #${j.id} "${j.title}": ${j.schedule}${j.enabled ? `, next ${fmtLocal(app.settings, j.next_run)}` : " (paused)"}`).join("\n");
    },
    tools: [
      defineTool({
        name: "jobs_create",
        description: "Create a recurring job. Each time it's due, an agent runs the prompt in the background and its answer " +
          "is posted into this chat as a report. Good for daily briefings, checking a page for changes, weekly reviews. " +
          "Write the prompt as complete standalone instructions. For a one-off thing later, use tasks_create with run_at.",
        tags: ["schedule", "cron", "recurring", "every", "daily", "weekly", "remind", "routine"],
        schema: z.object({
          title: z.string(),
          prompt: z.string().describe("Complete standalone instructions for each run"),
          schedule: z.string().describe(SCHEDULE),
          agent: z.string().optional().describe("Who does it (see team_find / team_list). Default: routed"),
          brain: z.string().optional(),
        }),
        run: async (a, ctx) => {
          checkSchedule(a.schedule);
          if (a.agent && !app.settings.agents[a.agent]) throw new Error(`unknown agent "${a.agent}" (see team_find / team_list)`);
          const next = sqlUtc(nextRun(app.settings, a.schedule));
          const reportTo = ctx.taskId ? (ctx.db.prepare("SELECT report_to FROM tasks WHERE id = ?").get(ctx.taskId) as any)?.report_to : ctx.sessionId;
          const id = Number(ctx.db.prepare("INSERT INTO jobs (title, prompt, schedule, agent, brain, report_to, next_run) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(a.title, a.prompt, a.schedule.trim(), a.agent ?? null, a.brain ?? null, reportTo ?? null, next).lastInsertRowid);
          changed();
          return { job_id: id, first_run: fmtLocal(app.settings, next) };
        },
      }),
      defineTool({
        name: "jobs_list",
        description: "List scheduled jobs with their schedule and next run",
        tags: ["schedule", "cron", "recurring"],
        schema: z.object({}),
        run: async (_, { db }) => (db.prepare("SELECT * FROM jobs ORDER BY id").all() as Job[]).map(show),
      }),
      defineTool({
        name: "jobs_update",
        description: "Change a job: its schedule, prompt, title, agent, or pause/resume it (enabled)",
        tags: ["schedule", "pause", "resume"],
        schema: z.object({
          id: z.number().int(),
          title: z.string().optional(), prompt: z.string().optional(), schedule: z.string().optional().describe(SCHEDULE),
          agent: z.string().optional(), enabled: z.boolean().optional(),
        }),
        run: async ({ id, ...u }, { db }) => {
          const j = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined;
          if (!j) return "no such job";
          if (u.schedule) checkSchedule(u.schedule);
          const schedule = u.schedule?.trim() ?? j.schedule, enabled = u.enabled ?? !!j.enabled;
          const next = enabled ? sqlUtc(nextRun(app.settings, schedule)) : null;
          // Bypass was granted by the user for *that* job: an agent changing what it does or who runs it turns it off.
          const same = (u.prompt ?? j.prompt) === j.prompt && (u.agent ?? j.agent) === j.agent;
          db.prepare("UPDATE jobs SET title = ?, prompt = ?, schedule = ?, agent = ?, enabled = ?, next_run = ?, bypass = bypass * ? WHERE id = ?")
            .run(u.title ?? j.title, u.prompt ?? j.prompt, schedule, u.agent ?? j.agent, enabled ? 1 : 0, next, same ? 1 : 0, id);
          changed();
          return show(db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job);
        },
      }),
      defineTool({
        name: "jobs_run_now",
        description: "Run a job right away (once), without changing its schedule",
        schema: z.object({ id: z.number().int() }),
        run: async ({ id }, { db }) => {
          const r = db.prepare("UPDATE jobs SET next_run = datetime('now'), enabled = 1 WHERE id = ?").run(id);
          changed();
          return r.changes ? "it starts within half a minute" : "no such job";
        },
      }),
      defineTool({
        name: "jobs_delete",
        description: "Delete a scheduled job",
        schema: z.object({ id: z.number().int() }),
        run: async ({ id }, { db }) => {
          const r = db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
          changed();
          return r.changes ? "deleted" : "no such job";
        },
      }),
    ],
  });
};
