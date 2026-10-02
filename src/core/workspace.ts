// The workspace: one shared folder (data/workspace) that you and the agents both work in. You browse, upload and
// search it in the UI; agents use files_* and shell_run in it; it's indexed for knowledge search; and anything in it
// can be shown in a chat as /files/<path> (images inline, other files as links).
// Privacy: a file or a whole folder can be private (file_flags, source "workspace"). The nearest flag wins.
// Two separate things, two words:
//   private  (file_flags)   about AI: only local brains (or agents granted access) may read it.
//   shared   (public_links) about the web: a permanent share link with a random id (/s/<id>/…) anyone can open
//            without logging in, until it's switched off. Private wins: a private file is never shared.
// Everything else is just yours: you open it through los (scoped, short-lived viewing links).
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import type { App } from "../app.js";
import type { DB } from "../db/index.js";

export const WORKSPACE = "workspace"; // its knowledge source id, and the file_flags source
const SKIP = new Set(["node_modules", ".git"]);

export function workspaceDir(app: App) {
  const p = resolve(app.settings.root, "data/workspace");
  mkdirSync(p, { recursive: true });
  return p;
}

/** A path inside the workspace (relative, "" = the root), or throws. Symlinks can't lead out. */
export function wsPath(app: App, rel: string) {
  const root = realpathSync(workspaceDir(app));
  const clean = String(rel ?? "").replace(/^\/+/, "");
  const full = resolve(root, clean);
  let probe = full;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  for (const p of [full, real]) if (p !== root && !p.startsWith(root + sep)) throw new Error(`"${rel}" is outside the workspace`);
  return { root, full, rel: relative(root, full).split(sep).join("/") };
}

/** The flag on the path itself or the nearest folder above it, or undefined if none is set. */
export function flagFor(db: DB, rel: string, source = WORKSPACE): boolean | undefined {
  const parts = rel.split("/").filter(Boolean);
  const flags = new Map((db.prepare("SELECT external_id, private FROM file_flags WHERE source = ?").all(source) as any[]).map((r) => [r.external_id, !!r.private]));
  for (let i = parts.length; i > 0; i--) {
    const p = parts.slice(0, i).join("/");
    if (flags.has(p)) return flags.get(p)!;
  }
  return undefined;
}
export const isPrivatePath = (db: DB, rel: string, source = WORKSPACE) => flagFor(db, rel, source) ?? false;

// ── share links ──
type Link = { id: string; path: string };
const links = (db: DB) => db.prepare("SELECT id, path FROM public_links").all() as Link[];
/** Where share links point: web.files_url (their own origin) if set, else los's own address. */
export const shareUrl = (app: App, id: string, sub = "") => `${app.settings.web?.files_url?.replace(/\/$/, "") ?? ""}/s/${id}/${sub}`;
/** The link that makes `rel` shared: its own, or the nearest shared folder above it. */
export function shareLinkFor(db: DB, rel: string): (Link & { sub: string }) | null {
  const all = links(db);
  const parts = rel.split("/").filter(Boolean);
  for (let i = parts.length; i > 0; i--) {
    const p = parts.slice(0, i).join("/"), l = all.find((x) => x.path === p);
    if (l) return { ...l, sub: parts.slice(i).join("/") };
  }
  return null;
}
/** Share or stop sharing a file/folder. Returns its share URL (or null when switched off). */
export function setShared(app: App, rel: string, on: boolean): string | null {
  const { db } = app;
  const { full, rel: clean } = wsPath(app, rel);
  if (!clean || !existsSync(full)) throw new Error(`no file or folder "${rel}" in the workspace`);
  const isDir = statSync(full).isDirectory();
  const url = (l: Link & { sub?: string }) => shareUrl(app, l.id, l.sub ?? (isDir ? "" : clean.split("/").pop()));
  const current = shareLinkFor(db, clean);
  if (on) {
    if (isPrivatePath(db, clean)) throw new Error(`"${clean}" is private (for AI: local models only), so it can't be shared`);
    if (current) return url(current);
    const id = randomBytes(16).toString("base64url");
    db.prepare("INSERT INTO public_links (id, path) VALUES (?, ?)").run(id, clean);
    return url({ id, path: clean });
  }
  if (current && current.path !== clean) throw new Error(`"${clean}" is shared because the folder "${current.path}" is; stop sharing that`);
  db.prepare("DELETE FROM public_links WHERE path = ?").run(clean);
  return null;
}
/** A share request /s/<id>/<rest> → the workspace path to serve, or null (unknown, outside it, or private). */
export function resolveShared(app: App, id: string, rest: string): string | null {
  const l = app.db.prepare("SELECT id, path FROM public_links WHERE id = ?").get(id) as Link | undefined;
  if (!l) return null;
  let target: string;
  try { target = wsPath(app, l.path).full; } catch { return null; }
  if (!existsSync(target)) return null;
  let rel: string;
  if (statSync(target).isDirectory()) {
    try { rel = wsPath(app, `${l.path}/${rest}`).rel; } catch { return null; }
    if (rel !== l.path && !rel.startsWith(l.path + "/")) return null; // ../ out of the shared folder
  } else {
    if (rest && rest !== l.path.split("/").pop()) return null; // a shared file is only itself
    rel = l.path;
  }
  return isPrivatePath(app.db, rel) ? null : rel;
}
/** Keep share links pointing at the right place when something is moved, and drop them when it's deleted. */
export function moveShared(db: DB, from: string, to: string) {
  db.prepare("UPDATE public_links SET path = ? || substr(path, ?) WHERE path = ? OR path LIKE ? || '/%'").run(to, from.length + 1, from, from);
}
export function dropShared(db: DB, rel: string) {
  db.prepare("DELETE FROM public_links WHERE path = ? OR path LIKE ? || '/%'").run(rel, rel);
}

