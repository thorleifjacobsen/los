// Wires everything together: settings → db → plugins → MCP servers → registry.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSettings, type Settings } from "./config.js";
import { openDb, migrate, type DB } from "./db/index.js";
import { Registry } from "./tools/registry.js";
import { connectMcpServers } from "./mcp/client.js";
import type { Plugin } from "./types.js";

export interface App {
  settings: Settings;
  db: DB;
  registry: Registry;
  close(): Promise<void>;
  /** Re-read config/ (settings, agents, mcp.json) and reconnect MCP servers. */
  reload(): Promise<void>;
}

/** A plugin module default-exports a Plugin, or a function (app) => Plugin when it needs settings/db. */
export type PluginModule = Plugin | ((app: App) => Plugin);

export async function createApp(opts: { settings?: Settings; mcp?: boolean } = {}): Promise<App> {
  const settings = opts.settings ?? loadSettings();
  const db = openDb(settings.db, { embedDim: settings.embeddings?.dim });
  const registry = new Registry(settings.privacy.local_only);
  let closers: (() => Promise<void>)[] = [];
  const connectMcp = async () => {
    for (const { plugin, close } of await connectMcpServers(settings.mcp)) {
      registry.add(plugin);
      closers.push(close);
    }
  };
  const app: App = {
    settings, db, registry,
    close: async () => { await Promise.all(closers.map((c) => c())); db.close(); },
    reload: async () => {
      const fresh = loadSettings(settings.root);
      Object.assign(settings, { ...fresh, db: settings.db }); // the db file can't change while running
      await Promise.all(closers.map((c) => c().catch(() => {})));
      closers = [];
      for (const name of [...registry.plugins.keys()]) if (name.startsWith("mcp_")) registry.remove(name);
      if (opts.mcp !== false) await connectMcp();
    },
  };

  // Auto-discover src/plugins/<name>/index.ts — adding a feature = adding a folder.
  const dir = new URL("./plugins/", import.meta.url);
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir.pathname, name, "index.ts");
    if (!existsSync(file)) continue;
    const mod: PluginModule = (await import(pathToFileURL(file).href)).default;
    const plugin = typeof mod === "function" ? mod(app) : mod;
    if (plugin.schema) db.exec(plugin.schema);
    registry.add(plugin);
  }
  migrate(db); // plugin tables that gained columns

  if (opts.mcp !== false) await connectMcp();
  return app;
}
