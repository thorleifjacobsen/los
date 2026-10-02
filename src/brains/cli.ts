// CLI brains. Claude Code, Codex and opencode are agents with their own loop; session.ts translates them into
// los's protocol, and this file only knows each one's flags and JSON stream. `cli` is any command: prompt in,
// answer on stdout, no tools.
// CLI flags change between versions — if something breaks, check `claude --help` / `codex exec --help` / `opencode run --help`.
import { spawn } from "node:child_process";
import type { AgentEvent, Brain, Message } from "../types.js";
import type { BrainConfig } from "../config.js";
import { sessionBrain, type Sink } from "./session.js";

/** A run failed because the runtime isn't logged in (or its login expired). The UI offers a re-login. */
export class BrainAuthError extends Error {
  constructor(public brain: string, detail: string) {
    super(`Brain "${brain}" is not logged in (${detail.trim().slice(0, 200)}). Log in again under Brains.`);
  }
}
const AUTH_HINT = /(\/login|not logged in|log ?in again|oauth token|authentication_error|invalid api key|invalid bearer|token (has )?expired|unauthori[sz]ed|\b401\b|please (run|sign)|no credentials)/i;
export const authOr = (brain: string, msg: string) => AUTH_HINT.test(msg) ? new BrainAuthError(brain, msg) : new Error(msg);

// A call may wait for an approval in the UI (up to 15 min), so the CLIs must wait longer than that for MCP calls.
const TOOL_TIMEOUT_S = 20 * 60;
const withSystem = (system: string, prompt: string, resumed: boolean) => system && !resumed ? `${system}\n\n---\n\n${prompt}` : prompt;

// ── Claude Code ──
// Only the loop: no built-in tools, no MCP servers but los's endpoint, no settings/hooks/plugins from the host's
// ~/.claude, and los's system prompt instead of its own. Brain args that would undo that are refused.
const CLAUDE_LOCKED = /^--(include-partial-messages|tools|allowed-?tools|disallowed-?tools|permission-mode|dangerously-skip-permissions|allow-dangerously-skip-permissions|mcp-config|strict-mcp-config|setting-sources|settings|add-dir|plugin-dir|agents?|system-prompt(-file)?|append-system-prompt(-file)?|max-turns|thinking-display)$/i;

export function claudeCodeBrain(id: string, cfg: BrainConfig): Brain {
  const locked = (cfg.args ?? []).find((a) => CLAUDE_LOCKED.test(a.split("=")[0]));
  if (locked) throw new Error(`brain "${id}": ${locked} is not allowed in args (los decides Claude Code's tools)`);
  return sessionBrain(id, cfg, {
    command: "claude",
    args: ({ prompt, system, resumeRef, mcpUrl }) => [
      "-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      ...(resumeRef ? ["--resume", resumeRef] : ["--session-id", crypto.randomUUID()]),
      ...(cfg.model ? ["--model", cfg.model] : []),
      ...(system ? ["--system-prompt", system] : []),
      "--tools", "",
      "--mcp-config", JSON.stringify({ mcpServers: mcpUrl ? { los: { type: "http", url: mcpUrl } } : {} }), "--strict-mcp-config",
      ...(mcpUrl ? ["--allowedTools", "mcp__los"] : []),
      "--setting-sources", "",
      "--thinking-display", "summarized", // newer models send thinking blocks empty unless asked for a summary
      ...(cfg.args ?? []),
    ],
    env: () => ({ MCP_TOOL_TIMEOUT: String(TOOL_TIMEOUT_S * 1000) }),
    parser: () => {
      let model: string | undefined, lastCall: any; // usage of the last API call = the context size now
      return (ev, s) => {
        if (ev.type === "system" && ev.subtype === "init") { model = ev.model; s.ref(ev.session_id, ev); }
        else if (ev.type === "system" || ev.type === "rate_limit_event") s.note({ type: "runtime", raw: ev, brain: id });
        if (ev.type === "stream_event") { // --include-partial-messages: live tokens
          const d = ev.event?.type === "content_block_delta" ? ev.event.delta : null;
          if (d?.type === "text_delta") s.delta({ text: d.text });
          else if (d?.type === "thinking_delta") s.delta({ thinking: d.thinking });
          return;
        }
        if (ev.type === "assistant") {
          if (ev.message?.usage) lastCall = ev.message.usage;
          for (const b of ev.message?.content ?? []) {
            if (b.type === "text") s.text(b.text);
            else if (b.type === "thinking" && b.thinking) s.thinking(b.thinking);
          }
        }
        if (ev.type !== "result") return;
        s.note({ type: "runtime", raw: ev, brain: id });
        const u = ev.usage ?? {};
        s.usage({ input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0,
          output: u.output_tokens ?? 0, cost: ev.total_cost_usd, ms: ev.duration_ms });
        if (lastCall && !ev.is_error) s.context({
          model, window: (ev.modelUsage?.[model ?? ""] ?? (Object.values(ev.modelUsage ?? {})[0] as any))?.contextWindow,
          used: (lastCall.input_tokens ?? 0) + (lastCall.cache_read_input_tokens ?? 0) + (lastCall.cache_creation_input_tokens ?? 0) + (lastCall.output_tokens ?? 0),
        });
        if (ev.is_error) s.error(ev.result || ev.subtype || "claude reported an error");
        else s.answer(ev.result ?? "");
      };
    },
  });
}

