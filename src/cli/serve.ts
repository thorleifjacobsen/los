// The web UI + the task workers in one process — what the Docker container runs.  npm start
// PORT (default 7001); LOS_WORKER=0 to run the UI without the workers.
import { createApp } from "../app.js";
import { startWebServer } from "../web/server.js";
import { startWorkers } from "../tasks/worker.js";

const app = await createApp();

// Tasks still "running" belong to a process that no longer exists.
const stale = app.db.prepare("UPDATE tasks SET status = 'failed', result = 'interrupted: los restarted while this was running', updated_at = datetime('now') WHERE status IN ('running', 'waiting')").run();
if (stale.changes) console.log(`marked ${stale.changes} interrupted task(s) as failed`);

const workerOn = process.env.LOS_WORKER !== "0";
const workers = workerOn ? startWorkers(app) : null;
if (workers) console.log(`workers started (${workers.state().concurrency} at once)`);

const web = startWebServer(app, {
  port: Number(process.env.PORT ?? 7001),
  worker: { current: () => ({ enabled: workerOn, ...(workers?.state() ?? {}) }) },
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  workers?.stop();
  await web.interruptAll(); // chat runs note the restart and resume after it
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
