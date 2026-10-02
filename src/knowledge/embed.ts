// Embeddings via the OpenAI-compatible /embeddings endpoint (Ollama supports it).
// Must be a local brain: embeddings see every document you ingest.
import type { Settings } from "../config.js";

export async function embed(settings: Settings, texts: string[]): Promise<number[][] | null> {
  const cfg = settings.embeddings;
  if (!cfg || !texts.length) return null;
  const brain = settings.brains[cfg.brain];
  if (!brain?.local) throw new Error(`embeddings brain "${cfg.brain}" must be local: true`);
  const base = brain.base_url!.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, input: texts }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    return data.data.map((d: any) => d.embedding);
  } catch (e) {
    console.warn(`embeddings unavailable (${(e as Error).message}) — keyword search only`);
    return null;
  }
}

export const toVec = (v: number[]) => new Float32Array(v);