export type Entry = { name: string; path: string; dir: boolean; size: number; modified: string; private: boolean; indexed: boolean; children?: number;
  shared?: { url: string; own: boolean } };

export function listDir(app: App, rel: string): Entry[] {
  const { full, rel: base } = wsPath(app, rel);
  if (!existsSync(full) || !statSync(full).isDirectory()) throw new Error(`no folder "${rel}"`);
  const indexed = new Set((app.db.prepare("SELECT external_id FROM documents WHERE source = ? AND parent_id IS NULL").all(WORKSPACE) as any[]).map((r) => r.external_id));
  return readdirSync(full).filter((n) => !n.startsWith(".")).map((name) => {
    const st = statSync(join(full, name));
    const path = base ? `${base}/${name}` : name;
    return {
      name, path, dir: st.isDirectory(), size: st.size, modified: st.mtime.toISOString(), private: isPrivatePath(app.db, path), indexed: indexed.has(path),
      ...(() => { const l = shareLinkFor(app.db, path); return l && !isPrivatePath(app.db, path)
        ? { shared: { url: shareUrl(app, l.id, l.sub || (st.isDirectory() ? "" : l.path === path ? name : l.sub)), own: l.path === path } } : {}; })(),
      ...(st.isDirectory() && { children: readdirSync(join(full, name)).filter((n) => !n.startsWith(".")).length }),
    };
  }).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

/** Names (any depth) and contents (ripgrep) matching `q`. */
export async function searchWorkspace(app: App, q: string) {
  const root = workspaceDir(app), needle = q.toLowerCase();
  const names: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const n of readdirSync(d)) {
      if (n.startsWith(".") || SKIP.has(n)) continue;
      const p = prefix ? `${prefix}/${n}` : n;
      if (n.toLowerCase().includes(needle)) names.push(p);
      if (names.length < 200 && statSync(join(d, n)).isDirectory()) walk(join(d, n), p);
    }
  };
  walk(root, "");
  const content = await new Promise<{ path: string; line: number; text: string }[]>((res) =>
    // -e and --: the query and path are never read as options (a query like "--pre=…" would run a program).
    execFile("rg", ["--json", "-i", "-F", "--max-count=3", "--max-columns=240", "-g", "!node_modules", "-e", q, "--", "."], { cwd: root, maxBuffer: 8 << 20 }, (_e, out) => {
      const hits: { path: string; line: number; text: string }[] = [];
      for (const l of String(out ?? "").split("\n")) {
        try {
          const j = JSON.parse(l);
          if (j.type === "match") hits.push({ path: j.data.path.text.replace(/^\.\//, ""), line: j.data.line_number, text: j.data.lines.text.trim().slice(0, 240) });
        } catch { /* not json */ }
        if (hits.length >= 100) break;
      }
      res(hits);
    }));
  return { names: names.slice(0, 100).map((path) => ({ path, private: isPrivatePath(app.db, path) })), content: content.map((h) => ({ ...h, private: isPrivatePath(app.db, h.path) })) };
}
