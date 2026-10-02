// Turn files and mails into plain text. Add a new format = add a branch here.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, extname, basename } from "node:path";
import { simpleParser } from "mailparser";

/** What connectors hand to the ingester. */
export interface RawItem {
  externalId: string;
  title: string;
  author?: string;
  date?: string;
  mime: string;
  content: string;
  hash: string;
  attachments?: RawItem[];
}

export const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex").slice(0, 32);

const TEXT_EXT = new Set([".txt", ".md", ".csv", ".json", ".log", ".yaml", ".yml"]);
export const SUPPORTED = new Set([...TEXT_EXT, ".pdf", ".eml", ".html", ".htm"]);

export async function extractFile(path: string, externalId = path): Promise<RawItem | null> {
  const ext = extname(path).toLowerCase();
  const buf = readFileSync(path);
  if (ext === ".eml") return parseMail(buf, externalId);
  const text = await extractBuffer(buf, ext);
  if (text === null) return null;
  return { externalId, title: basename(path), mime: ext.slice(1), content: text, hash: sha(buf) };
}

export async function extractBuffer(buf: Buffer, ext: string): Promise<string | null> {
  if (TEXT_EXT.has(ext)) return buf.toString("utf8");
  if (ext === ".html" || ext === ".htm") return htmlToText(buf.toString("utf8"));
  if (ext === ".pdf") return pdfToText(buf);
  return null;
}

function pdfToText(buf: Buffer): string {
  const tmp = join(tmpdir(), `los-${crypto.randomUUID()}.pdf`);
  writeFileSync(tmp, buf);
  try {
    const text = execFileSync("pdftotext", ["-enc", "UTF-8", "-layout", tmp, "-"], { maxBuffer: 64 << 20 }).toString();
    // Scanned PDFs have no text layer. Plug OCR in here (e.g. `ocrmypdf` or tesseract) when you need it.
    return text.trim() ? text : "[PDF has no text layer — scanned document, OCR not configured]";
  } finally {
    rmSync(tmp, { force: true });
  }
}

export async function parseMail(raw: Buffer, externalId?: string): Promise<RawItem> {
  const m = await simpleParser(raw);
  const id = m.messageId ?? externalId ?? sha(raw);
  const attachments: RawItem[] = [];
  for (const a of m.attachments ?? []) {
    const ext = extname(a.filename ?? "").toLowerCase();
    const text = await extractBuffer(a.content, ext).catch(() => null);
    if (text?.trim())
      attachments.push({ externalId: `${id}#${a.filename}`, title: a.filename!, mime: ext.slice(1), content: text, hash: sha(a.content) });
  }
  const from = m.from?.text ?? "";
  const to = Array.isArray(m.to) ? m.to.map((t) => t.text).join(", ") : (m.to?.text ?? "");
  const body = m.text ?? (m.html ? htmlToText(m.html) : "");
  return {
    externalId: id,
    title: m.subject ?? "(no subject)",
    author: from,
    date: m.date?.toISOString(),
    mime: "email",
    // Headers go into the text so both keyword and semantic search can find "mail from X about Y".
    content: `From: ${from}\nTo: ${to}\nDate: ${m.date?.toISOString() ?? ""}\nSubject: ${m.subject ?? ""}\n\n${body}`,
    hash: sha(raw),
    attachments,
  };
}

export const htmlToText = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
