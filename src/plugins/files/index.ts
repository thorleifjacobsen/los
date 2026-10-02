// Read, write, edit and search files in the agent's workspace (the shared data/workspace, unless the agent has its own
// workdir). Paths can't leave it (symlinks included), so these need no approval. Anything outside goes through
// shell_run. Private files and folders (Workspace page) are invisible to brains that may not read private data.
import { readFile, writeFile, mkdir, realpath, stat, glob } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import type { App } from "../../app.js";
import type { ToolContext } from "../../types.js";
import { definePlugin, defineTool, z } from "../../tools/define.js";
import { isPrivatePath, workspaceDir, setShared } from "../../core/workspace.js";
import { markPrivate } from "../../core/session.js";

const MAX_READ = 2000;     // lines per files_read
const MAX_LIST = 500;

/** Resolve `p` inside the workspace, or throw. Checks the real path of the nearest existing ancestor. */
async function inside(workdir: string, p: string) {
  const root = await realpath(workdir);
  const full = resolve(root, p);
  let probe = full;
  for (;;) {
    try { probe = await realpath(probe); break; }
    catch { const up = dirname(probe); if (up === probe) break; probe = up; }
  }
  if (probe !== root && !probe.startsWith(root + sep)) throw new Error(`"${p}" is outside the workspace`);
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`"${p}" is outside the workspace`);
  return full;
}

/** Workspace-relative path of `full`, or null if it isn't in the shared workspace (an agent with its own workdir). */
const wsRel = (app: App, full: string) => { const r = relative(workspaceDir(app), full); return r.startsWith("..") ? null : r.split(sep).join("/"); };
/** Private files (or files in a private folder) are invisible to brains that may not see private data. */
function checkPrivate(app: App, ctx: ToolContext, full: string, path: string) {
  const rel = wsRel(app, full);
  if (rel === null || !isPrivatePath(ctx.db, rel)) return;
  if (!ctx.brainIsLocal) throw new Error(`"${path}" is private`);
  markPrivate(ctx.db, ctx.sessionId);
}
const hidden = (app: App, ctx: ToolContext, root: string, p: string) => !ctx.brainIsLocal && (() => { const r = wsRel(app, resolve(root, p)); return r !== null && isPrivatePath(ctx.db, r); })();

