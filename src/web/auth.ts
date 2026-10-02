// Login for the web UI: one user, scrypt-hashed password in data/auth.json, stateless HMAC-signed session cookie.
// Optional second factor: TOTP (an authenticator app, RFC 6238) with one-time recovery codes. Set or reset the password
// with `npm run password -- <username>` (that also turns 2FA off: it's the way back in if the phone is lost).
// data/auth.json also holds the profile (display name), read by the system prompts as {{name}} (core/profile.ts).
import { scryptSync, randomBytes, createHmac, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

export type AuthFile = {
  username: string; hash: string; secret: string;
  displayName?: string;
  totp?: { secret: string; enabled: boolean };   // base32
  recovery?: string[];                            // sha256 of unused recovery codes
};

const COOKIE = "los_session";
const LONG = 30 * 24 * 3600;   // "remember me": 30 days
const SHORT = 12 * 3600;       // otherwise: a browser-session cookie that also expires after 12h
const PENDING = 5 * 60;        // seconds to enter the 2FA code after the password

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password: string, stored: string) {
  const [, salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  const got = scryptSync(password, Buffer.from(salt, "hex"), want.length);
  return timingSafeEqual(want, got);
}

/** The server-side reset (npm run password): new password, new secret (everyone is logged out), 2FA off. */
export function writeAuthFile(path: string, username: string, password: string) {
  let keep: Partial<AuthFile> = {};
  try { const old = JSON.parse(readFileSync(path, "utf8")) as AuthFile; keep = { displayName: old.displayName }; } catch { /* first time */ }
  const auth: AuthFile = { username, hash: hashPassword(password), secret: randomBytes(32).toString("hex"), ...keep };
  writeFileSync(path, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
}

// ── TOTP (RFC 6238: HMAC-SHA1, 30 s steps, 6 digits), as authenticator apps expect ──
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const base32 = (buf: Buffer) => { let bits = "", out = ""; for (const b of buf) bits += b.toString(2).padStart(8, "0"); for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]; return out; };
const unbase32 = (s: string) => { let bits = ""; for (const c of s.replace(/=+$/, "").toUpperCase()) { const v = B32.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, "0"); } const out: number[] = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
export function totpCode(secret: string, step = Math.floor(Date.now() / 30_000)) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, "0");
}
/** A code from now ±1 step (clock drift). */
export function totpOk(secret: string, code: string) {
  const c = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  const now = Math.floor(Date.now() / 30_000);
  return [-1, 0, 1].some((d) => timingSafeEqual(Buffer.from(totpCode(secret, now + d)), Buffer.from(c)));
}
const sha = (s: string) => createHash("sha256").update(s.replace(/[\s-]+/g, "").toLowerCase()).digest("hex");

