// Sync all sources in settings.yaml into the knowledge index.  npm run ingest [-- --source workspace]
import { parseArgs } from "node:util";
import { createApp } from "../app.js";
import { syncSource } from "../connectors/index.js";

const { values } = parseArgs({ options: { source: { type: "string" } } });
const app = await createApp({ mcp: false });
for (const src of app.settings.sources.filter((s) => !values.source || s.id === values.source)) {
  console.log(`syncing ${src.id}…`);
  try {
    const s = await syncSource(app, src);
    console.log(`  ${src.id}: ${s.added} added, ${s.updated} updated, ${s.skipped} unchanged`);
  } catch (e) {
    console.error(`  ${src.id} failed: ${(e as Error).message}`);
  }
}
await app.close();