export default (app: App) => definePlugin({
  name: "files",
  description: "Read, write, edit and search files in the workspace",
  tools: [
    defineTool({
      name: "files_read",
      description:
        "Read a text file from your workspace. Returns numbered lines (`<n>\\t<line>`), up to 2000 at a time; " +
        "use offset to read further. The numbers are for reference only and are not part of the file.",
      tags: ["file", "cat", "open", "view"],
      schema: z.object({
        path: z.string().describe("Path relative to the workspace"),
        offset: z.number().int().min(1).optional().describe("First line to return (default 1)"),
        limit: z.number().int().min(1).max(MAX_READ).optional().describe(`Number of lines (default ${MAX_READ})`),
      }),
      run: async ({ path, offset = 1, limit = MAX_READ }, ctx) => {
        const file = await inside(ctx.workdir, path);
        checkPrivate(app, ctx, file, path);
        const lines = (await readFile(file, "utf8")).split("\n");
        const end = Math.min(lines.length, offset - 1 + limit);
        const body = lines.slice(offset - 1, end).map((l, i) => `${offset + i}\t${l}`).join("\n");
        return end < lines.length ? `${body}\n[lines ${offset}-${end} of ${lines.length}; use offset to read more]` : body;
      },
    }),
    defineTool({
      name: "files_write",
      description: "Create or overwrite a file in your workspace with the given content. Creates parent folders. " +
        "For changing part of an existing file, use files_edit instead.",
      tags: ["file", "create", "save"],
      schema: z.object({ path: z.string(), content: z.string() }),
      run: async ({ path, content }, ctx) => {
        const full = await inside(ctx.workdir, path);
        checkPrivate(app, ctx, full, path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content);
        return `Wrote ${Buffer.byteLength(content)} bytes to ${path}`;
      },
    }),
    defineTool({
      name: "files_edit",
      description:
        "Replace exact text in a file. old_text must match the file exactly (whitespace and indentation included) " +
        "and be unique, unless replace_all is set. Include enough surrounding lines to make it unique. " +
        "Read the file first; don't copy the line-number prefixes from files_read.",
      tags: ["file", "modify", "replace", "patch", "change"],
      schema: z.object({
        path: z.string(),
        old_text: z.string().min(1),
        new_text: z.string(),
        replace_all: z.boolean().optional(),
      }),
      run: async ({ path, old_text, new_text, replace_all }, ctx) => {
        const full = await inside(ctx.workdir, path);
        checkPrivate(app, ctx, full, path);
        const text = await readFile(full, "utf8");
        const count = text.split(old_text).length - 1;
        if (!count) throw new Error("old_text was not found in the file");
        if (count > 1 && !replace_all) throw new Error(`old_text occurs ${count} times; add context or set replace_all`);
        await writeFile(full, replace_all ? text.replaceAll(old_text, new_text) : text.replace(old_text, () => new_text));
        return `Replaced ${replace_all ? count : 1} occurrence(s) in ${path}`;
      },
    }),
    defineTool({
      name: "files_share",
      description: "Share a workspace file or folder on the web (share: true), or stop sharing it (false). Shared means a " +
        "permanent share link with a random id that anyone can open without logging in (a shared folder works as a " +
        "website). Only when the user wants something shared outside los; it asks them first. Files marked private " +
        "(for AI) can't be shared.",
      tags: ["publish", "share", "public", "link", "website", "host"],
      sideEffect: true,
      schema: z.object({
        path: z.string().describe("File or folder, relative to the workspace"),
        share: z.boolean(),
      }),
      run: async ({ path, share: on }, ctx) => {
        const full = await inside(ctx.workdir, path);
        const rel = wsRel(app, full);
        if (rel === null) throw new Error("only files in the shared workspace can be shared");
        checkPrivate(app, ctx, full, path);
        const url = setShared(app, rel, on);
        return url ? { shared: true, url, note: "Anyone with this link can open it, until sharing is switched off." } : { shared: false };
      },
    }),
    defineTool({
      name: "files_list",
      description: "List files in your workspace matching a glob, e.g. `**/*.ts` or `src/*`. Default: everything. " +
        "Skips node_modules and .git.",
      tags: ["file", "ls", "find", "glob", "directory", "folder"],
      schema: z.object({ pattern: z.string().optional().describe("Glob relative to the workspace (default **/*)") }),
      run: async ({ pattern = "**/*" }, ctx) => {
        const root = await inside(ctx.workdir, ".");
        const out: string[] = [];
        for await (const f of glob(pattern, { cwd: root, exclude: (p) => /(^|\/)(node_modules|\.git)$/.test(String(p)) })) {
          const full = resolve(root, f);
          if (relative(root, full).startsWith("..") || hidden(app, ctx, root, f)) continue;
          out.push((await stat(full).catch(() => null))?.isDirectory() ? `${f}/` : f);
          if (out.length >= MAX_LIST) { out.push(`…[stopped at ${MAX_LIST}]`); break; }
        }
        return out.length ? out.sort().join("\n") : "No matches.";
      },
    }),
    defineTool({
      name: "files_search",
      description: "Search file contents in your workspace with a regex (ripgrep). Returns `path:line:text` matches. " +
        "Respects .gitignore.",
      tags: ["file", "grep", "find", "regex", "code"],
      schema: z.object({
        pattern: z.string().describe("Regular expression (Rust regex syntax)"),
        path: z.string().optional().describe("Folder or file to search, relative to the workspace (default: all)"),
        glob: z.string().optional().describe("Only files matching this glob, e.g. `*.ts`"),
        ignore_case: z.boolean().optional(),
      }),
      run: async ({ pattern, path = ".", glob: only, ignore_case }, ctx) => {
        const root = await inside(ctx.workdir, ".");
        const full = await inside(ctx.workdir, path);
        const args = ["--line-number", "--no-heading", "--color=never", "--max-columns=300", "--max-count=50",
          ...(ignore_case ? ["-i"] : []), ...(only ? ["--glob", only] : []), "-e", pattern, "--", relative(root, full) || "."]; // --: a path is never an option
        return new Promise<string>((res, rej) =>
          execFile("rg", args, { cwd: root, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
            if (err && (err as any).code === 1) return res("No matches.");
            if (err) return rej(new Error(stderr.trim() || err.message));
            const lines = stdout.trimEnd().split("\n").filter((l) => !hidden(app, ctx, root, l.split(":")[0]));
            res(lines.length > 300 ? lines.slice(0, 300).join("\n") + `\n…[${lines.length - 300} more]` : lines.join("\n"));
          }));
      },
    }),
  ],
});
