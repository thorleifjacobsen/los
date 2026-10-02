// Hybrid search: BM25 (exact words, names, numbers) + vectors (meaning), merged with reciprocal rank fusion.
import type { App } from "../app.js";
import { hasTable } from "../db/index.js";
import { embed, toVec } from "./embed.js";

export type Hit = { docId: number; title: string; source: string; date: string | null; summary: string | null; snippet: string; score: number; private: number };

const RRF_K = 60;

/** `includePrivate: false` (cloud brains) leaves private documents out entirely. */
export async function search(app: App, query: string, opts: { source?: string; limit?: number; includePrivate?: boolean } = {}): Promise<Hit[]> {
  const { db } = app;
  const limit = opts.limit ?? 8;
  const pool = limit * 5;
  const scores = new Map<number, number>(); // chunk id → fused score

  // 1. Keyword (FTS5/BM25). Each word quoted so user input can't break FTS syntax; OR for recall.
  const words = query.match(/[\p{L}\p{N}@._-]+/gu) ?? [];
  if (words.length) {
    const fts = words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
    const rows = db.prepare("SELECT rowid AS id FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?")
      .all(fts, pool) as { id: number }[];
    rows.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (RRF_K + i)));
  }

  // 2. Semantic (sqlite-vec), if embeddings are configured and reachable.
  if (hasTable(db, "chunks_vec")) {
    const [v] = (await embed(app.settings, [query])) ?? [];
    if (v) {
      const rows = db.prepare("SELECT rowid AS id FROM chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance")
        .all(toVec(v), pool) as { id: number }[];
      rows.forEach((r, i) => scores.set(Number(r.id), (scores.get(Number(r.id)) ?? 0) + 1 / (RRF_K + i)));
    }
  }

  // 3. Best chunk per document, filtered by source.
  const get = db.prepare(`SELECT c.document_id AS docId, c.text, d.title, d.source, d.date, d.summary, d.private
    FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = ?`);
  const byDoc = new Map<number, Hit>();
  for (const [id, score] of [...scores].sort((a, b) => b[1] - a[1])) {
    const r = get.get(id) as any;
    if (!r || byDoc.has(r.docId)) continue;
    if (opts.source && !r.source.startsWith(opts.source)) continue;
    if (r.private && opts.includePrivate === false) continue;
    byDoc.set(r.docId, { docId: r.docId, title: r.title, source: r.source, date: r.date, summary: r.summary,
      snippet: snippet(r.text, words), score: Number(score.toFixed(4)), private: r.private });
    if (byDoc.size >= limit) break;
  }
  return [...byDoc.values()];
}

function snippet(text: string, words: string[], len = 300) {
  const lower = text.toLowerCase();
  const at = Math.max(0, ...words.map((w) => lower.indexOf(w.toLowerCase())).filter((i) => i >= 0).slice(0, 1));
  const start = Math.max(0, at - 80);
  return (start ? "…" : "") + text.slice(start, start + len).replace(/\s+/g, " ") + "…";
}