export function createAuth(path: string) {
  let cache: { mtime: number; auth: AuthFile } | null = null;
  const load = (): AuthFile | null => {
    if (!existsSync(path)) return null;
    const mtime = statSync(path).mtimeMs;
    if (cache?.mtime !== mtime) cache = { mtime, auth: JSON.parse(readFileSync(path, "utf8")) };
    return cache.auth;
  };
  const save = (auth: AuthFile) => { writeFileSync(path, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 }); cache = null; };

  const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");

  // Failed logins: per client IP, and for the whole account. The IP comes from Cloudflare/Caddy headers, which someone
  // reaching the server directly could fake, so the account-wide cap is what really bounds guessing.
  const failures = new Map<string, { n: number; until: number }>();
  let overall = { n: 0, until: 0 };
  const PER_IP = 8, OVERALL = 40, WINDOW = 15 * 60_000;
  const clientIp = (req: IncomingMessage) =>
    String(req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
  const blocked = (req: IncomingMessage) => {
    const f = failures.get(clientIp(req));
    return (f && f.n >= PER_IP && f.until > Date.now()) || (overall.n >= OVERALL && overall.until > Date.now());
  };
  const fail = (req: IncomingMessage) => {
    const now = Date.now(), ip = clientIp(req), f = failures.get(ip);
    if (failures.size > 5000) for (const [k, v] of failures) if (v.until < now) failures.delete(k);
    failures.set(ip, { n: f && f.until > now ? f.n + 1 : 1, until: now + WINDOW });
    overall = { n: overall.until > now ? overall.n + 1 : 1, until: now + WINDOW };
  };
  const setSession = (res: ServerResponse, auth: AuthFile, remember: boolean) => {
    const exp = Math.floor(Date.now() / 1000) + (remember ? LONG : SHORT);
    const user = Buffer.from(auth.username).toString("base64url");
    const value = `${user}.${exp}.${sign(auth.secret, `${user}.${exp}`)}`;
    res.setHeader("set-cookie", `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax${remember ? `; Max-Age=${LONG}` : ""}`);
  };
  const pendingToken = (auth: AuthFile, remember: boolean) => {
    const exp = (Math.floor(Date.now() / 1000) + PENDING).toString(36), r = remember ? "1" : "0";
    return `${exp}.${r}.${sign(auth.secret, `2fa:${exp}:${r}`)}`;
  };

  return {
    configured: () => !!load(),
    username: () => load()?.username ?? "you",
    /** What to call the owner: the profile's display name, else the username. */
    displayName: () => { const a = load(); return a?.displayName || (a ? a.username[0].toUpperCase() + a.username.slice(1) : "you"); },
    twoFactor: () => !!load()?.totp?.enabled,

    /** Is this request logged in? */
    check(req: IncomingMessage): boolean {
      const auth = load();
      if (!auth) return false;
      const raw = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
      if (!raw) return false;
      const [user, exp, sig] = decodeURIComponent(raw).split(".");
      if (!user || !exp || !sig || Number(exp) < Date.now() / 1000) return false;
      const want = Buffer.from(sign(auth.secret, `${user}.${exp}`));
      const got = Buffer.from(sig);
      return want.length === got.length && timingSafeEqual(want, got) && user === Buffer.from(auth.username).toString("base64url");
    },

    /**
     * Step 1: username + password. Without 2FA it sets the session; with 2FA it returns a short-lived token for step 2.
     * Returns { error } | { pending } | {}.
     */
    login(req: IncomingMessage, res: ServerResponse, username: string, password: string, remember: boolean): { error?: string; pending?: string } {
      const auth = load();
      if (!auth) return { error: "No password is set yet. Run `npm run password` on the server." };
      if (blocked(req)) return { error: "Too many attempts. Try again in a few minutes." };
      const userOk = username.trim().toLowerCase() === auth.username.toLowerCase();
      const passOk = verifyPassword(password, auth.hash); // always run, so timing doesn't reveal the username
      if (!userOk || !passOk) { fail(req); return { error: "Wrong username or password." }; }
      if (auth.totp?.enabled) return { pending: pendingToken(auth, remember) };
      failures.delete(clientIp(req));
      setSession(res, auth, remember);
      return {};
    },
    /** Step 2 with 2FA: the token from step 1 + a code from the app, or a recovery code (used up). */
    secondFactor(req: IncomingMessage, res: ServerResponse, pending: string, code: string): { error?: string } {
      const auth = load();
      if (!auth?.totp?.enabled) return { error: "Two-factor login isn't on." };
      if (blocked(req)) return { error: "Too many attempts. Try again in a few minutes." };
      const [exp, r, sig] = pending.split(".");
      const want = Buffer.from(sign(auth.secret, `2fa:${exp}:${r}`)), got = Buffer.from(sig ?? "");
      if (!exp || want.length !== got.length || !timingSafeEqual(want, got) || parseInt(exp, 36) < Date.now() / 1000)
        return { error: "That took too long. Log in again." };
      let ok = totpOk(auth.totp.secret, code);
      if (!ok && auth.recovery?.includes(sha(code))) { // a recovery code works once
        ok = true;
        save({ ...auth, recovery: auth.recovery.filter((h) => h !== sha(code)) });
      }
      if (!ok) { fail(req); return { error: "Wrong code." }; }
      failures.delete(clientIp(req));
      setSession(res, load()!, r === "1");
      return {};
    },

    // ── profile (the logged-in owner) ──
    setDisplayName(name: string) { const a = load()!; save({ ...a, displayName: name.trim().slice(0, 60) || undefined }); },
    /** New password; the secret rotates, so every other session is logged out. This one gets a fresh cookie. */
    changePassword(res: ServerResponse, current: string, next: string): string | null {
      const a = load()!;
      if (!verifyPassword(current, a.hash)) return "Your current password is wrong.";
      if (next.length < 10) return "Use at least 10 characters.";
      const updated = { ...a, hash: hashPassword(next), secret: randomBytes(32).toString("hex") };
      save(updated);
      setSession(res, updated, true);
      return null;
    },
    /** 2FA setup, step 1: a new secret (not active until confirmed with a code). */
    startTwoFactor() {
      const a = load()!;
      const secret = base32(randomBytes(20));
      save({ ...a, totp: { secret, enabled: false } });
      const label = encodeURIComponent(`los:${a.username}`);
      return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=los&algorithm=SHA1&digits=6&period=30` };
    },
    /** Step 2: a code from the app proves it's set up. Turns 2FA on and returns fresh recovery codes (shown once). */
    confirmTwoFactor(code: string): { error?: string; recovery?: string[] } {
      const a = load()!;
      if (!a.totp?.secret) return { error: "Start the setup first." };
      if (!totpOk(a.totp.secret, code)) return { error: "That code doesn't match. Check the time on your phone and try the next one." };
      const recovery = Array.from({ length: 8 }, () => randomBytes(5).toString("hex").replace(/(.{5})/, "$1-"));
      save({ ...a, totp: { secret: a.totp.secret, enabled: true }, recovery: recovery.map(sha) });
      return { recovery };
    },
    /** Turning 2FA off (or new recovery codes) needs the password and a current code. */
    disableTwoFactor(password: string, code: string): string | null {
      const a = load()!;
      if (!verifyPassword(password, a.hash)) return "Wrong password.";
      if (a.totp?.enabled && !totpOk(a.totp.secret, code)) return "Wrong code.";
      const { totp, recovery, ...rest } = a;
      save(rest);
      return null;
    },
    newRecoveryCodes(password: string, code: string): { error?: string; recovery?: string[] } {
      const a = load()!;
      if (!a.totp?.enabled) return { error: "Two-factor login isn't on." };
      if (!verifyPassword(password, a.hash)) return { error: "Wrong password." };
      if (!totpOk(a.totp.secret, code)) return { error: "Wrong code." };
      const recovery = Array.from({ length: 8 }, () => randomBytes(5).toString("hex").replace(/(.{5})/, "$1-"));
      save({ ...a, recovery: recovery.map(sha) });
      return { recovery };
    },
    recoveryLeft: () => load()?.recovery?.length ?? 0,

    /**
     * A viewing link for you: opens `scope` (a folder, so a page's own images and styles load too, or one file) and
     * nothing else, until it expires. It needs no cookie (a sandboxed page or the files address can't send los's), so
     * it's a bearer link: scoped and short-lived, so a leaked one exposes little. Shared files use share links instead.
     */
    viewToken(scope: string, ttlMs = 12 * 3600_000) {
      const auth = load();
      if (!auth) return "none";
      const exp = Math.floor((Date.now() + ttlMs) / 1000).toString(36);
      const sc = Buffer.from(scope).toString("base64url");
      return `${exp}.${sc}.${sign(auth.secret, `view:${exp}:${scope}`).slice(0, 22)}`;
    },
    /** The scope `token` opens, if it's genuine and not expired; else null. */
    viewScope(token: string): string | null {
      const auth = load(), [exp, sc, sig] = token.split(".");
      if (!auth || !exp || sc === undefined || !sig || parseInt(exp, 36) * 1000 < Date.now()) return null;
      const scope = Buffer.from(sc, "base64url").toString();
      const want = Buffer.from(sign(auth.secret, `view:${exp}:${scope}`).slice(0, 22)), got = Buffer.from(sig);
      return want.length === got.length && timingSafeEqual(want, got) ? scope : null;
    },

    logout(res: ServerResponse) {
      res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    },
  };
}
