import type { App } from "../app.js";
import type { SourceConfig } from "../config.js";
import type { RawItem } from "../knowledge/extract.js";
import { ingestItem, type IngestStats } from "../knowledge/ingest.js";
import { filesConnector } from "./files.js";
import { imapConnector } from "./imap.js";

type Connector = (app: App, src: SourceConfig) => AsyncGenerator<RawItem>;

// New source type? Write a connector that yields RawItems and register it here.
const connectors: Record<string, Connector> = {
  files: filesConnector,
  imap: imapConnector,
};

export async function syncSource(app: App, src: SourceConfig, log = console.log): Promise<IngestStats> {
  const connector = connectors[src.type];
  if (!connector) throw new Error(`${src.id}: unknown source type "${src.type}"`);
  const stats: IngestStats = { added: 0, updated: 0, skipped: 0 };
  for await (const item of connector(app, src)) {
    await ingestItem(app, src.id, item, stats);
    if ((stats.added + stats.updated) % 25 === 0 && stats.added + stats.updated) log(`  ${src.id}: ${stats.added + stats.updated} indexed…`);
  }
  return stats;
}
