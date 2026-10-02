// Search and read everything ingested (mail, PDFs, files). Private documents are left out for cloud brains,
// and taint the conversation when a local brain reads them (src/core/privacy.ts).
import type { App } from "../../app.js";
import { definePlugin, defineTool, z } from "../../tools/define.js";
import { search } from "../../knowledge/search.js";
import { seen, touched } from "../../core/privacy.js";

export default (app: App) =>
  definePlugin({
    name: "knowledge",
    description: "Search and read the document index: emails, PDFs, attachments and files",
    tools: [
      defineTool({
        name: "knowledge_search",
        description: "Search emails, PDFs and documents by keywords or meaning. Returns doc ids + snippets; then use knowledge_read.",
        tags: ["find", "lookup", "mail", "email", "pdf", "document", "invoice", "file"],
        schema: z.object({
          query: z.string(),
          source: z.string().optional().describe('Filter by source prefix, e.g. "mail" or "workspace"'),
          limit: z.number().int().max(25).optional(),
        }),
        run: async ({ query, source, limit }, ctx) => touched(ctx, await search(app, query, { source, limit, includePrivate: ctx.brainIsLocal })),
      }),
      defineTool({
        name: "knowledge_read",
        description: "Read a document from the index in full (or a slice of it) by doc id",
        tags: ["open", "read", "mail", "pdf", "document"],
        schema: z.object({
          doc_id: z.number().int(),
          offset: z.number().int().optional(),
          max_chars: z.number().int().max(40000).optional(),
        }),
        run: async ({ doc_id, offset = 0, max_chars = 12000 }, ctx) => {
          const { db } = ctx;
          const d = db.prepare(`SELECT id, source, title, author, date, summary, content, private FROM documents WHERE id = ? AND ${seen(ctx)}`).get(doc_id) as any;
          if (!d) return "no such document";
          touched(ctx, [d]);
          const attachments = db.prepare(`SELECT id, title FROM documents WHERE parent_id = ? AND ${seen(ctx)}`).all(doc_id);
          const content = d.content.slice(offset, offset + max_chars);
          const more = offset + max_chars < d.content.length ? `\n…[${d.content.length - offset - max_chars} more chars, use offset]` : "";
          return { ...d, content: content + more, attachments };
        },
      }),
      defineTool({
        name: "knowledge_sources",
        description: "List indexed sources and how many documents each has",
        schema: z.object({}),
        run: async (_, ctx) =>
          ctx.db.prepare(`SELECT source, count(*) AS documents, max(date) AS newest FROM documents WHERE ${seen(ctx)} GROUP BY source`).all(),
      }),
    ],
  });
