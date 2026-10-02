// Shell commands in the agent's workspace. Needs approval unless the agent lists it in `auto_approve`
// (a command can reach anything the los container can, so it's never silent by default).
import { spawn } from "node:child_process";
import { definePlugin, defineTool, z } from "../../tools/define.js";

const MAX_OUTPUT = 30_000;

export default definePlugin({
  name: "shell",
  description: "Run shell commands",
  tools: [
    defineTool({
      name: "shell_run",
      description:
        "Run a bash command in your workspace and return its exit code and combined stdout+stderr. " +
        "Use it for git, builds, tests, package managers and other CLI tools; prefer the files_* tools for " +
        "reading, writing and searching files. Each call is a fresh shell (cd and exported variables don't carry " +
        "over), there is no stdin, and interactive commands will hang until the timeout. Output over 30k chars is cut.",
      tags: ["bash", "terminal", "command", "exec", "run", "git", "npm"],
      sideEffect: true,
      schema: z.object({
        command: z.string().describe("The bash command, e.g. `git status && npm test`"),
        timeout_s: z.number().int().min(1).max(1800).optional().describe("Kill it after this many seconds (default 120)"),
      }),
      run: ({ command, timeout_s = 120 }, ctx) =>
        new Promise((resolve) => {
          const p = spawn("bash", ["-c", command], {
            cwd: ctx.workdir, stdio: ["ignore", "pipe", "pipe"], detached: true, // own process group, so a timeout kills children too
            env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb", CI: "1" },
          });
          let out = "", cut = false, timedOut = false;
          const add = (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d; else cut = true; };
          p.stdout!.on("data", add);
          p.stderr!.on("data", add);
          const timer = setTimeout(() => { timedOut = true; try { process.kill(-p.pid!, "SIGKILL"); } catch {} }, timeout_s * 1000);
          const done = (exit: string) => {
            clearTimeout(timer);
            const note = timedOut ? `\n[killed after ${timeout_s}s]` : cut ? "\n…[output truncated]" : "";
            resolve(`exit ${exit}\n${out.slice(0, MAX_OUTPUT)}${note}`);
          };
          p.on("error", (e) => done(`error: ${e.message}`));
          p.on("close", (code, signal) => done(code === null ? String(signal) : String(code)));
        }),
    }),
  ],
});
