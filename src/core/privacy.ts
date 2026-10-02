// Per-item privacy. Every memory and every document is public or private. A private one is never shown to a
// cloud brain: tools leave it out of their results. When a local brain reads one, the conversation is marked
// private, and from then on it's refused on cloud brains (see guard() in loop.ts).
// On top of that, `privacy.local_only` in settings.yaml can still hide whole tools from cloud brains.
import type { Settings } from "../config.js";
import type { ToolContext } from "../types.js";
import { markPrivate } from "./session.js";

/** SQL condition for rows this brain may see, e.g. `AND ${seen(ctx, "d")}`. */
export const seen = (ctx: ToolContext, alias = "") => (ctx.brainIsLocal ? "1" : `${alias ? alias + "." : ""}private = 0`);

/** Call with the rows a tool is about to return: private ones taint the conversation. */
export function touched<T extends { private?: number | boolean }>(ctx: ToolContext, rows: T[]): T[] {
  if (rows.some((r) => r.private)) markPrivate(ctx.db, ctx.sessionId);
  return rows;
}

/** A source's default for its documents: mail is private unless said otherwise, files are public. */
export const sourcePrivate = (settings: Settings, sourceId: string) => {
  const s = settings.sources.find((x) => x.id === sourceId);
  return s?.private ?? s?.type === "imap";
};

export const memoryDefaultPrivate = (settings: Settings) => settings.privacy.memory_default === "private";
