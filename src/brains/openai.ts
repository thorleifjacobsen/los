// One adapter for everything that speaks the OpenAI chat API: llama.cpp, Ollama, OpenRouter, OpenAI, vLLM, LM Studio.
// It's los's own protocol, so this is close to a pass-through. Streams (SSE) when the loop wants live tokens; a server
// that ignores `stream` and answers with plain JSON works too.
import { withoutImages } from "../core/images.js";
import type { Brain, Message, ToolCall, Completion } from "../types.js";
import type { BrainConfig } from "../config.js";

export function openaiBrain(id: string, cfg: BrainConfig): Brain {
  const base = (cfg.base_url ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const key = cfg.api_key_env ? cfg.env?.[cfg.api_key_env] ?? process.env[cfg.api_key_env] : undefined;
  if (cfg.api_key_env && !key) throw new Error(`brain ${id}: env ${cfg.api_key_env} is not set`);

  return {
    id,
    local: cfg.local ?? false,
    async complete({ system, messages, tools, onDelta, signal }) {
      const stream = !!onDelta;
      const body = {
        model: cfg.model,
        messages: [{ role: "system", content: system }, ...messages.map(toOpenAI)],
        ...(tools.length && { tools: tools.map((t) => ({ type: "function", function: t })) }),
        ...(stream && { stream: true, stream_options: { include_usage: true } }),
      };
      const started = Date.now();
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST", signal,
        headers: { "content-type": "application/json", ...(key && { authorization: `Bearer ${key}` }) },
        body: JSON.stringify(body),
      }).catch((e) => { throw signal?.aborted ? e : new Error(`brain "${id}" unreachable at ${base} (${e.cause?.code ?? e.message})`); });
      if (!res.ok) throw new Error(`${id}: HTTP ${res.status} ${await res.text()}`);

      if (!stream || !(res.headers.get("content-type") ?? "").includes("event-stream")) {
        const data: any = await res.json();
        const msg = data.choices[0].message;
        const { text, reasoning } = splitThinking(msg.content ?? "", msg.reasoning_content ?? msg.reasoning);
        return {
          text, reasoning,
          toolCalls: (msg.tool_calls ?? []).map((c: any) => ({ id: c.id ?? crypto.randomUUID(), name: c.function.name, args: parseArgs(c.function.arguments) })),
          usage: usageOf(data.usage, started),
        };
      }

      // SSE: text and reasoning arrive as deltas; tool calls arrive in pieces, keyed by index.
      let content = "", thinking = "", usage: Completion["usage"];
      const calls: { id?: string; name: string; args: string }[] = [];
      let inThink = false;
      for await (const data of sse(res)) {
        if (data.usage) usage = usageOf(data.usage, started);
        const d = data.choices?.[0]?.delta;
        if (!d) continue;
        const r = d.reasoning_content ?? d.reasoning;
        if (r) { thinking += r; onDelta!({ thinking: r }); }
        if (d.content) {
          content += d.content;
          // Models that inline <think>…</think> (qwen3, deepseek-r1): route it to thinking live.
          if (content.startsWith("<think>") && !content.includes("</think>")) { inThink = true; onDelta!({ thinking: d.content.replace("<think>", "") }); }
          else if (inThink) { inThink = false; const after = content.split("</think>")[1] ?? ""; if (after.trim()) onDelta!({ text: after.trimStart() }); }
          else onDelta!({ text: d.content });
        }
        for (const t of d.tool_calls ?? []) {
          const c = (calls[t.index ?? 0] ??= { name: "", args: "" });
          if (t.id) c.id = t.id;
          if (t.function?.name) c.name += t.function.name;
          if (t.function?.arguments) c.args += t.function.arguments;
        }
      }
      const { text, reasoning } = splitThinking(content, thinking || undefined);
      const toolCalls: ToolCall[] = calls.filter(Boolean).map((c) => ({ id: c.id ?? crypto.randomUUID(), name: c.name, args: parseArgs(c.args) }));
      return { text, toolCalls, usage, reasoning };
    },
  };
}

function usageOf(u: any, started: number): Completion["usage"] {
  if (!u) return undefined;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return { input: (u.prompt_tokens ?? 0) - cached, cached, output: u.completion_tokens ?? 0, cost: u.cost, ms: Date.now() - started };
}

/** Server-sent events → parsed `data:` JSON objects. */
async function* sse(res: Response): AsyncGenerator<any> {
  const reader = res.body!.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try { yield JSON.parse(payload); } catch { /* keep-alive or partial junk */ }
    }
  }
}

export function toOpenAI(m: Message) {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: withoutImages(m.content) }; // tool messages are text-only here
  if (m.role === "assistant" && m.toolCalls?.length)
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    };
  return { role: m.role, content: m.content };
}

const parseArgs = (a: unknown) => {
  if (typeof a !== "string") return (a ?? {}) as Record<string, unknown>; // Ollama sometimes sends objects
  try { return JSON.parse(a || "{}"); } catch { return {}; }
};
// Reasoning models (qwen3, deepseek-r1) may inline <think>…</think>; it goes to `reasoning`, not into history.
function splitThinking(content: string, reasoning?: string) {
  const inline = [...content.matchAll(/<think>([\s\S]*?)<\/think>/g)].map((m) => m[1].trim()).join("\n\n");
  return { text: content.replace(/<think>[\s\S]*?<\/think>\s*/g, ""), reasoning: [reasoning, inline].filter(Boolean).join("\n\n") || undefined };
}
