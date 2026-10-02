// The brain manager behind the web UI: add/edit/remove brains, check their logins, read their plan usage,
// and run a runtime's login flow (Claude: URL + pasted code, Codex: device code) from the browser.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { App } from "../app.js";
import type { BrainConfig, BrainType } from "../config.js";
import { readBrainEnv, writeBrainEnv, accountDir, accountEnv, claudeDir } from "./env.js";
import { run } from "./cli.js";

export const BRAIN_TYPES: Record<BrainType, { label: string; runtime: boolean; login: boolean; limits: boolean }> = {
  "claude-code": { label: "Claude Code", runtime: true, login: true, limits: true },
  codex: { label: "Codex", runtime: true, login: true, limits: true },
  opencode: { label: "opencode", runtime: true, login: false, limits: false },
  cli: { label: "Generic CLI", runtime: true, login: false, limits: false },
  anthropic: { label: "Anthropic API", runtime: false, login: false, limits: false },
  openai: { label: "OpenAI-compatible API", runtime: false, login: false, limits: false },
};

export type BrainStatus = { ok: boolean; state: "ok" | "logged-out" | "missing" | "unknown"; detail: string; account?: string; plan?: string; checkedAt: string };
export type LimitWindow = { label: string; percent: number | null; resetsAt: string | null };
export type BrainLimits = { windows: LimitWindow[]; note?: string; checkedAt: string };

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const fullEnv = (app: App, name: string, cfg: BrainConfig): NodeJS.ProcessEnv =>
  ({ ...process.env, ...accountEnv(app.settings, name, cfg), ...(readBrainEnv(app.settings)[name] ?? {}) });

