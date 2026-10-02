// Interactive chat in the terminal:  npm run chat [-- --agent vera --brain claude --session <id>]
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createApp } from "../app.js";
import { runAgent } from "../core/loop.js";
import { createSession, getSession } from "../core/session.js";
import type { AgentEvent } from "../types.js";

const { values: args } = parseArgs({ options: { agent: { type: "string" }, brain: { type: "string" }, session: { type: "string" } } });
const app = await createApp();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

let agent = app.settings.agents[args.agent ?? app.settings.default_agent];
if (!agent) throw new Error(`unknown agent; have: ${Object.keys(app.settings.agents).join(", ")}`);
let brain = args.brain;
let sessionId = args.session && getSession(app.db, args.session) ? args.session : createSession(app.db, agent.name);

const show = (e: AgentEvent) => {
  if (e.type === "tool_call") console.log(dim(`  → ${e.call.name} ${JSON.stringify(e.call.args).slice(0, 120)}`));
  if (e.type === "tool_result" && !e.ok) console.log(dim(`  ✗ ${e.preview}`));
  if (e.type === "tools_loaded") console.log(dim(`  + loaded ${e.names.join(", ")}`));
  if (e.type === "runtime") process.stdout.write(dim("."));
};

console.log(dim(`agent: ${agent.name} · brain: ${brain ?? agent.brain} · session: ${sessionId}`));
console.log(dim("commands: /agent <name>  /brain <name>  /new  /tools  /exit"));

for (;;) {
  const input = (await rl.question("\n› ")).trim();
  if (!input) continue;
  if (input === "/exit") break;
  if (input === "/new") { sessionId = createSession(app.db, agent.name); console.log(dim(`new session ${sessionId}`)); continue; }
  if (input.startsWith("/agent ")) {
    const next = app.settings.agents[input.slice(7).trim()];
    if (!next) { console.log(`agents: ${Object.keys(app.settings.agents).join(", ")}`); continue; }
    agent = next; brain = undefined; sessionId = createSession(app.db, agent.name);
    console.log(dim(`agent: ${agent.name} · brain: ${agent.brain} · new session`)); continue;
  }
  if (input.startsWith("/brain ")) { brain = input.slice(7).trim(); console.log(dim(`brain: ${brain}`)); continue; }
  if (input === "/tools") {
    for (const [name, t] of app.registry.tools) console.log(`${name.padEnd(28)} ${app.registry.isLocalOnly(name) ? "🔒" : "  "} ${t.description}`);
    continue;
  }

  try {
    const answer = await runAgent(app, {
      sessionId, agent, brain, input, onEvent: show,
      approve: async (call) =>
        /^y/i.test(await rl.question(`  ⚠ allow ${call.name} ${JSON.stringify(call.args)}? [y/N] `)),
    });
    console.log(`\n${answer}`);
  } catch (e) {
    console.log(`\x1b[31m${(e as Error).message}\x1b[0m`);
  }
}
rl.close();
await app.close();
