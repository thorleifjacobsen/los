// What fits in one request. Tool results are stored in full; this only decides how much of the conversation a brain
// is sent, in three layers (a cut result says how to read the rest with result_read, so nothing is out of reach):
//   1. per message: the last FRESH messages keep tool output up to 50k chars, older ones 1.2k;
//   2. a ceiling of KEEP_MESSAGES messages;
//   3. a size budget (≈ tokens × 3.5 chars): over it, the oldest messages before the current turn are left out
//      (with a note), then this turn's older tool results are cut further. The current turn is never dropped.
// Above all this, auto-compaction (chat.auto_compact) replaces old history with a summary when a chat fills up, and
// earlier turns only ever come as words (no tool calls/results), see chatView().
import type { Message } from "../types.js";

const KEEP_MESSAGES = 60;
const FRESH = 8;
const FRESH_TOOL_CHARS = 50_000;
const OLD_TOOL_CHARS = 1200;
const SQUEEZED_TOOL_CHARS = 2000;
export const CHARS_PER_TOKEN = 3.5;

export function compact(history: Message[], budgetChars = Infinity): Message[] {
  let msgs = history.slice(-KEEP_MESSAGES);
  // Never start mid-exchange: first message must be a user message.
  const firstUser = msgs.findIndex((m) => m.role === "user");
  msgs = firstUser > 0 ? msgs.slice(firstUser) : msgs;
  const cut = msgs.length - FRESH;
  msgs = msgs.map((m, i) => (m.role === "tool" ? clip(m, i < cut ? OLD_TOOL_CHARS : FRESH_TOOL_CHARS) : m));
  if (size(msgs) <= budgetChars) return msgs;

  // Over budget: leave out whole older messages, oldest first, never this turn (from the last user message on).
  const turnStart = msgs.findLastIndex((m) => m.role === "user");
  let drop = 0;
  while (drop < turnStart && size(msgs.slice(drop)) > budgetChars) drop++;
  while (drop < turnStart && msgs[drop].role !== "user") drop++; // start at a user message again
  if (drop > 0) {
    msgs = [{ role: "user", content: `[${drop} earlier message(s) left out to keep this request small. Ask the user if you need something from before.]` }, ...msgs.slice(drop)];
  }
  // Still over: this turn's tool results, oldest first, down to a couple of thousand chars (the last one stays).
  const lastTool = msgs.findLastIndex((m) => m.role === "tool");
  for (let i = 0; i < msgs.length && size(msgs) > budgetChars; i++) {
    const m = msgs[i];
    if (m.role === "tool" && i !== lastTool) msgs[i] = clip(m, SQUEEZED_TOOL_CHARS);
  }
  return msgs;
}

const size = (msgs: Message[]) => msgs.reduce((n, m) => n + m.content.length + (m.role === "assistant" && m.toolCalls ? JSON.stringify(m.toolCalls).length : 0), 0);

function clip(m: Extract<Message, { role: "tool" }>, max: number): Message {
  if (m.content.length <= max) return m;
  return {
    ...m,
    content: m.content.slice(0, max) +
      `\n…[cut at ${max} of ${m.content.length} chars. Read on with result_read(call_id: "${m.toolCallId}", offset: ${max}) if you need it]`,
  };
}