export function createBrainManager(app: App, notify: (kind: string, data?: Record<string, unknown>) => void) {
  const statusCache = new Map<string, BrainStatus>();
  const limitsCache = new Map<string, BrainLimits>();
  const logins = new Map<string, Login>();
  const cfgOf = (name: string) => {
    const cfg = app.settings.brains[name];
    if (!cfg) throw new Error(`unknown brain "${name}"`);
    return cfg;
  };

  // ── status: is it installed / logged in? ──
  async function status(name: string, force = false): Promise<BrainStatus> {
    const cached = statusCache.get(name);
    if (cached && !force && Date.now() - Date.parse(cached.checkedAt) < 5 * 60_000) return cached;
    const cfg = cfgOf(name), env = fullEnv(app, name, cfg);
    const s = (ok: boolean, state: BrainStatus["state"], detail: string, extra: Partial<BrainStatus> = {}): BrainStatus =>
      ({ ok, state, detail, ...extra, checkedAt: new Date().toISOString() });
    let result: BrainStatus;
    try {
      switch (cfg.type) {
        case "claude-code": {
          const { stdout } = await run("claude", ["auth", "status", "--json"], { env }).catch((e) => ({ stdout: e.message }));
          const j = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1) || "{}");
          result = j.loggedIn
            ? s(true, "ok", j.authMethod === "claude.ai" ? "Claude subscription" : j.authMethod ?? "logged in", { account: j.email, plan: j.subscriptionType })
            : s(false, "logged-out", "Not logged in");
          // The usage API is the real test of the token: a revoked login still looks "logged in" locally.
          if (result.ok) {
            const lim = await limits(name, true).catch(() => null);
            if (lim?.note?.startsWith("Login expired")) result = s(false, "logged-out", lim.note, { account: result.account });
          }
          break;
        }
        case "codex": {
          const out = await run("codex", ["login", "status"], { env }).then((r) => r.stdout + r.stderr).catch((e) => e.message);
          const text = strip(out).trim();
          result = /not logged in/i.test(text) ? s(false, "logged-out", "Not logged in")
            : /logged in/i.test(text) ? s(true, "ok", text.split("\n").at(-1)!) : s(false, "unknown", text.slice(0, 200));
          break;
        }
        case "opencode": {
          const out = await run("opencode", ["auth", "list"], { env }).then((r) => r.stdout).catch((e) => e.message);
          const creds = strip(out).split("\n").map((l) => l.replace(/[│●┌└┐┘─◇◆]/g, "").trim()).filter((l) => l && !/credentials|^\d+ /i.test(l));
          const n = (strip(out).match(/(\d+) credentials?/i) ?? [])[1];
          result = s(true, "ok", n && n !== "0" ? `${n} provider login(s)` : "Free models only, or API keys via env", { account: creds.slice(0, 3).join(", ") || undefined });
          break;
        }
        case "cli": {
          if (!cfg.command) { result = s(false, "missing", "No command set"); break; }
          const found = await run("sh", ["-c", `command -v ${JSON.stringify(cfg.command)}`], { env }).then(() => true).catch(() => false);
          result = found ? s(true, "ok", `${cfg.command} found`) : s(false, "missing", `${cfg.command} not found in the container`);
          break;
        }
        case "anthropic":
        case "openai": {
          const keyName = cfg.api_key_env ?? (cfg.type === "anthropic" ? "ANTHROPIC_API_KEY" : undefined);
          if (keyName && !env[keyName]) { result = s(false, "missing", `No ${keyName} set`); break; }
          if (cfg.type === "openai" && cfg.base_url) {
            const r = await fetch(`${cfg.base_url.replace(/\/$/, "")}/models`, {
              headers: keyName ? { authorization: `Bearer ${env[keyName]}` } : {}, signal: AbortSignal.timeout(4000),
            }).catch((e) => e as Error);
            result = r instanceof Error ? s(false, "missing", `Unreachable: ${cfg.base_url}`)
              : r.status === 401 ? s(false, "logged-out", "Key rejected (401)") : s(true, "ok", `Reachable (HTTP ${r.status})`);
          } else result = s(true, "ok", "API key set");
          break;
        }
        default: result = s(false, "unknown", "Unknown type");
      }
    } catch (e) {
      result = s(false, "unknown", (e as Error).message);
    }
    const before = statusCache.get(name);
    statusCache.set(name, result);
    if (before?.ok && !result.ok) notify("brain-auth", { brain: name, message: `${name}: ${result.detail}` });
    return result;
  }

  // ── plan limits: how much of the subscription is used ──
  async function limits(name: string, force = false): Promise<BrainLimits | null> {
    const cfg = cfgOf(name);
    if (!BRAIN_TYPES[cfg.type]?.limits) return null;
    const cached = limitsCache.get(name);
    if (cached && !force && Date.now() - Date.parse(cached.checkedAt) < 60_000) return cached;
    const at = new Date().toISOString();
    let out: BrainLimits;
    if (cfg.type === "claude-code") out = await claudeLimits(name, cfg, at);
    else out = codexLimits(name, cfg, at);
    limitsCache.set(name, out);
    return out;
  }

  async function claudeLimits(name: string, cfg: BrainConfig, at: string): Promise<BrainLimits> {
    const envToken = readBrainEnv(app.settings)[name]?.CLAUDE_CODE_OAUTH_TOKEN;
    const credFile = join(claudeDir(app.settings, name, cfg), ".credentials.json");
    let token = envToken, expiresAt = 0;
    if (!token && existsSync(credFile)) {
      const o = JSON.parse(readFileSync(credFile, "utf8")).claudeAiOauth ?? {};
      token = o.accessToken; expiresAt = o.expiresAt ?? 0;
    }
    if (!token) return { windows: [], note: "Not logged in", checkedAt: at };
    // Undocumented endpoint used by Claude Code's own /usage screen; may change.
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "user-agent": "los" },
      signal: AbortSignal.timeout(8000),
    }).catch((e) => e as Error);
    if (res instanceof Error) return { windows: [], note: `Usage API unreachable: ${res.message}`, checkedAt: at };
    if (res.status === 401) {
      // An expired access token is normal: Claude refreshes it on its next run. Only a fresh one that fails means logged out.
      return expiresAt && expiresAt < Date.now()
        ? { windows: [], note: "Access token expired; Claude refreshes it on the next run", checkedAt: at }
        : { windows: [], note: "Login expired or revoked: log in again", checkedAt: at };
    }
    if (!res.ok) return { windows: [], note: `Usage API: HTTP ${res.status}${envToken ? " (setup tokens can't read usage)" : ""}`, checkedAt: at };
    const j: any = await res.json();
    const w = (label: string, x: any): LimitWindow | null => x ? { label, percent: x.utilization ?? null, resetsAt: x.resets_at ?? null } : null;
    const windows = [
      w("5-hour session", j.five_hour), w("Weekly", j.seven_day),
      w("Weekly · Opus", j.seven_day_opus), w("Weekly · Sonnet", j.seven_day_sonnet),
    ].filter(Boolean) as LimitWindow[];
    if (j.extra_usage?.is_enabled && j.extra_usage.utilization != null)
      windows.push({ label: "Extra usage (monthly)", percent: j.extra_usage.utilization, resetsAt: null });
    return { windows, checkedAt: at };
  }

  // Codex writes its rate-limit snapshot into each session's rollout file; read the newest one.
  function codexLimits(name: string, cfg: BrainConfig, at: string): BrainLimits {
    const dir = accountDir(app.settings, name, cfg);
    const sessions = dir && join(dir, "sessions");
    if (!sessions || !existsSync(sessions)) return { windows: [], note: "No Codex runs yet: limits show after the first run", checkedAt: at };
    let newest: { path: string; mtime: number } | null = null;
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n), st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (n.endsWith(".jsonl") && (!newest || st.mtimeMs > newest.mtime)) newest = { path: p, mtime: st.mtimeMs };
      }
    };
    walk(sessions);
    if (!newest) return { windows: [], note: "No Codex runs yet", checkedAt: at };
    const lines = readFileSync((newest as { path: string }).path, "utf8").trim().split("\n").reverse();
    for (const line of lines) {
      if (!line.includes("rate_limits")) continue;
      try {
        const ev = JSON.parse(line);
        const rl = ev.payload?.rate_limits ?? ev.rate_limits;
        if (!rl) continue;
        const when = (x: any, ts: number) => x?.resets_at ? new Date(typeof x.resets_at === "number" ? x.resets_at * 1000 : x.resets_at).toISOString()
          : x?.resets_in_seconds != null ? new Date(ts + x.resets_in_seconds * 1000).toISOString() : null;
        const ts = Date.parse(ev.timestamp ?? "") || (newest as { mtime: number }).mtime;
        const label = (x: any, fallback: string) => x?.window_minutes ? (x.window_minutes <= 300 ? `${Math.round(x.window_minutes / 60)}-hour` : `${Math.round(x.window_minutes / 1440)}-day`) : fallback;
        return {
          windows: [rl.primary && { label: label(rl.primary, "Primary"), percent: rl.primary.used_percent ?? null, resetsAt: when(rl.primary, ts) },
            rl.secondary && { label: label(rl.secondary, "Secondary"), percent: rl.secondary.used_percent ?? null, resetsAt: when(rl.secondary, ts) }].filter(Boolean),
          note: `As of the last run, ${new Date(ts).toISOString().slice(0, 16).replace("T", " ")} UTC`, checkedAt: at,
        };
      } catch { /* keep looking */ }
    }
    return { windows: [], note: "No rate-limit data in Codex's logs yet", checkedAt: at };
  }

  // ── what los itself has recorded ──
  function stats() {
    const rows = app.db.prepare(`SELECT json_extract(data, '$.brain') AS brain,
        count(*) AS runs, sum(json_extract(data, '$.input')) AS input, sum(json_extract(data, '$.output')) AS output,
        sum(coalesce(json_extract(data, '$.cached'), 0)) AS cached, sum(coalesce(json_extract(data, '$.cost'), 0)) AS cost,
        sum(created_at >= datetime('now', '-1 day')) AS runs_24h,
        sum(CASE WHEN created_at >= datetime('now', '-1 day') THEN json_extract(data, '$.input') + json_extract(data, '$.output') ELSE 0 END) AS tokens_24h,
        sum(CASE WHEN created_at >= datetime('now', '-7 days') THEN coalesce(json_extract(data, '$.cost'), 0) ELSE 0 END) AS cost_7d,
        max(created_at) AS last_at
      FROM events WHERE type = 'usage' GROUP BY brain`).all() as any[];
    const daily = app.db.prepare(`SELECT json_extract(data, '$.brain') AS brain, date(created_at) AS day, count(*) AS runs,
        sum(json_extract(data, '$.input') + json_extract(data, '$.output')) AS tokens
      FROM events WHERE type = 'usage' AND created_at >= datetime('now', '-13 days') GROUP BY brain, day`).all() as any[];
    return Object.fromEntries(rows.map((r) => [r.brain, { ...r, daily: daily.filter((d) => d.brain === r.brain) }]));
  }

  // ── add / edit / remove ──
  function save(name: string, input: Partial<BrainConfig>, envPatch: Record<string, string | null> = {}, isNew = false) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error("brain names are lowercase letters, digits, - and _");
    if (isNew && app.settings.brains[name]) throw new Error(`a brain called "${name}" already exists`);
    if (!input.type || !BRAIN_TYPES[input.type]) throw new Error("pick a brain type");
    if (input.type === "cli" && !input.command) throw new Error("a generic CLI brain needs a command");
    if (input.type === "openai" && !input.base_url) throw new Error("an OpenAI-compatible brain needs a base URL");
    const cfg: Record<string, unknown> = {};
    for (const k of ["type", "label", "model", "base_url", "api_key_env", "command", "account"] as const)
      if (typeof input[k] === "string" && input[k]!.trim()) cfg[k] = input[k]!.trim();
    if (input.local) cfg.local = true;
    if (input.args?.length) cfg.args = input.args.filter((a) => a !== "");
    const file = join(app.settings.root, "config/settings.yaml");
    const doc = parseDocument(readFileSync(file, "utf8"));
    doc.setIn(["brains", name], doc.createNode(cfg));
    writeFileSync(file, doc.toString());
    // Env: null removes a key, a value sets it, keys not mentioned are kept.
    const env = { ...(readBrainEnv(app.settings)[name] ?? {}) };
    for (const [k, v] of Object.entries(envPatch)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`bad env var name "${k}"`);
      if (v === null) delete env[k]; else env[k] = v;
    }
    writeBrainEnv(app.settings, name, env);
    statusCache.delete(name); limitsCache.delete(name);
  }

  function remove(name: string) {
    cfgOf(name);
    const users = Object.values(app.settings.agents).filter((a) => a.brain === name).map((a) => a.name);
    if (users.length) throw new Error(`still used by ${users.join(", ")}; switch those agents to another brain first`);
    const file = join(app.settings.root, "config/settings.yaml");
    const doc = parseDocument(readFileSync(file, "utf8"));
    doc.deleteIn(["brains", name]);
    writeFileSync(file, doc.toString());
    writeBrainEnv(app.settings, name, null);
    statusCache.delete(name); limitsCache.delete(name);
  }

  // ── login flows, driven from the browser ──
  type Login = { brain: string; state: "starting" | "waiting" | "done" | "failed"; url?: string; code?: string; needsCode: boolean; output: string; proc: ChildProcess; startedAt: string };

  function startLogin(name: string, opts: { console?: boolean } = {}) {
    const cfg = cfgOf(name);
    const prev = logins.get(name);
    if (prev && (prev.state === "starting" || prev.state === "waiting")) prev.proc.kill();
    const env = { ...fullEnv(app, name, cfg), BROWSER: "none" };
    let proc: ChildProcess;
    if (cfg.type === "claude-code") proc = spawn("claude", ["auth", "login", ...(opts.console ? ["--console"] : [])], { env, stdio: ["pipe", "pipe", "pipe"] });
    else if (cfg.type === "codex") proc = spawn("codex", ["login", "--device-auth"], { env, stdio: ["pipe", "pipe", "pipe"] });
    else throw new Error(`${BRAIN_TYPES[cfg.type]?.label ?? cfg.type} brains log in with API keys: add them as env vars on the brain`);
    const login: Login = { brain: name, state: "starting", needsCode: cfg.type === "claude-code", output: "", proc, startedAt: new Date().toISOString() };
    logins.set(name, login);
    const onData = (d: Buffer) => {
      login.output = (login.output + strip(d.toString())).slice(-4000);
      const url = login.output.match(/https:\/\/\S+/g)?.find((u) => /oauth|authorize|device|auth\./.test(u));
      if (url && !login.url) login.url = url;
      if (cfg.type === "codex") login.code ??= login.output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/)?.[0];
      if (login.url && login.state === "starting") { login.state = "waiting"; notify("brain-login", { brain: name }); }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    const timer = setTimeout(() => proc.kill(), 15 * 60_000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      login.state = code === 0 ? "done" : "failed";
      statusCache.delete(name); limitsCache.delete(name);
      notify("brain-login", { brain: name, state: login.state });
      if (code === 0) status(name, true).then(() => notify("brains"));
    });
    proc.on("error", (e) => { login.state = "failed"; login.output += `\n${e.message}`; });
    return new Promise<ReturnType<typeof loginView>>((resolve) => {
      // Give the CLI a moment to print its URL, so the browser can open it straight away.
      const started = Date.now();
      const poll = setInterval(() => {
        if (login.state !== "starting" || Date.now() - started > 15_000) { clearInterval(poll); resolve(loginView(login)); }
      }, 200);
    });
  }

  function sendCode(name: string, code: string) {
    const login = logins.get(name);
    if (!login || login.state !== "waiting") throw new Error("no login in progress");
    login.proc.stdin!.write(code.trim() + "\n");
    return loginView(login);
  }

  function cancelLogin(name: string) {
    const login = logins.get(name);
    if (login && (login.state === "starting" || login.state === "waiting")) login.proc.kill();
    logins.delete(name);
  }

  async function logout(name: string) {
    const cfg = cfgOf(name);
    if (cfg.type === "claude-code" && !cfg.account) throw new Error("this brain uses the host's own Claude login; logging out here would log out the server too");
    const env = fullEnv(app, name, cfg);
    if (cfg.type === "claude-code") await run("claude", ["auth", "logout"], { env });
    else if (cfg.type === "codex") await run("codex", ["logout"], { env });
    else throw new Error("nothing to log out of: remove the API key env var instead");
    statusCache.delete(name); limitsCache.delete(name);
  }

  const loginView = (l?: Login) => l ? { state: l.state, url: l.url ?? null, code: l.code ?? null, needsCode: l.needsCode, output: l.output.slice(-1500), startedAt: l.startedAt } : null;

  // Check every brain at startup and every 15 minutes, so an expired login or a missing key shows up (in the
  // chat's brain picker too) before a chat fails on it. API brains are cheap: key present? server reachable?
  const checkAll = () => Promise.allSettled(Object.keys(app.settings.brains).map((name) => status(name, true)))
    .then(() => notify("brains"));
  setInterval(checkAll, 15 * 60_000).unref();
  setTimeout(checkAll, 3000).unref();

  return {
    status, limits, stats, save, remove, startLogin, sendCode, cancelLogin, logout,
    login: (name: string) => loginView(logins.get(name)),
    cachedStatus: () => Object.fromEntries(statusCache),
    envKeys: (name: string) => Object.entries(readBrainEnv(app.settings)[name] ?? {}).map(([k, v]) => ({ key: k, hint: v.length > 8 ? `…${v.slice(-4)}` : "••••" })),
    accountDir: (name: string) => accountDir(app.settings, name, cfgOf(name)),
  };
}
