// Per-brain environment: secrets (data/brain-env.json, never in settings.yaml) and account/state dirs,
// so the same runtime can run as several accounts side by side (e.g. two Claude logins).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { BrainConfig, Settings } from "../config.js";

const envFile = (settings: Pick<Settings, "root">) => join(settings.root, "data/brain-env.json");

export function readBrainEnv(settings: Pick<Settings, "root">): Record<string, Record<string, string>> {
  const f = envFile(settings);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
}

export function writeBrainEnv(settings: Pick<Settings, "root">, brain: string, env: Record<string, string> | null) {
  const all = readBrainEnv(settings);
  if (env && Object.keys(env).length) all[brain] = env;
  else delete all[brain];
  mkdirSync(join(settings.root, "data"), { recursive: true });
  writeFileSync(envFile(settings), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
}

/** Where a runtime keeps its login and sessions. claude-code without `account` shares the host's ~/.claude. */
export function accountDir(settings: Pick<Settings, "root">, name: string, cfg: BrainConfig): string | null {
  if (!["claude-code", "codex", "opencode"].includes(cfg.type)) return null;
  if (cfg.type === "claude-code" && !cfg.account) return null;
  return resolve(settings.root, "data/accounts", cfg.account || name);
}

/** Env vars that point a runtime at its account dir. */
export function accountEnv(settings: Pick<Settings, "root">, name: string, cfg: BrainConfig): Record<string, string> {
  const dir = accountDir(settings, name, cfg);
  if (!dir) return {};
  mkdirSync(dir, { recursive: true });
  switch (cfg.type) {
    case "claude-code": return { CLAUDE_CONFIG_DIR: dir };
    case "codex": return { CODEX_HOME: dir };
    case "opencode": return { XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state") };
    default: return {};
  }
}

/** The claude config dir a claude-code brain uses (its own account, or the host login). */
export const claudeDir = (settings: Pick<Settings, "root">, name: string, cfg: BrainConfig) =>
  accountDir(settings, name, cfg) ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

/** Full env for spawning a runtime brain's CLI. */
export function runtimeEnv(settings: Pick<Settings, "root">, name: string, cfg: BrainConfig): NodeJS.ProcessEnv {
  return { ...process.env, ...accountEnv(settings, name, cfg), ...(cfg.env ?? {}) };
}
