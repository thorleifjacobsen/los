// MCP servers from config/mcp.json become plugins: each server's tools get registered as
// "<server>_<tool>" and are found through tool_search like any native tool.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { McpServerConfig } from "../config.js";
import type { Plugin, Tool } from "../types.js";

/** Last connection attempt per server, for the web UI. */
export const mcpStatus = new Map<string, { ok: boolean; error?: string; tools: number }>();

const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "_");

export async function connectMcpServers(servers: Record<string, McpServerConfig>) {
  const out: { plugin: Plugin; close: () => Promise<void> }[] = [];
  mcpStatus.clear();
  for (const [name, cfg] of Object.entries(servers)) {
    try {
      const client = new Client({ name: "los", version: "0.1.0" });
      const transport = cfg.url
        ? new StreamableHTTPClientTransport(new URL(cfg.url))
        : new StdioClientTransport({
            command: cfg.command!, args: cfg.args ?? [],
            env: { ...(process.env as Record<string, string>), ...cfg.env },
          });
      await client.connect(transport);
      const { tools } = await client.listTools();
      const server = clean(name);
      mcpStatus.set(name, { ok: true, tools: tools.length });
      out.push({
        close: () => client.close(),
        plugin: {
          name: `mcp_${server}`,
          description: `MCP server "${name}"`,
          privacy: cfg.privacy ?? "public",
          tools: tools.map((t): Tool => ({
            name: `${server}_${clean(t.name)}`,
            description: t.description ?? t.name,
            schema: z.record(z.string(), z.unknown()),
            parameters: t.inputSchema as Record<string, unknown>,
            sideEffect: t.annotations?.readOnlyHint !== true, // unknown → ask first
            run: async (args) => {
              const res: any = await client.callTool({ name: t.name, arguments: args as Record<string, unknown> });
              const text = (res.content ?? [])
                .map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`))
                .join("\n");
              if (res.isError) throw new Error(text || "MCP tool error");
              return text;
            },
          })),
        },
      });
    } catch (e) {
      console.error(`mcp: could not start "${name}": ${(e as Error).message}`);
      mcpStatus.set(name, { ok: false, error: (e as Error).message, tools: 0 });
    }
  }
  return out;
}
