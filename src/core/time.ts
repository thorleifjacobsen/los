// Time in the owner's timezone (settings.timezone, default Europe/Oslo): what agents are told "now" is, how a
// local time like "2026-10-02 10:00" becomes UTC, and when a job's schedule fires next.
// Schedules: 5-field cron ("0 10 * * *", "*/15 8-17 * * 1-5"), or "every 30m" / "every 2h" / "every 1d".
import type { Settings } from "../config.js";

export const tzOf = (s: Settings) => s.timezone || "Europe/Oslo";

/** "Thursday 1 October 2026, 14:05 (Europe/Oslo, UTC+02:00)" */
export function localNow(s: Settings, d = new Date()) {
  const tz = tzOf(s);
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${when} (${tz}, UTC${offsetLabel(tz, d)})`;
}

/** Wall-clock parts of `d` in `tz`. */
function parts(tz: string, d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
const offsetMin = (tz: string, d: Date) => {
  const p = parts(tz, d);
  return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(d.getTime() / 60_000) * 60_000) / 60_000);
};
const offsetLabel = (tz: string, d: Date) => { const m = offsetMin(tz, d); return `${m < 0 ? "-" : "+"}${String(Math.floor(Math.abs(m) / 60)).padStart(2, "0")}:${String(Math.abs(m) % 60).padStart(2, "0")}`; };

/** A wall-clock time in `tz` → the UTC instant (DST-safe: re-checks the offset at the result). */
export function zonedToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetMin(tz, new Date(guess)) * 60_000;
  t = guess - offsetMin(tz, new Date(t)) * 60_000;
  return new Date(t);
}

/** SQLite's UTC format: "YYYY-MM-DD HH:MM:SS". */
export const sqlUtc = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

/** "2026-10-02 10:00" (owner's local time), or ISO with a Z/offset → SQLite UTC. Throws on nonsense. */
export function parseWhen(s: Settings, when: string): string {
  const w = when.trim();
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(w)) {
    const d = new Date(w);
    if (isNaN(+d)) throw new Error(`can't read time "${when}"`);
    return sqlUtc(d);
  }
  const m = w.match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)/);
  if (!m) throw new Error(`can't read time "${when}": use "YYYY-MM-DD HH:MM" in ${tzOf(s)}`);
  return sqlUtc(zonedToUtc(tzOf(s), +m[1], +m[2], +m[3], +m[4], +m[5]));
}

/** Show a SQLite UTC time in the owner's timezone. */
export function fmtLocal(s: Settings, utc: string | null) {
  if (!utc) return null;
  const d = new Date(utc.replace(" ", "T") + "Z");
  return new Intl.DateTimeFormat("en-GB", { timeZone: tzOf(s), weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

// ── schedules ──
type Cron = { mi: Set<number>; h: Set<number>; d: Set<number>; mo: Set<number>; dow: Set<number>; anyD: boolean; anyDow: boolean };
const NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function field(spec: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.toLowerCase().split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS ? +stepS : 1;
    const num = (x: string) => (x in NAMES ? NAMES[x] : +x);
    let [a, b] = range === "*" ? [lo, hi] : range.includes("-") ? range.split("-").map(num) : [num(range), stepS ? hi : num(range)];
    if (![a, b, step].every(Number.isInteger) || a < lo || b > hi || a > b || step < 1) throw new Error(`bad cron field "${spec}"`);
    for (let i = a; i <= b; i += step) out.add(i);
  }
  return out;
}
function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron needs 5 fields (min hour day month weekday), got "${expr}"`);
  const dow = field(f[4], 0, 7);
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return { mi: field(f[0], 0, 59), h: field(f[1], 0, 23), d: field(f[2], 1, 31), mo: field(f[3], 1, 12), dow, anyD: f[2] === "*", anyDow: f[4] === "*" };
}
const EVERY = /^every\s+(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/i;

/** Throws if the schedule can't be read; returns a short description. */
export function checkSchedule(schedule: string) {
  const e = schedule.trim().match(EVERY);
  if (e) {
    if (+e[1] < 1) throw new Error("interval must be at least 1");
    return schedule.trim();
  }
  parseCron(schedule);
  return schedule.trim();
}

/** The next time `schedule` fires strictly after `after`, in the owner's timezone. */
export function nextRun(s: Settings, schedule: string, after = new Date()): Date {
  const e = schedule.trim().match(EVERY);
  if (e) {
    const unit = e[2][0].toLowerCase() === "m" ? 60_000 : e[2][0].toLowerCase() === "h" ? 3_600_000 : 86_400_000;
    return new Date(after.getTime() + +e[1] * unit);
  }
  const c = parseCron(schedule), tz = tzOf(s);
  const start = parts(tz, new Date(after.getTime() + 60_000));
  // Walk day by day (in local dates), then hours and minutes that match. Cron's rule: if both day-of-month and
  // weekday are restricted, either one matching is enough.
  for (let day = 0; day < 370; day++) {
    const noon = zonedToUtc(tz, start.y, start.mo, start.d + day, 12, 0);
    const p = parts(tz, noon);
    const dayOk = c.anyD && c.anyDow ? true : c.anyD ? c.dow.has(p.dow) : c.anyDow ? c.d.has(p.d) : c.d.has(p.d) || c.dow.has(p.dow);
    if (!c.mo.has(p.mo) || !dayOk) continue;
    for (const h of [...c.h].sort((a, b) => a - b)) for (const mi of [...c.mi].sort((a, b) => a - b)) {
      const t = zonedToUtc(tz, p.y, p.mo, p.d, h, mi);
      const back = parts(tz, t);
      if (back.h !== h || back.mi !== mi) continue; // a time skipped by DST
      if (t.getTime() > after.getTime()) return t;
    }
  }
  throw new Error(`schedule "${schedule}" never fires`);
}
