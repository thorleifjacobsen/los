import { readFileSync, readdirSync, existsSync, cpSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "yaml";
import type { AgentConfig } from "./types.js";

export type BrainType = "openai" | "anthropic" | "claude-code" | "codex" | "opencode" | "cli";
export type BrainConfig = {
  type: BrainType;
  label?: string;          // display name in the UI
  model?: string;
  base_url?: string;
  api_key_env?: string;    // name of the env var holding the key (process env or this brain's env)
  local?: boolean;
  context_window?: number; // model brains: tokens, for the context meter (runtimes report their own)
  stall_minutes?: number;  // CLI brains: give up after this long with no sign of life (default 5)
  args?: string[];
  command?: string;        // type cli: the executable; args may contain {prompt}
  account?: string;        // runtimes: own login/state dir under data/accounts/<account>. claude-code without it = host login
  env?: Record<string, string>; // filled at runtime from data/brain-env.json — never written to settings.yaml
};
export type SourceConfig = { id: string; type: "files" | "imap"; private?: boolean; [k: string]: any }; // private: default for its documents

export interface Settings {
  root: string;
  db: string;
  default_agent: string;
  brains: Record<string, BrainConfig>;
  embeddings?: { brain: string; model: string; dim: number };
  ingest?: { brain: string; enrich: boolean };
  sources: SourceConfig[];
  privacy: {
    local_only: string[];              // whole tools a cloud brain may never use (globs)
    memory_default?: "public" | "private"; // privacy of a new memory when the agent doesn't say (default public)
  };
  routing: { match: string; agent: string }[];
  // browser_url: a Chrome DevTools endpoint for JS pages. files_url: a separate address (e.g. https://los-files.example)
  // that serves workspace pages on their own origin, so they get localStorage etc.; unset → served sandboxed from los.
  // allow_internal: hosts agents may fetch even though they're internal (a NAS on your network, say). Default: none.
  web?: { searxng_url?: string; browser_url?: string; files_url?: string; allow_internal?: string[] };
  timezone?: string;                                  // the owner's, for "now", schedules and run_at (default Europe/Oslo)
  worker?: { concurrency?: number };                  // background tasks running at once (default 3)
  chat?: { auto_compact?: number; max_context_tokens?: number }; // auto_compact: when the context is this full (0-1, default 0.8; 0 = off). max_context_tokens: size budget of one request (default: 60% of the brain's context_window, else 100k)
  agents: Record<string, AgentConfig>;
  mcp: Record<string, McpServerConfig>;
}
export type McpServerConfig = {
  command?: string; args?: string[]; env?: Record<string, string>; url?: string;
  privacy?: "public" | "local-only";
};

/**
 * config/ belongs to the installation (brains, agents, MCP servers: edited from the UI), not to the code, so it isn't
 * in git. A fresh install starts from the shipped defaults in config.example/: whatever is missing is copied over
 * (settings.yaml, mcp.json, and the agents when there are none). Nothing that exists is ever overwritten.
 */
export function seedConfig(root: string) {
  const from = join(root, "config.example"), to = join(root, "config");
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const f of ["settings.yaml", "mcp.json"]) if (!existsSync(join(to, f))) cpSync(join(from, f), join(to, f));
  const agents = join(to, "agents");
  if (!existsSync(agents) || !readdirSync(agents).some((f) => f.endsWith(".md"))) cpSync(join(from, "agents"), agents, { recursive: true });
}

export function loadSettings(root = process.env.LOS_ROOT ?? process.cwd()): Settings {
  seedConfig(root);
  const raw = parse(readFileSync(join(root, "config/settings.yaml"), "utf8"));
  const mcpPath = join(root, "config/mcp.json");
  return {
    sources: [], routing: [], privacy: { local_only: [] },
    ...raw,
    root,
    db: resolve(root, raw.db ?? "data/los.db"),
    agents: loadAgents(join(root, "config/agents")),
    mcp: existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, "utf8")).servers ?? {} : {},
  };
}

/**
 * config/agents/<name>.md: an agent is a name, a personality and a brain. The file name is the name (`mira.md` →
 * Mira, @mira); the frontmatter says which `brain` it uses (and optionally an `emoji` avatar); the text is its
 * personality: who it is, what it's good at, how it talks. The first sentence doubles as its one-line description.
 * Every agent can use every tool (side effects ask you first). A few expert knobs are still read if present
 * (max_steps, max_minutes, auto_approve, workdir, private_access, tools), but nothing needs them.
 */
export function loadAgents(dir: string): Record<string, AgentConfig> {
  const agents: Record<string, AgentConfig> = {};
  if (!existsSync(dir)) return agents;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(dir, file), "utf8");
    const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) throw new Error(`${file}: missing frontmatter`);
    const fm = parse(m[1]) ?? {};
    const name = file.replace(/\.md$/, "");
    const personality = m[2].trim();
    const intro = personality.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
    const first = /^(.{1,120}?[.!?])(\s|$)/.exec(intro)?.[1] ?? intro.slice(0, 120);
    agents[name] = {
      name,
      displayName: fm.name ?? name[0].toUpperCase() + name.slice(1),
      title: first,
      emoji: fm.emoji ?? "",
      description: intro,
      skills: [],
      privateAccess: !!fm.private_access,
      brain: fm.brain,
      fallback: fm.fallback || undefined,
      tools: fm.tools ?? ["*"],
      allow: ["*"],
      approval: fm.approval ?? [],
      autoApprove: fm.auto_approve ?? [],
      maxSteps: fm.max_steps ?? 40,
      maxMinutes: fm.max_minutes ?? 20,
      workdir: fm.workdir?.replace(/^~(?=\/|$)/, homedir()),
      system: personality,
    };
  }
  return agents;
}

/** "todos_*" style matching, used for tool lists, allow-lists and privacy. */
export const glob = (pattern: string, name: string) =>
  new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(name);
export const matchesAny = (patterns: string[], name: string) => patterns.some((p) => glob(p, name));

/** An agent file from the Team page's fields: brain, emoji, personality (expert knobs kept if the file had them). */
export function agentMarkdown(a: Partial<AgentConfig> & { name?: string }, extra: Record<string, unknown> = {}) {
  const fm: Record<string, unknown> = {
    name: a.displayName || undefined, brain: a.brain, fallback: a.fallback || undefined, emoji: a.emoji || undefined,
    max_steps: a.maxSteps && a.maxSteps !== 40 ? a.maxSteps : undefined,
    max_minutes: a.maxMinutes && a.maxMinutes !== 20 ? a.maxMinutes : undefined,
    auto_approve: a.autoApprove?.length ? a.autoApprove : undefined,
    private_access: a.privateAccess || undefined, workdir: a.workdir || undefined, ...extra,
  };
  for (const k of Object.keys(fm)) if (fm[k] === undefined || fm[k] === "") delete fm[k];
  return `---\n${stringify(fm, { lineWidth: 0 }).trim()}\n---\n${(a.system ?? "").trim()}\n`;
}
