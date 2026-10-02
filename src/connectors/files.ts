// Connectors pull raw items from a source. Add a source type = add a file + a line in index.ts.
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import type { App } from "../app.js";
import type { SourceConfig } from "../config.js";
import { extractFile, SUPPORTED, type RawItem } from "../knowledge/extract.js";

export async function* filesConnector(app: App, src: SourceConfig): AsyncGenerator<RawItem> {
  const root = resolve(app.settings.root, src.path);
  if (!existsSync(root)) return;
  for (const path of walk(root)) {
    if (!SUPPORTED.has(extname(path).toLowerCase())) continue;
    try {
      const item = await extractFile(path, path.slice(root.length + 1));
      if (item) yield item;
    } catch (e) {
      console.warn(`skip ${path}: ${(e as Error).message}`);
    }
  }
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}
