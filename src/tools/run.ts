// Running one tool call. The only place a tool ever runs, called by the loop for every kind of brain.
import type { App } from "../app.js";
import type { AgentEvent, ToolCall, ToolContext } from "../types.js";
import { allowedIn, getSession, markPrivate } from "../core/session.js";

export interface CallOptions {
  visible: (name: string) => boolean;               // is this tool offered to the model right now?
  approve?: (call: ToolCall) => Promise<boolean>;   // missing → tools that need approval are denied
  emit: (e: AgentEvent) => void;
  notVisible?: string;                              // the error when the model calls a tool it doesn't have
}

export async function callTool(app: App, ctx: ToolContext, call: ToolCall, o: CallOptions) {
  o.emit({ type: "tool_call", call });
  const res = await execute(app, ctx, call, o);
  o.emit({ type: "tool_result", id: call.id, name: call.name, ok: res.ok, preview: res.content.slice(0, 200) });
  return res;
}

async function execute(app: App, ctx: ToolContext, call: ToolCall, o: CallOptions) {
  const { registry, db } = app;
  const fail = (content: string) => ({ ok: false, content });
  const tool = registry.get(call.name);
  if (!tool || !o.visible(call.name)) return fail(o.notVisible ?? `Tool "${call.name}" is not available.`);

  const args = tool.schema.safeParse(call.args);
  if (!args.success) return fail(`Invalid arguments: ${args.error.message}`);

  // "Allow for this chat" covers the rest of the chat. Bypass (a chat or task the user switched it on for, only from
  // the UI, never by an agent) covers every tool there; it's logged as an approval with `bypass`, so it's visible.
  if (registry.needsApproval(ctx.agent, call.name) && !allowedIn(db, ctx.sessionId).includes(call.name)) {
    if (getSession(db, ctx.sessionId)?.bypass) o.emit({ type: "approval", call, granted: true, bypass: true });
    else {
      const granted = o.approve ? await o.approve(call) : false;
      o.emit({ type: "approval", call, granted });
      if (!granted) return fail("The user did not approve this action.");
    }
  }

  try {
    const out = await tool.run(args.data, ctx);
    if (registry.isLocalOnly(call.name)) markPrivate(db, ctx.sessionId);
    const content = typeof out === "string" ? out : JSON.stringify(out, null, 1);
    // Stored in full. What a brain is sent is cut at send time (core/context.ts); it can read the rest with result_read.
    return { ok: true, content };
  } catch (e) {
    return fail(`Error: ${(e as Error).message}`);
  }
}
