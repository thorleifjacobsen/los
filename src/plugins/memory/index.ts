// Long-term memory: short facts an agent saves on purpose. Readable and editable by you (Notebook).
// Each memory is public or private (src/core/privacy.ts). Public ones are put in every system prompt, so the
// assistant knows you from the first message; private ones are only found by search, and only by local brains.
import type { App } from "../../app.js";
import { definePlugin, defineTool, z } from "../../tools/define.js";
import { seen, touched, memoryDefaultPrivate } from "../../core/privacy.js";

const IN_PROMPT = 60;          // newest public memories in the system prompt
const IN_PROMPT_CHARS = 3500; // ~900 tokens; older ones are a memory_search away

export default (app: App) => definePlugin({
  name: "memory",
  description: "Remember facts about the user and their world across conversations",
  schema: `
    CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, text TEXT NOT NULL, tags TEXT,
      private INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, tags, content='memories', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags); END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags); END;`,
  context: ({ db, brainIsLocal }) => {
    const rows = db.prepare("SELECT id, text FROM memories WHERE private = 0 ORDER BY id DESC LIMIT ?").all(IN_PROMPT) as { id: number; text: string }[];
    const hidden = (db.prepare("SELECT count(*) n FROM memories WHERE private = 1").get() as { n: number }).n;
    if (!rows.length && !hidden) return "You have no saved memories about the user yet. When you learn a lasting fact about them (preferences, people, places, routines), save it with memory_save.";
    let text = rows.map((r) => `- ${r.text} [#${r.id}]`).join("\n");
    if (text.length > IN_PROMPT_CHARS) text = text.slice(0, IN_PROMPT_CHARS) + "\n- …(older ones: memory_search)";
    return [
      "What you remember about the user (saved memories, newest first). Use them naturally; don't recite them.",
      "Save new lasting facts about the user with memory_save (not what a chat is working on), and correct outdated ones with memory_forget + memory_save.",
      text,
      hidden ? (brainIsLocal ? `There are also ${hidden} private memories: find them with memory_search.` : "") : "",
    ].filter(Boolean).join("\n");
  },
  tools: [
    defineTool({
      name: "memory_save",
      description: "Save lasting facts about the user worth knowing in future conversations: preferences, people, places, " +
        "routines, things they own or follow. NOT what a chat is working on (project status, plans in progress, files " +
        "made): that lives in the chat. One fact per item, each written to make sense on its own; save several in one " +
        "call. Set private for sensitive things (health, money, passwords, other people's secrets): private memories " +
        "are never shown to cloud models.",
      tags: ["remember", "note"],
      schema: z.object({
        facts: z.array(z.object({
          text: z.string(),
          tags: z.array(z.string()).optional(),
          private: z.boolean().optional().describe(`Never show to cloud models (default: ${memoryDefaultPrivate(app.settings) ? "true" : "false"})`),
        })).min(1),
      }),
      run: async ({ facts }, { db }) => {
        const ins = db.prepare("INSERT INTO memories (text, tags, private) VALUES (?, ?, ?)");
        return facts.map(({ text, tags, private: priv }) => {
          const p = priv ?? memoryDefaultPrivate(app.settings);
          return { id: Number(ins.run(text, tags?.join(", ") ?? null, p ? 1 : 0).lastInsertRowid), private: p };
        });
      },
    }),
    defineTool({
      name: "memory_search",
      description: "Search saved memories about the user",
      tags: ["remember", "recall"],
      schema: z.object({ query: z.string() }),
      run: async ({ query }, ctx) => {
        const q = (query.match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => `"${w}"`).join(" OR ");
        if (!q) return [];
        return touched(ctx, ctx.db.prepare(`SELECT m.id, m.text, m.tags, m.private, m.created_at FROM memories_fts f JOIN memories m ON m.id = f.rowid
          WHERE memories_fts MATCH ? AND ${seen(ctx, "m")} ORDER BY rank LIMIT 10`).all(q) as { private: number }[]);
      },
    }),
    defineTool({
      name: "memory_forget",
      description: "Delete a saved memory by id (e.g. when it's outdated or wrong)",
      schema: z.object({ id: z.number().int() }),
      run: async ({ id }, ctx) =>
        ctx.db.prepare(`DELETE FROM memories WHERE id = ? AND ${seen(ctx)}`).run(id).changes ? "forgotten" : "no such memory",
    }),
  ],
});
