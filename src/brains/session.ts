// The translation layer for CLI agents: makes Claude Code, Codex and opencode speak the same protocol as an
// API brain (system + messages + tools in, text and/or tool calls out), so los runs the loop for them too.
//
//   complete() #1  starts the CLI with los's system prompt and the new user message (resuming its own session if
//                  it has one), and the tools as a per-run MCP endpoint. When the CLI calls a tool, the MCP request
//                  is held open and complete() returns that call, exactly like an API returning tool_calls.
//   los            runs the tool (approval, events, history) and calls complete() again with the result.
//   complete() #2  answers the held MCP request with that result, and waits for the next calls or the answer.
//
// The CLI never runs anything of its own: Claude Code gets `--tools ""`. (Codex and opencode still have built-in
// tools; those show up as notes in the event log, not as los tool calls.)
import { spawn, type ChildProcess } from "node:child_process";
import type { AgentEvent, Brain, CompleteRequest, Completion, ToolCall } from "../types.js";
import type { BrainConfig } from "../config.js";
import { openEndpoint, type CallResult } from "../mcp/server.js";
import { takeImages } from "../core/images.js";
import { authOr } from "./cli.js";

const BATCH_MS = 60; // calls arriving this close together are returned as one step (parallel tool calls)

/** What a CLI's event parser reports. */
export interface Sink {
  text(t: string): void;                       // assistant text (before tool calls, or part of the answer)
  thinking(t: string): void;                   // a finished thinking block
  delta(d: { text?: string; thinking?: string }): void; // live tokens
  answer(t: string): void;                     // the final answer, as far as the CLI says so far
  usage(u: NonNullable<Completion["usage"]>): void;
  context(c: NonNullable<Completion["context"]>): void;
  ref(ref: string, raw: unknown): void;        // the CLI's own session id, to resume next turn
  note(e: AgentEvent): void;                   // anything else for the event log
  error(msg: string): void;
}
export interface CliSpec {
  command: string;
  args(o: { prompt: string; system: string; resumeRef?: string; mcpUrl?: string }): string[];
  env?(o: { mcpUrl?: string }): Record<string, string>;
  parser(): (ev: any, sink: Sink) => void;     // fresh parser state per run
  answerOnExit?: boolean;                      // no "done" event: the answer stands once the process exits cleanly
}

type Held = { call: ToolCall; resolve: (r: CallResult) => void };

export function sessionBrain(id: string, cfg: BrainConfig, spec: CliSpec): Brain {
  let proc: ChildProcess | null = null;
  let endpoint: { url: string; close(): void } | null = null;
  let onEvent: ((e: AgentEvent) => void) | undefined;
  let fresh: Held[] = [];     // calls the CLI made that los hasn't seen yet
  let handed: Held[] = [];    // calls returned to los, waiting for their results
  let texts: string[] = [], thoughts: string[] = [];
  let onDelta: CompleteRequest["onDelta"];
  let answer: string | null = null, failed: string | null = null, exited = false, stderr = "";
  let usage: Completion["usage"], context: Completion["context"];
  let wake: (() => void) | null = null;
  const poke = () => { const w = wake; wake = null; w?.(); };

  const sink: Sink = {
    text: (t) => { if (t.trim()) texts.push(t); },
    thinking: (t) => { if (t.trim()) thoughts.push(t); },
    delta: (d) => onDelta?.(d),
    answer: (t) => { answer = t; },
    usage: (u) => { usage = u; },
    context: (c) => { context = c; },
    ref: (ref, raw) => onEvent?.({ type: "runtime", raw, brain: id, ref }),
    note: (e) => onEvent?.(e),
    error: (msg) => { failed = msg; },
  };

  async function start(req: CompleteRequest) {
    const lastUser = req.messages.findLast((m) => m.role === "user");
    const prompt = (req.resume?.preface ?? "") + (lastUser?.content ?? "");
    if (req.tools.length)
      endpoint = await openEndpoint(req.tools, (name, args) => new Promise((resolve) => {
        fresh.push({ call: { id: crypto.randomUUID(), name, args }, resolve });
        poke();
      }));
    const parse = spec.parser();
    const args = spec.args({ prompt, system: req.system, resumeRef: req.resume?.ref, mcpUrl: endpoint?.url });
    const p = spawn(spec.command, args, {
      cwd: req.cwd, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(cfg.env ?? {}), ...(spec.env?.({ mcpUrl: endpoint?.url }) ?? {}) },
    });
    proc = p;
    let buf = "";
    p.stdout!.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { ev = { type: "stdout", text: line }; }
        parse(ev, sink);
        poke();
      }
    });
    p.stderr!.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
    p.on("error", (e) => { failed = `${spec.command}: ${e.message} (is it installed and on PATH?)`; exited = true; poke(); });
    p.on("close", (code) => {
      exited = true;
      if (code !== 0 && answer === null && !failed) failed = `${spec.command} exited ${code}: ${(stderr || texts.join("\n")).slice(-500)}`;
      poke();
    });
  }

  async function next(): Promise<Completion> {
    for (;;) {
      if (fresh.length) {
        await new Promise((r) => setTimeout(r, BATCH_MS)); // let parallel siblings arrive
        const batch = fresh;
        fresh = [];
        handed = batch;
        const text = texts.join("\n\n"), reasoning = thoughts.join("\n\n") || undefined;
        texts = []; thoughts = [];
        return { text, toolCalls: batch.map((h) => h.call), reasoning };
      }
      if (answer !== null && (!spec.answerOnExit || exited)) {
        const done: Completion = { text: answer, toolCalls: [], usage, context, reasoning: thoughts.join("\n\n") || undefined };
        answer = null; texts = []; thoughts = []; usage = undefined; context = undefined;
        return done;
      }
      if (failed) throw authOr(id, failed);
      if (exited) {
        if (spec.answerOnExit) return { text: texts.join("\n\n"), toolCalls: [], usage, context };
        throw new Error(`${spec.command} ended without an answer`);
      }
      await new Promise<void>((r) => (wake = r));
    }
  }

  return {
    id,
    local: !!cfg.local,
    session: true,
    async complete(req) {
      onEvent = req.onEvent ?? onEvent;
      onDelta = req.onDelta ?? onDelta;
      if (req.signal?.aborted) throw req.signal.reason ?? new Error("Stopped.");
      if (!proc) await start(req);
      else {
        // Hand the CLI the results for the calls it's waiting on.
        for (const h of handed) {
          const m = req.messages.findLast((x) => x.role === "tool" && x.toolCallId === h.call.id);
          h.resolve(m && m.role === "tool" ? (({ text, images }) => ({ content: text, images }))(takeImages(m.content)) : { content: "No result: los skipped this call.", isError: true });
        }
        handed = [];
      }
      return next();
    },
    close() {
      for (const h of [...fresh, ...handed]) h.resolve({ content: "The run was stopped.", isError: true });
      fresh = []; handed = [];
      endpoint?.close();
      if (proc && !exited) proc.kill("SIGTERM");
    },
  };
}
