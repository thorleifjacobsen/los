// The tool registry: every tool from every plugin and MCP server lives here.
// Agents never see all of it — they start with a few tools and pull in more via `tool_search`.
import { z } from "zod";
import type { Plugin, Tool, ToolSpec, AgentConfig } from "../types.js";
import { matchesAny } from "../config.js";
import { defineTool } from "./define.js";

type Entry = Tool & { plugin: string };

/** Core tools every agent has, whatever its tool lists say. */
const ALWAYS = ["tool_search", "result_read"];
const READ_CHARS = 40_000; // under the send-time cap, so a read isn't cut again

export class Registry {
  readonly tools = new Map<string, Entry>();
  readonly plugins = new Map<string, Plugin>();

  constructor(private localOnlyPatterns: string[] = []) {
    this.add({ name: "core", description: "Built-in tools", tools: [this.toolSearch(), this.resultRead()] });
  }

  add(plugin: Plugin) {
    this.plugins.set(plugin.name, plugin);
    for (const t of plugin.tools) {
      if (!/^[a-z0-9_]+$/.test(t.name)) throw new Error(`tool name "${t.name}" must match [a-z0-9_]+`);
      if (this.tools.has(t.name)) throw new Error(`duplicate tool "${t.name}"`);
      this.tools.set(t.name, { ...t, privacy: t.privacy ?? plugin.privacy ?? "public", plugin: plugin.name });
    }
  }

  remove(pluginName: string) {
    this.plugins.delete(pluginName);
    for (const [name, t] of this.tools) if (t.plugin === pluginName) this.tools.delete(name);
  }

  get(name: string) { return this.tools.get(name); }

  isLocalOnly(name: string) {
    const t = this.tools.get(name);
    return t?.privacy === "local-only" || matchesAny(this.localOnlyPatterns, name);
  }

  /** May this agent, on this brain, use this tool at all? */
  permitted(agent: AgentConfig, brainIsLocal: boolean, name: string) {
    if (ALWAYS.includes(name)) return true;
    if (!this.tools.has(name)) return false;
    if (!brainIsLocal && this.isLocalOnly(name)) return false;
    return matchesAny(agent.allow, name) || matchesAny(agent.tools, name);
  }

  needsApproval(agent: AgentConfig, name: string) {
    if (matchesAny(agent.approval, name)) return true;
    return !!this.tools.get(name)?.sideEffect && !matchesAny(agent.autoApprove, name);
  }

  /** The starting toolset for an agent: tool_search + whatever its `tools:` list matches. */
  initial(agent: AgentConfig, brainIsLocal: boolean): string[] {
    const names = [...this.tools.keys()].filter(
      (n) => matchesAny(agent.tools, n) && this.permitted(agent, brainIsLocal, n),
    );
    return [...ALWAYS, ...names.filter((n) => !ALWAYS.includes(n))];
  }

  spec(name: string): ToolSpec {
    const t = this.tools.get(name)!;
    if (t.parameters) return { name, description: t.description, parameters: t.parameters };
    const { $schema, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return { name, description: t.description, parameters };
  }

  /** Keyword ranking over name, tags, description and plugin. Good enough for a few hundred tools. */
  search(query: string, filter: (name: string) => boolean, limit = 6) {
    const words = query.toLowerCase().split(/[^a-z0-9æøå]+/).filter((w) => w.length > 1);
    const scored = [...this.tools.values()]
      .filter((t) => t.name !== "tool_search" && filter(t.name))
      .map((t) => {
        const fields = [
          [t.name.replace(/_/g, " "), 3], [t.plugin, 3], [(t.tags ?? []).join(" "), 2],
          [t.description.toLowerCase(), 1], [this.plugins.get(t.plugin)?.description.toLowerCase() ?? "", 1],
        ] as const;
        const score = words.reduce(
          (s, w) => s + fields.reduce((fs, [text, weight]) => fs + (text.includes(w) ? weight : 0), 0), 0);
        return { t, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.t);
  }

  /** Tool results are stored in full but sent cut (core/context.ts). This reads the rest, from this chat only. */
  private resultRead() {
    return defineTool({
      name: "result_read",
      description: "Read more of an earlier tool result in this conversation that was cut short (the cut note says the call_id and offset).",
      schema: z.object({
        call_id: z.string(),
        offset: z.number().int().min(0).optional().describe("Character to start at (default 0)"),
      }),
      run: async ({ call_id, offset = 0 }, { db, sessionId }) => {
        const r = db.prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'tool' AND tool_call_id = ? ORDER BY id DESC LIMIT 1")
          .get(sessionId, call_id) as { content: string } | undefined;
        if (!r) return "No tool result with that call_id in this conversation.";
        const part = r.content.slice(offset, offset + READ_CHARS);
        const end = offset + part.length;
        return end < r.content.length ? `${part}\n…[chars ${offset}-${end} of ${r.content.length}; continue with offset: ${end}]` : part || "(nothing after that offset)";
      },
    });
  }

  private toolSearch() {
    return defineTool({
      name: "tool_search",
      description:
        "Find and load more tools. You start with only a few; search by what you want to do " +
        "(e.g. 'add todo', 'read pdf', 'send mail'). Matching tools are loaded and callable on your next step.",
      schema: z.object({ query: z.string().describe("What you need a tool for") }),
      run: async ({ query }, ctx) => {
        const found = this.search(query, (n) => this.permitted(ctx.agent, ctx.brainIsLocal, n));
        if (!found.length) return "No matching tools. Try other words, or do it without a tool.";
        const loaded = ctx.activate(found.map((t) => t.name));
        return {
          note: "These tools are now available to call.",
          newly_loaded: loaded,
          tools: found.map((t) => ({ name: t.name, description: t.description })),
        };
      },
    });
  }
}