// ── Codex ── (its own shell/edit tools still exist next to los's; they're logged as notes)
export function codexBrain(id: string, cfg: BrainConfig): Brain {
  return sessionBrain(id, cfg, {
    command: "codex",
    answerOnExit: true,
    args: ({ prompt, system, resumeRef, mcpUrl }) => [
      "exec", "--json", "--skip-git-repo-check",
      ...(cfg.model ? ["-m", cfg.model] : []),
      ...(mcpUrl ? ["-c", `mcp_servers.los.url=${JSON.stringify(mcpUrl)}`, "-c", `mcp_servers.los.tool_timeout_sec=${TOOL_TIMEOUT_S}`] : []),
      ...(cfg.args ?? []),
      ...(resumeRef ? ["resume", resumeRef] : []),
      withSystem(system, prompt, !!resumeRef),
    ],
    parser: () => {
      const started = Date.now(), open = new Set<string>();
      return (ev, s) => {
        if (ev.type === "thread.started") s.ref(ev.thread_id, ev);
        const item = ev.item;
        if (item?.type === "agent_message" && ev.type === "item.completed") { s.text(item.text ?? ""); s.answer(item.text ?? ""); }
        else if (item) codexStep(item, ev.type === "item.completed", open, s.note);
        if (ev.type === "turn.completed") {
          const u = ev.usage ?? {};
          s.note({ type: "runtime", raw: ev, brain: id });
          s.usage({ input: u.input_tokens ?? 0, cached: u.cached_input_tokens ?? 0, output: u.output_tokens ?? 0, ms: Date.now() - started });
        }
        if (ev.type === "turn.failed" || ev.type === "error") s.error(ev.error?.message ?? ev.message ?? "codex failed");
      };
    },
  });
}

// Codex's own steps (commands, edits, searches) → log notes. Calls to los's endpoint are already los tool calls.
function codexStep(item: any, done: boolean, open: Set<string>, note: (e: AgentEvent) => void) {
  const call = (name: string, args: Record<string, unknown>) => ({ id: item.id, name: `codex · ${name}`, args });
  let c: { id: string; name: string; args: Record<string, unknown> } | null = null, out = "";
  if (item.type === "command_execution") { c = call("shell", { command: item.command }); out = item.aggregated_output ?? ""; }
  else if (item.type === "mcp_tool_call" && item.server !== "los") { c = call(`${item.server}·${item.tool}`, item.arguments ?? {}); out = item.error?.message ?? textOf(item.result?.content); }
  else if (item.type === "web_search") c = call("web_search", { query: item.query });
  else if (item.type === "file_change") c = call("edit", { files: (item.changes ?? []).map((x: any) => `${x.kind} ${x.path}`).join(", ") });
  if (!c) return;
  if (!done) { open.add(item.id); note({ type: "tool_call", call: c }); return; }
  if (!open.delete(item.id)) note({ type: "tool_call", call: c });
  const ok = item.status !== "failed" && !item.error && (item.exit_code ?? 0) === 0;
  note({ type: "tool_result", id: item.id, name: c.name, ok, preview: String(out).slice(0, 200), output: String(out) });
}

