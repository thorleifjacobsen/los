// Autonomous worker: runs queued tasks forever.  npm run worker  (or -- --once to drain the queue and exit)
import { parseArgs } from "node:util";
import { createApp } from "../app.js";
import { workLoop } from "../tasks/worker.js";

const { values } = parseArgs({ options: { once: { type: "boolean" } } });
const app = await createApp();
console.log("worker started");
await workLoop(app, { once: values.once });
await app.close();
