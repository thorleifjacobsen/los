// Fetching on an agent's behalf (web_fetch, image_view, the browser fallback) must only reach the public internet.
// Otherwise a web page could steer an agent ("fetch http://…") into los itself, the Chrome DevTools port, other
// containers, the router, or a cloud metadata service (SSRF). Every connection is checked at the IP it really
// connects to (so DNS tricks and redirects are covered), not just the URL. Exceptions: web.allow_internal hosts.
import { Agent, fetch as ufetch, type RequestInit as URequestInit } from "undici";
import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import type { Settings } from "../config.js";

const internal = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const)
  internal.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const)
  internal.addSubnet(net, bits, "ipv6");

/** Is this IP on a private, loopback, link-local or otherwise non-public network? (IPv4-mapped IPv6 included.) */
export function isInternalIp(ip: string): boolean {
  const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (v4) return internal.check(v4, "ipv4");
  const fam = isIP(ip);
  return fam === 0 ? true : internal.check(ip, fam === 4 ? "ipv4" : "ipv6");
}

const allowed = (settings: Settings, host: string) => (settings.web?.allow_internal ?? []).some((h) => h.toLowerCase() === host.toLowerCase());

/** Throws unless `url` is http(s) to a host that may be on the public internet (the IP is checked at connect time). */
export function checkPublicUrl(settings: Settings, raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`only http and https addresses (not ${url.protocol})`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (allowed(settings, host)) return url;
  if (isIP(host) ? isInternalIp(host) : !host.includes(".") || /\.(local|localhost|internal|lan|home|arpa)$/i.test(host))
    throw new Error(`"${host}" is an internal address; agents may only fetch from the public internet (allow it with web.allow_internal)`);
  return url;
}

let agent: { allow: string; agent: Agent } | null = null;
function publicAgent(settings: Settings) {
  const allow = JSON.stringify(settings.web?.allow_internal ?? []);
  if (agent?.allow === allow) return agent.agent;
  agent = {
    allow,
    agent: new Agent({
      connect: {
        // Resolve, then refuse to connect to an internal address (unless that host is explicitly allowed).
        lookup: (hostname, opts, cb) => lookup(hostname, { ...opts, all: true }, (err, addrs: any) => {
          if (err) return cb(err, "", 0);
          const list = (Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }]) as { address: string; family: number }[];
          const bad = !allowed(settings, hostname) && list.find((a) => isInternalIp(a.address));
          if (bad) return cb(Object.assign(new Error(`"${hostname}" resolves to an internal address (${bad.address})`), { code: "EINTERNAL" }), "", 0);
          if ((opts as any).all) return (cb as any)(null, list);
          cb(null, list[0].address, list[0].family);
        }),
      },
    }),
  };
  return agent.agent;
}

/** fetch() for agents: public internet only, redirects re-checked (max 5). */
export async function fetchPublic(settings: Settings, url: string, init: URequestInit = {}) {
  let current = checkPublicUrl(settings, url).href;
  for (let hop = 0; hop <= 5; hop++) {
    const res = await ufetch(current, { ...init, redirect: "manual", dispatcher: publicAgent(settings) });
    const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!to) return res;
    current = checkPublicUrl(settings, new URL(to, current).href).href;
  }
  throw new Error("too many redirects");
}
