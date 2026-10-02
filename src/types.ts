// The whole vocabulary of the system. If you understand this file, you understand the codebase.
import type { z } from "zod";
import type { DB } from "./db/index.js";

// ── Messages (provider-neutral; brains translate to/from their own format) ──
export type ToolCall = { id: string; name: string; args: Record<string, unknown> };
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; agent?: string } // agent: who wrote it (rooms have several)
  | { role: "tool"; toolCallId: string; name: string; content: string };

// ── Tools ──
export type Privacy = "public" | "local-only"; // local-only = never exposed to a cloud brain

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;          // [a-z0-9_]+, convention: <plugin>_<action>
  description: string;   // what tool_search matches against — write it well
  schema: S;
  parameters?: Record<string, unknown>; // raw JSON Schema instead of converting `schema` (used for MCP tools)
  privacy?: Privacy;     // default: plugin's privacy, else "public"
  sideEffect?: boolean;  // true → needs approval (send, delete, pay, write outside sandbox)
  tags?: string[];
  run(args: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

export interface ToolContext {
  db: DB;
  sessionId: string;
  taskId?: number;
  agent: AgentConfig;
  brainIsLocal: boolean;
  workdir: string;                     // where shell_* and files_* work (the agent's workdir, else data/workspace)
  turn?: number;                       // the message this run started at (chats)
  activate(names: string[]): string[]; // used by tool_search to load tools into the session
}

// ── Plugins: a folder in src/plugins with an index.ts default-exporting one of these ──
export interface Plugin {
  name: string;
  description: string;
  privacy?: Privacy;
  schema?: string;                                   // SQL run at startup (CREATE TABLE IF NOT EXISTS…)
  tools: Tool<any>[];
  context?(ctx: { db: DB; sessionId: string; brainIsLocal: boolean; taskId?: number; agent?: string; turn?: number }): string | undefined; // injected into the system prompt each turn
}

// ── Brains: something that thinks ──
// One protocol for every brain, the OpenAI chat-completions shape: system + messages + tools in, text and/or tool
// calls out. los runs the loop and every tool call, whatever the brain. API brains (llama.cpp, Ollama, OpenRouter,
// OpenAI, Anthropic) map it to HTTP. CLI agents (Claude Code, Codex, opencode) are translated by src/brains/session.ts:
// the CLI stays running for the whole turn, and its tool calls come back out of complete() like any API's would.
export interface Brain {
  id: string;
  local: boolean;
  /** Keeps its own conversation in a process (CLI agents). los hands it every permitted tool up front (it can't
   *  load more mid-turn), tells it where to resume, and calls close() when the run ends. */
  session?: boolean;
  complete(req: CompleteRequest): Promise<Completion>;
  close?(): void;
}
export interface CompleteRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  cwd?: string;                                  // session brains: where the CLI runs
  resume?: { ref?: string; preface: string };    // session brains, first step: its own session id + turns it missed
  onEvent?(e: AgentEvent): void;                 // session brains: resume refs, rate limits, their own built-in steps
  onDelta?(d: { text?: string; thinking?: string }): void; // live tokens, if the brain can stream
  signal?: AbortSignal;                          // the run was stopped
}
export interface Completion {
  text: string;
  toolCalls: ToolCall[];
  usage?: { input: number; output: number; cached?: number; cost?: number; ms?: number };
  context?: { used: number; window?: number; model?: string }; // when the brain knows better than input + output
  reasoning?: string;                                           // its visible thinking for this step, if any
}
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

// ── Agents: config/agents/<handle>.md — team members with a name and a job ──
export interface AgentConfig {
  name: string;           // the handle: file name, used in @mentions and everywhere in code ("researcher")
  displayName: string;    // what people call it ("Mira")
  title: string;          // job title ("Researcher")
  emoji: string;          // avatar
  description: string;    // the job description: what it does, shown to you and to other agents looking for help
  skills: string[];       // keywords other agents (and team_find) match work against
  privateAccess: boolean; // may read private memories/documents even on a cloud brain (the owner's grant)
  brain: string;          // key in settings.yaml → brains
  fallback?: string;      // optional second brain, used when `brain` can't take a turn (limit, logged out, down, silent)
  tools: string[];        // loaded from the start (globs ok: "todos_*")
  allow: string[];        // what tool_search may load later (globs). Default: ["*"]
  approval: string[];     // extra tools that need approval (globs)
  autoApprove: string[];  // side-effect tools this agent may run without asking (globs, e.g. "shell_run")
  maxSteps: number;       // tool calls per turn, los's and a runtime's own built-ins together
  maxMinutes: number;     // wall-clock limit per turn (time spent waiting for your approval doesn't count)
  workdir?: string;       // cwd for shell_*/files_* tools and CLI agents
  system: string;         // markdown body
}

// ── Events: everything that happens is appended here; UI and logs read it ──
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; id: string; name: string; ok: boolean; preview: string; output?: string } // output: a runtime's own tool, in full
  | { type: "tools_loaded"; names: string[] }
  | { type: "approval"; call: ToolCall; granted: boolean; bypass?: boolean } // bypass: ran without asking (chat/task bypass on)
  | { type: "error"; message: string }
  | { type: "runtime"; raw: unknown; brain?: string; ref?: string; agent?: string } // ref: the CLI's own session id (per brain + agent), for resuming
  | { type: "usage"; brain: string; input: number; output: number; cached?: number; cost?: number; ms?: number }
  | { type: "context"; brain: string; model?: string; used: number; window?: number } // context size after a turn
  | { type: "reasoning"; brain: string; text: string }                                 // a step's visible thinking
  // What one step sent, compactly: enough to rebuild the exact request (messages are append-only). system/preface only
  // when they changed since the previous step of the run. See GET /api/sessions/:id/context.
  | { type: "request"; brain: string; step: number; upto: number; after: number; budget: number; tools: string[]; session: boolean; system?: string; preface?: string }
  | { type: "compact"; brain: string; summary: string; upto: number; before?: number; auto?: boolean }; // messages ≤ upto → summary
