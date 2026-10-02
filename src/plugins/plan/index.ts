// Working memory: a plan an agent writes for the answer it's working on, shown back to it on every step of that
// answer. It keeps long work on track. A plan belongs to one agent's run (chat, agent, turn): teammates in the same
// chat each have their own, and an old plan doesn't follow the agent into later turns.
import { definePlugin, defineTool, z } from "../../tools/define.js";

const STATUS = z.enum(["pending", "in_progress", "done", "skipped"]);
const MARK = { pending: "[ ]", in_progress: "[~]", done: "[x]", skipped: "[-]" } as const;

export default definePlugin({
  name: "plan",
  description: "Make and track a step-by-step plan for the current task",
  schema: `CREATE TABLE IF NOT EXISTS plan_steps (
    session_id TEXT NOT NULL, agent TEXT NOT NULL DEFAULT '', turn INTEGER, idx INTEGER NOT NULL, text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY (session_id, agent, idx))`,
  tools: [
    defineTool({
      name: "plan_set",
      description: "Write (or rewrite) your plan for what you're working on now, as a list of steps. Use for anything with 3+ steps.",
      tags: ["steps", "checklist"],
      schema: z.object({ steps: z.array(z.string()).min(1) }),
      run: async ({ steps }, { db, sessionId, agent, turn }) => {
        db.transaction(() => {
          db.prepare("DELETE FROM plan_steps WHERE session_id = ? AND agent = ?").run(sessionId, agent.name);
          const ins = db.prepare("INSERT INTO plan_steps (session_id, agent, turn, idx, text) VALUES (?, ?, ?, ?, ?)");
          steps.forEach((s, i) => ins.run(sessionId, agent.name, turn ?? null, i + 1, s));
        })();
        return `Plan saved with ${steps.length} steps.`;
      },
    }),
    defineTool({
      name: "plan_update",
      description: "Update the status of one step of your plan (by its number)",
      schema: z.object({ step: z.number().int(), status: STATUS }),
      run: async ({ step, status }, { db, sessionId, agent }) =>
        db.prepare("UPDATE plan_steps SET status = ? WHERE session_id = ? AND agent = ? AND idx = ?").run(status, sessionId, agent.name, step).changes
          ? "ok" : "no such step",
    }),
  ],
  // Only the plan from this very run. (Tasks have no turn: their plan lasts as long as the task's own session.)
  context: ({ db, sessionId, agent, turn }) => {
    const steps = db.prepare(`SELECT idx, text, status FROM plan_steps WHERE session_id = ? AND agent = ? AND (turn IS ? OR ? IS NULL) ORDER BY idx`)
      .all(sessionId, agent ?? "", turn ?? null, turn ?? null) as any[];
    if (!steps.length) return undefined;
    return "## Your plan for this answer\n" + steps.map((s) => `${MARK[s.status as keyof typeof MARK]} ${s.idx}. ${s.text}`).join("\n");
  },
});
