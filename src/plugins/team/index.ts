// The team directory: who's who, who fits a piece of work, and asking a colleague. Every agent has a name, a job
// title, a job description and skills (config/agents/*.md); this is how they find each other.
import type { App } from "../../app.js";
import type { AgentConfig } from "../../types.js";
import { definePlugin, defineTool, z } from "../../tools/define.js";
import { createTask, type TaskRow } from "../../tasks/queue.js";
import { bus } from "../../core/events.js";

const STOP = new Set("a an and the of to for in on at with by from or is are be it this that i me my you your we our can could should would please some any about into do does done make get find need want help job work task jeg du vi og i på til for med av en et ei det den som er å har kan vil skal meg min mitt deg din om".split(" "));
const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
// Crude stemming so "researching"/"research", "nettside"/"nettsider", "koden"/"kode" meet.
const stem = (w: string) => w.slice(0, Math.max(4, Math.min(w.length, 6)));

/** Rank agents for a piece of work: title and skills count most, then the job description, then instructions. */
export function rankAgents(agents: AgentConfig[], work: string) {
  const want = [...new Set(words(work).map(stem))];
  return agents.map((a) => {
    const fields: [string, number][] = [[`${a.title} ${a.skills.join(" ")}`, 3], [a.description, 2], [a.system, 1]];
    const hits: string[] = [];
    let score = 0;
    for (const w of want) {
      const best = Math.max(0, ...fields.map(([text, weight]) => (words(text).some((x) => stem(x) === w) ? weight : 0)));
      if (best) { score += best; hits.push(w); }
    }
    return { agent: a, score, hits };
  }).filter((r) => r.score > 0).sort((x, y) => y.score - x.score);
}

export default (app: App) => {
  const card = (a: AgentConfig) => ({
    handle: a.name, name: a.displayName, title: a.title, job: a.description, skills: a.skills,
    brain: a.brain, can_read_private: !!app.settings.brains[a.brain]?.local || a.privateAccess,
  });
  return definePlugin({
    name: "team",
    description: "The team of agents: who does what, finding the right one for a job, asking a colleague",
    tools: [
      defineTool({
        name: "team_list",
        description: "List everyone on the team: handle, name, job title, job description and skills",
        tags: ["agents", "who", "colleagues", "delegate"],
        schema: z.object({}),
        run: async (_, ctx) => Object.values(app.settings.agents).filter((a) => a.name !== ctx.agent.name).map(card),
      }),
      defineTool({
        name: "team_find",
        description: "Find the teammates best suited for a piece of work. Describe the work in plain words; returns the " +
          "best matches with why they fit. In a chat, bring them in by @mentioning them in your reply.",
        tags: ["agents", "who", "delegate", "best", "match", "expert"],
        schema: z.object({ work: z.string().describe("What needs doing, e.g. 'compare e-bikes and find the best price'") }),
        run: async ({ work }, ctx) => {
          const others = Object.values(app.settings.agents).filter((a) => a.name !== ctx.agent.name);
          const ranked = rankAgents(others, work).slice(0, 3);
          // Keywords are a hint, not the judge: the whole team comes along, so you can pick by job description.
          return {
            best_matches: ranked.map((r) => ({ handle: r.agent.name, name: r.agent.displayName, title: r.agent.title, fits_because: `matches: ${r.hits.join(", ")}`, score: r.score })),
            ...(ranked.length ? {} : { note: "No keyword match. Pick from the team by their job descriptions, or do it yourself." }),
            team: others.map(card),
          };
        },
      }),
      defineTool({
        name: "team_ask",
        description: "Background tasks only: ask a teammate and wait for their answer (up to timeout_s). In a chat, " +
          "@mention them in your reply instead (they answer in the chat, where the user can follow it). The teammate " +
          "only sees what you write, so make the request complete.",
        tags: ["agents", "delegate", "ask", "colleague", "consult"],
        schema: z.object({
          agent: z.string().describe("Their handle (see team_find / team_list)"),
          request: z.string().describe("Complete, standalone request"),
          timeout_s: z.number().int().min(10).max(1800).optional().describe("Default 600"),
        }),
        run: async ({ agent, request, timeout_s = 600 }, ctx) => {
          const them = app.settings.agents[agent];
          if (!them) throw new Error(`no teammate "@${agent}" (see team_list)`);
          if (agent === ctx.agent.name) throw new Error("that's you");
          if (!ctx.taskId) throw new Error(`in a chat, @mention them in your reply instead ("@${agent}, …"): they answer in the chat after you`);
          const id = createTask(ctx.db, {
            title: `${ctx.agent.displayName} asks ${them.displayName}: ${request.replace(/\s+/g, " ").slice(0, 60)}`,
            prompt: `${ctx.agent.displayName} (@${ctx.agent.name}), your teammate, asks:\n\n${request}\n\nAnswer them directly; your final answer goes straight back to them.`,
            agent, parentId: ctx.taskId,
          });
          bus.emit("ui", { kind: "tasks" });
          const until = Date.now() + timeout_s * 1000;
          for (;;) {
            const t = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
            if (!["queued", "running", "waiting"].includes(t.status)) {
              if (t.private && !ctx.brainIsLocal) return { from: them.displayName, status: t.status, answer: "[their answer contains private data you may not read]" };
              return { from: them.displayName, status: t.status, answer: t.result };
            }
            if (Date.now() > until) return { from: them.displayName, status: "still working", task_id: id, note: "Check later with tasks_get." };
            await new Promise((r) => setTimeout(r, 2000));
          }
        },
      }),
    ],
  });
};
