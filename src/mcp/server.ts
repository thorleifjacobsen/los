// A per-run MCP endpoint for CLI agents (Claude Code, Codex, opencode). It only carries calls: each tools/call is
// handed to `onCall`, and the HTTP request stays open until los has run the tool and answered. Lives in this
// process on 127.0.0.1 (random port), one secret URL per run.
import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolSpec } from "../types.js";

export type CallResult = { content: string; isError?: boolean; images?: { data: string; mime: string }[] };
export type OnCall = (name: string, args: Record<string, unknown>) => Promise<CallResult>;
type Endpoint = { tools: ToolSpec[]; onCall: OnCall };
const endpoints = new Map<string, Endpoint>();
let http: Promise<{ server: HttpServer; port: number }> | null = null;

export async function openEndpoint(tools: ToolSpec[], onCall: OnCall) {
  const { port } = await (http ??= listen());
  const token = randomBytes(24).toString("base64url");
  endpoints.set(token, { tools, onCall });
  return { url: `http://127.0.0.1:${port}/mcp/${token}`, close: () => void endpoints.delete(token) };
}

function listen() {
  return new Promise<{ server: HttpServer; port: number }>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const ep = endpoints.get(req.url?.match(/^\/mcp\/([\w-]+)$/)?.[1] ?? "");
      if (!ep) return void res.writeHead(404).end();
      if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end(); // stateless: no SSE stream
      // Stateless mode: a fresh MCP server + transport per request, bound to this endpoint.
      const mcp = mcpServer(ep);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close(); mcp.close(); });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } catch (e) {
        if (!res.headersSent) res.writeHead(500).end((e as Error).message);
      }
    });
    server.requestTimeout = 0; // a call can wait a long time for an approval
    server.unref();            // never keeps a CLI process alive on its own
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

function mcpServer({ tools, onCall }: Endpoint) {
  const server = new Server({ name: "los", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object", ...t.parameters } as any })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const res = await onCall(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
    // Images (image_view) go along as real image content, which Claude Code shows the model.
    return { content: [{ type: "text" as const, text: res.content },
      ...(res.images ?? []).map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mime }))], isError: !!res.isError };
  });
  return server;
}
