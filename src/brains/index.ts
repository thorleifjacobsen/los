import type { Brain } from "../types.js";
import type { Settings } from "../config.js";
import { openaiBrain } from "./openai.js";
import { anthropicBrain } from "./anthropic.js";
import { claudeCodeBrain, codexBrain, opencodeBrain, cliBrain } from "./cli.js";
import { readBrainEnv, accountEnv } from "./env.js";

const factories = {
  openai: openaiBrain,
  anthropic: anthropicBrain,
  "claude-code": claudeCodeBrain,
  codex: codexBrain,
  opencode: opencodeBrain,
  cli: cliBrain,
};

/** Look up a brain by its name in settings.yaml. Tests can register fakes via `brainOverrides`. */
export const brainOverrides = new Map<string, Brain>();

export function getBrain(settings: Settings, name: string): Brain {
  const fake = brainOverrides.get(name);
  if (fake) return fake;
  const cfg = settings.brains[name];
  if (!cfg) throw new Error(`unknown brain "${name}" (settings.yaml → brains)`);
  const make = factories[cfg.type];
  if (!make) throw new Error(`brain "${name}": unknown type "${cfg.type}"`);
  // The brain's own env: its account dir + its secrets from data/brain-env.json.
  const env = { ...accountEnv(settings, name, cfg), ...(readBrainEnv(settings)[name] ?? {}) };
  return make(name, { ...cfg, env });
}
