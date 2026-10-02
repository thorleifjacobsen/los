// Native Anthropic Messages API (better tool use + prompt caching than going through a proxy).
import { takeImages } from "../core/images.js";
import type { Brain, Message, ToolCall } from "../types.js";
import type { BrainConfig } from "../config.js";

export function anthropicBrain(id: string, cfg: BrainConfig): Brain {
  const keyName = cfg.api_key_env ?? "ANTHROPIC_API_KEY";
  const key = cfg.env?.[keyName] ?? process.env[keyName];
  if (!key) throw new Error(`brain ${id}: env ${cfg.api_key_env ?? "ANTHROPIC_API_KEY"} is not set`);
  const base = (cfg.base_url ?? "https://api.anthropic.com").replace(/\/$/, "");

  return {
    id,
    local: cfg.local ?? false,
    async complete({ system, messages, tools, onDelta, signal }) {
      const started = Date.now();
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST", signal,
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 16000,
          stream: !!onDelta,
          // Cache the stable prefix (system + tools) — big savings on long agent runs.
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
          messages: toAnthropic(messages),
        }),
      });
      if (!res.ok) throw new Error(`${id}: HTTP ${res.status} ${await res.text()}`);
      let content: any[], u: any;
      if (onDelta && (res.headers.get("content-type") ?? "").includes("event-stream")) {
        // SSE: content blocks start, grow by deltas (text, or tool input as JSON fragments), and stop.
        content = []; u = {};
        for await (const ev of sse(res)) {
          if (ev.type === "message_start") u = { ...ev.message.usage };
          else if (ev.type === "content_block_start") content[ev.index] = { ...ev.content_block, _json: "" };
          else if (ev.type === "content_block_delta") {
            const b = content[ev.index], d = ev.delta;
            if (d.type === "text_delta") { b.text += d.text; onDelta({ text: d.text }); }
            else if (d.type === "input_json_delta") b._json += d.partial_json;
          } else if (ev.type === "content_block_stop") {
            const b = content[ev.index];
            if (b.type === "tool_use") b.input = b._json ? JSON.parse(b._json) : {};
          } else if (ev.type === "message_delta" && ev.usage) Object.assign(u, ev.usage);
          else if (ev.type === "error") throw new Error(`${id}: ${ev.error?.message ?? "stream error"}`);
        }
      } else {
        const data: any = await res.json();
        content = data.content; u = data.usage;
      }
      const text = content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const toolCalls: ToolCall[] = content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
      return {
        text, toolCalls,
        usage: { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, ms: Date.now() - started },
      };
    },
  };
}

async function* sse(res: Response): AsyncGenerator<any> {
  const reader = res.body!.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith("data:")) try { yield JSON.parse(line.slice(5)); } catch { /* ignore */ }
    }
  }
}

// Anthropic wants tool results as user messages, consecutive ones merged into one.
function toAnthropic(messages: Message[]) {
  const out: { role: "user" | "assistant"; content: any[] }[] = [];
  const push = (role: "user" | "assistant", block: any) => {
    const last = out.at(-1);
    if (last?.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", { type: "text", text: m.content });
    else if (m.role === "tool") {
      const { text, images } = takeImages(m.content); // image_view: the picture goes in the tool result
      push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: images.length
        ? [{ type: "text", text }, ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } }))]
        : m.content });
    }
    else {
      if (m.content) push("assistant", { type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) push("assistant", { type: "tool_use", id: c.id, name: c.name, input: c.args });
    }
  }
  return out;
}
