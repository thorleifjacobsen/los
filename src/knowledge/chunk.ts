// Split text into overlapping chunks (~600 tokens). Paragraph-aware so chunks don't cut mid-sentence when avoidable.
const SIZE = 2400;
const OVERLAP = 300;

export function chunk(text: string): string[] {
  const paras = text.replace(/\r/g, "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras.flatMap((p) => (p.length > SIZE ? hardSplit(p) : [p]))) {
    if (cur && cur.length + p.length + 2 > SIZE) {
      chunks.push(cur);
      cur = cur.slice(-OVERLAP) + "\n\n" + p;
    } else cur = cur ? cur + "\n\n" + p : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function hardSplit(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += SIZE - OVERLAP) out.push(s.slice(i, i + SIZE));
  return out;
}
