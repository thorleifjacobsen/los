// What's running right now and what's waiting for you, shared by chats (web server) and background tasks (worker).
// In memory: a restart ends every run (tasks are marked interrupted at startup).
import type { ToolCall } from "../types.js";
import { bus } from "./events.js";

const notify = (kind: string, data: Record<string, unknown> = {}) => bus.emit("ui", { kind, ...data });

// ── approvals ──
export type Approval = { id: string; sessionId: string; taskId?: number; agent?: string; call: ToolCall; createdAt: string };
const pending = new Map<string, Approval & { settle: (ok: boolean) => void }>();

export const approvals = {
  /** Ask the user. Resolves false on timeout or when `signal` aborts (the run was stopped). */
  request(a: { sessionId: string; taskId?: number; agent?: string; call: ToolCall; timeoutMs: number; signal?: AbortSignal }): Promise<boolean> {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const settle = (ok: boolean) => {
        clearTimeout(timer);
        a.signal?.removeEventListener("abort", onAbort);
        if (!pending.delete(id)) return;
        notify("approvals", { sessionId: a.sessionId, taskId: a.taskId });
        resolve(ok);
      };
      const onAbort = () => settle(false);
      const timer = setTimeout(() => settle(false), a.timeoutMs);
      a.signal?.addEventListener("abort", onAbort);
      pending.set(id, { id, sessionId: a.sessionId, taskId: a.taskId, agent: a.agent, call: a.call, createdAt: new Date().toISOString(), settle });
      notify("approvals", { sessionId: a.sessionId, taskId: a.taskId, waiting: true });
    });
  },
  answer(id: string, ok: boolean) {
    const a = pending.get(id);
    if (!a) return false;
    a.settle(ok);
    return true;
  },
  list: (filter: { sessionId?: string; taskId?: number } = {}) => [...pending.values()]
    .filter((a) => (!filter.sessionId || a.sessionId === filter.sessionId) && (filter.taskId === undefined || a.taskId === filter.taskId))
    .map(({ settle, ...a }) => a),
  get size() { return pending.size; },
};

// ── runs: every chat turn and task that's executing, so it can be stopped ──
export type RunInfo = { key: string; kind: "chat" | "task" | "compact"; sessionId?: string; taskId?: number; agent?: string; title: string; startedAt: string };
const active = new Map<string, RunInfo & { ctl: AbortController }>();

export const runs = {
  start(info: Omit<RunInfo, "startedAt">) {
    if (active.has(info.key)) throw new Error("already running");
    const ctl = new AbortController();
    active.set(info.key, { ...info, startedAt: new Date().toISOString(), ctl });
    return ctl.signal;
  },
  end(key: string) { active.delete(key); },
  stop(key: string, reason = "Stopped by you.") {
    const r = active.get(key);
    if (!r) return false;
    r.ctl.abort(new Error(reason));
    return true;
  },
  get: (key: string) => { const r = active.get(key); return r && (({ ctl, ...x }) => x)(r); },
  has: (key: string) => active.has(key),
  list: () => [...active.values()].map(({ ctl, ...r }) => r),
};
