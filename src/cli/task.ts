// Queue a task from the terminal:
//   npm run task -- "Summarise this week's mail and add action items as todos" [--agent vera] [--brain local-small]
//   npm run task -- --list
import { parseArgs } from "node:util";
import { createApp } from "../app.js";
import { createTask } from "../tasks/queue.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { agent: { type: "string" }, brain: { type: "string" }, title: { type: "string" }, list: { type: "boolean" } },
});
const app = await createApp({ mcp: false });
if (values.list) {
  console.table(app.db.prepare("SELECT id, title, status, agent, brain, substr(result, 1, 60) AS result FROM tasks ORDER BY id DESC LIMIT 20").all());
} else {
  const prompt = positionals.join(" ");
  if (!prompt) throw new Error("usage: npm run task -- \"what to do\" [--agent name] [--brain name]");
  const id = createTask(app.db, { title: values.title ?? prompt.slice(0, 60), prompt, agent: values.agent, brain: values.brain });
  console.log(`queued task #${id}`);
}
await app.close();
