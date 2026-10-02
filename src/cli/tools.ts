// Print every registered tool, and what a given agent would start with.  npm run tools [-- --agent researcher]
import { parseArgs } from "node:util";
import { createApp } from "../app.js";

const { values } = parseArgs({ options: { agent: { type: "string" } } });
const app = await createApp();
const { registry, settings } = app;
for (const [name, t] of registry.tools)
  console.log(`${name.padEnd(28)} ${registry.isLocalOnly(name) ? "local-only" : "public    "} ${t.sideEffect ? "approval" : "        "}  ${t.description}`);
if (values.agent) {
  const agent = settings.agents[values.agent];
  const local = !!settings.brains[agent.brain]?.local;
  console.log(`\n${agent.name} (${agent.brain}, ${local ? "local" : "cloud"}) starts with: ${registry.initial(agent, local).join(", ")}`);
  console.log(`can load via tool_search: ${[...registry.tools.keys()].filter((n) => registry.permitted(agent, local, n)).join(", ")}`);
}
await app.close();
