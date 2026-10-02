// Mail-specific views over the knowledge index. Sending is deliberately draft-only:
// an agent that reads untrusted mail should never be able to send mail on its own.
import { definePlugin, defineTool, z } from "../../tools/define.js";
import { seen, touched } from "../../core/privacy.js";

export default definePlugin({
  name: "mail",
  description: "Recent emails and email drafts",
  schema: `CREATE TABLE IF NOT EXISTS mail_drafts (id INTEGER PRIMARY KEY, to_addr TEXT NOT NULL, subject TEXT NOT NULL,
    body TEXT NOT NULL, in_reply_to INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  tools: [
    defineTool({
      name: "mail_recent",
      description: "List recent emails (newest first) with sender, subject and summary",
      tags: ["inbox", "email", "unread"],
      schema: z.object({ days: z.number().int().max(365).optional(), from: z.string().optional() }),
      run: async ({ days = 7, from }, ctx) => touched(ctx,
        ctx.db.prepare(`SELECT id, author AS sender, title AS subject, date, summary, private FROM documents
          WHERE mime = 'email' AND date >= datetime('now', ?) AND ${seen(ctx)} ${from ? "AND author LIKE ?" : ""}
          ORDER BY date DESC LIMIT 50`).all(`-${days} days`, ...(from ? [`%${from}%`] : [])) as { private: number }[]),
    }),
    defineTool({
      name: "mail_draft",
      description: "Write an email draft for the user to review and send themselves",
      tags: ["email", "reply", "write"],
      schema: z.object({ to: z.string(), subject: z.string(), body: z.string(), in_reply_to: z.number().int().optional() }),
      run: async ({ to, subject, body, in_reply_to }, { db }) => ({
        draft_id: Number(db.prepare("INSERT INTO mail_drafts (to_addr, subject, body, in_reply_to) VALUES (?, ?, ?, ?)")
          .run(to, subject, body, in_reply_to ?? null).lastInsertRowid),
      }),
    }),
  ],
});