// ── opencode ── (los's tools come over MCP as "los_<tool>"; its own built-ins are refused by opencode-guard.js)
const OPENCODE_GUARD = new URL("./opencode-guard.js", import.meta.url).href;
export function opencodeBrain(id: string, cfg: BrainConfig): Brain {
  return sessionBrain(id, cfg, {
    command: "opencode",
    answerOnExit: true,
    args: ({ prompt, system, resumeRef }) => [
      "run", "--format", "json", "--thinking", // --thinking: reasoning parts in the stream (allowed on the free tier)
      ...(resumeRef ? ["-s", resumeRef] : []),
      ...(cfg.model ? ["-m", cfg.model] : []),
      ...(cfg.args ?? []),
      withSystem(system, prompt, !!resumeRef),
    ],
    // Always the guard (its built-ins can't be switched off on the free tier, but they can be refused), plus los's tools.
    env: ({ mcpUrl }): Record<string, string> => ({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        plugin: [OPENCODE_GUARD],
        ...(mcpUrl ? { mcp: { los: { type: "remote", url: mcpUrl, enabled: true, timeout: TOOL_TIMEOUT_S * 1000 } } } : {}),
      }),
    }),
    parser: () => {
      const started = Date.now(), tokens = { input: 0, output: 0, cached: 0, cost: 0 };
      let refSent = false, step: string[] = [];
      return (ev, s) => {
        if (ev.sessionID && !refSent) { refSent = true; s.ref(ev.sessionID, { type: "init", sessionID: ev.sessionID }); }
        const p = ev.part ?? {};
        if (ev.type === "step_start") step = [];                 // the answer is the text of the last step
        // opencode's run stream sends whole parts, not tokens: each one goes to the screen as soon as it's done.
        if (ev.type === "text" && p.text) { step.push(p.text); s.text(p.text); s.delta({ text: p.text }); s.answer(step.join("\n\n").trim()); }
        if (ev.type === "reasoning" && p.text) { s.delta({ thinking: p.text + "\n\n" }); s.thinking(p.text); }
        if (ev.type === "tool_use" && !String(p.tool).startsWith("los_")) {
          const callId = p.callID ?? p.id;
          s.note({ type: "tool_call", call: { id: callId, name: `opencode · ${p.tool}`, args: p.state?.input ?? {} } });
          const out = String(p.state?.output ?? p.state?.error ?? "");
          s.note({ type: "tool_result", id: callId, name: p.tool, ok: p.state?.status !== "error", preview: out.slice(0, 200), output: out });
        }
        if (ev.type === "step_finish") {
          const t = p.tokens ?? {};
          tokens.input += (t.input ?? 0) + (t.cache?.write ?? 0); tokens.output += (t.output ?? 0) + (t.reasoning ?? 0);
          tokens.cached += t.cache?.read ?? 0; tokens.cost += p.cost ?? 0;
          s.usage({ ...tokens, ms: Date.now() - started });
          s.context({ model: cfg.model, window: cfg.context_window, used: (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0) + (t.output ?? 0) });
        }
        if (ev.type === "error") s.error(ev.error?.data?.message ?? ev.error?.message ?? JSON.stringify(ev.error ?? ev));
      };
    },
  });
}

/** Any command line: `command` + `args`, with {prompt} replaced (or the prompt on stdin). stdout is the answer. No tools. */
export function cliBrain(id: string, cfg: BrainConfig): Brain {
  return {
    id,
    local: !!cfg.local,
    async complete({ system, messages, cwd }) {
      if (!cfg.command) throw new Error(`brain "${id}": type cli needs a \`command\``);
      const full = withSystem(system, transcript(messages), false);
      const inArgs = (cfg.args ?? []).some((a) => a.includes("{prompt}"));
      const args = (cfg.args ?? []).map((a) => a.replaceAll("{prompt}", full));
      const started = Date.now();
      const { stdout } = await run(cfg.command, args, { cwd, env: { ...process.env, ...(cfg.env ?? {}) }, stdin: inArgs ? undefined : full });
      return { text: stdout.trim(), toolCalls: [], usage: { input: 0, output: 0, ms: Date.now() - started } };
    },
  };
}
// A plain command has no message list, so the conversation goes in as text (only the last message if it's the first).
const transcript = (messages: Message[]) => messages.length === 1 ? messages[0].content : messages
  .filter((m) => m.role !== "tool" && m.content.trim())
  .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");

// ── process helpers ──
const textOf = (c: unknown): string => typeof c === "string" ? c
  : Array.isArray(c) ? c.map((x: any) => (x?.type === "text" ? x.text : `[${x?.type}]`)).join("\n") : "";

type RunOpts = { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string };

export function run(cmd: string, args: string[], o: RunOpts = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: [o.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout!.on("data", (d) => (out += d));
    p.stderr!.on("data", (d) => (err += d));
    if (o.stdin !== undefined) p.stdin!.end(o.stdin);
    p.on("error", (e) => reject(new Error(`${cmd}: ${e.message} (is it installed and on PATH?)`)));
    p.on("close", (code) => code === 0 ? resolve({ stdout: out, stderr: err }) : reject(new Error(`${cmd} exited ${code}: ${(err || out).slice(-500)}`)));
  });
}
