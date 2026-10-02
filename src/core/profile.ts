// The owner's profile (display name, from data/auth.json, set on the Profile page) and the variables any agent
// personality or system prompt can use, so no file has to hard-code who it's working for:
//   {{name}}      display name (e.g. "Toffe")      {{username}}  login name
//   {{date}}      today, e.g. "Friday 2 October 2026"   {{time}}  now, e.g. "08:15"
//   {{weekday}}   e.g. "Friday"                    {{timezone}}  e.g. "Europe/Oslo"
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.js";
import { tzOf } from "./time.js";

let cache: { path: string; mtime: number; data: { username?: string; displayName?: string } } | null = null;
function profile(app: App) {
  const path = join(app.settings.root, "data/auth.json");
  if (!existsSync(path)) return {};
  const mtime = statSync(path).mtimeMs;
  if (cache?.path !== path || cache.mtime !== mtime) {
    try { const a = JSON.parse(readFileSync(path, "utf8")); cache = { path, mtime, data: { username: a.username, displayName: a.displayName } }; }
    catch { return {}; }
  }
  return cache.data;
}
/** What agents call the owner: the display name, else the capitalised username, else "the user". */
export function ownerName(app: App) {
  const p = profile(app);
  return p.displayName || (p.username ? p.username[0].toUpperCase() + p.username.slice(1) : "the user");
}
export function variables(app: App, now = new Date()): Record<string, string> {
  const tz = tzOf(app.settings);
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...o }).format(now);
  return {
    name: ownerName(app), username: profile(app).username ?? "user",
    date: fmt({ weekday: "long", day: "numeric", month: "long", year: "numeric" }).replace(",", ""),
    time: fmt({ hour: "2-digit", minute: "2-digit", hour12: false }), weekday: fmt({ weekday: "long" }), timezone: tz,
  };
}
/** Fill {{variables}} in a text. Unknown ones are left as they are. */
export function fill(app: App, text: string, vars = variables(app)) {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k) => vars[k.toLowerCase()] ?? all);
}
