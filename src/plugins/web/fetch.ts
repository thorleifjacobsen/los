// Fetching a web page for an agent, locally: a plain request with ordinary browser headers, the main content picked
// out with Mozilla Readability (what Firefox's reader view uses), turned into Markdown. Pages that only render with
// JavaScript go through a headless Chrome when `web.browser_url` is set (a Chrome DevTools endpoint, e.g. the
// optional `browser` service in docker-compose.yml). Nothing goes through a third party.
import { lookup } from "node:dns/promises";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
// @ts-expect-error no types
import { gfm } from "turndown-plugin-gfm";
import { extractBuffer } from "../../knowledge/extract.js";
import { fetchPublic, checkPublicUrl, isInternalIp } from "../../core/net.js";
import type { Settings } from "../../config.js";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const HEADERS = {
  "user-agent": UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
  "accept-language": "nb-NO,nb;q=0.9,no;q=0.8,en;q=0.7",
};
const THIN = 400; // less readable text than this from an HTML page → probably rendered by JavaScript

export type Mode = "article" | "page";
export interface Fetched { url: string; status: number; title?: string; via: "http" | "browser"; text: string; note?: string }

export async function fetchPage(url: string, o: { mode?: Mode; render?: boolean; links?: boolean; browserUrl?: string; settings: Settings }): Promise<Fetched> {
  // Public internet only (see core/net.ts). The browser fetches by itself, so its target is checked up front too
  // (and the browser container sits on los's own network, away from the other services on the box).
  checkPublicUrl(o.settings, url);
  if (o.browserUrl) await resolvesPublic(o.settings, url);
  const mode = o.mode ?? "article";
  const links = o.links ?? mode === "page"; // an article reads better (and costs ~30% less) without every link's URL
  if (o.render && o.browserUrl) return fromHtml(url, 200, await renderInBrowser(o.browserUrl, url), mode, "browser", links);
  const res = await fetchPublic(o.settings, url, { headers: HEADERS, signal: AbortSignal.timeout(25_000) });
  const type = res.headers.get("content-type") ?? "";
  const status = res.status;
  if (type.includes("pdf")) {
    const text = await extractBuffer(Buffer.from(await res.arrayBuffer()), ".pdf");
    return { url: res.url, status, via: "http", text: text ?? "(could not read this PDF)" };
  }
  const body = await res.text();
  if (!/html|xml/.test(type) && !/^\s*</.test(body)) return { url: res.url, status, via: "http", text: body };
  const page = fromHtml(res.url, status, body, mode, "http", links);
  const blocked = status === 403 || status === 429 || status === 503 || /just a moment|enable javascript|attention required/i.test(page.title ?? "");
  if ((blocked || page.text.length < THIN) && o.browserUrl) {
    try { return fromHtml(url, 200, await renderInBrowser(o.browserUrl, url), mode, "browser", links); }
    catch (e) { page.note = `The browser fallback failed too: ${(e as Error).message}`; }
  } else if (blocked) page.note = `The site answered ${status}: it may be blocking automated requests from this network.`;
  else if (page.text.length < THIN) page.note = "Very little text: the page may need JavaScript (render: true, if a browser is set up).";
  return page;
}

function fromHtml(url: string, status: number, html: string, mode: Mode, via: Fetched["via"], links = mode === "page"): Fetched {
  const { document } = parseHTML(html);
  const title = document.querySelector("title")?.textContent?.trim() || undefined;
  const data = pageData(document);
  for (const el of document.querySelectorAll(NOISE)) el.remove();
  let content: string | null = null;
  if (mode === "article") {
    try { content = new Readability(document.cloneNode(true) as any, { charThreshold: 200 }).parse()?.content ?? null; }
    catch { content = null; }
  }
  // Shop listings, tables, search results: Readability may drop them. Fall back to the whole page without chrome.
  if (!content || textLength(content) < THIN) {
    for (const el of document.querySelectorAll(`script, style, noscript, svg, iframe, template, nav, header, footer, [aria-hidden=true], ${CONSENT}`)) el.remove();
    content = document.body?.innerHTML ?? html;
  }
  return { url, status, title, via, text: (data ? `${data}\n\n---\n\n` : "") + markdown(content, url, links) };
}

// Boilerplate inside the content: navigation boxes, reference lists, edit links, tables of contents, footnote markers,
// "sister project" boxes (Wikipedia and most wikis/CMSes use these names). Removed in every mode.
const NOISE = [".navbox", ".vertical-navbox", ".sidebar", ".reflist", "ol.references", ".mw-references-wrap", ".mw-editsection",
  "sup.reference", ".noprint", ".metadata", ".catlinks", "#toc", ".toc", ".mw-jump-link", ".sistersitebox", ".ambox",
  ".geological-timescale", ".infobox .timescale", "[role=navigation]", ".skip-link", ".visually-hidden", ".sr-only"].join(", ");

// Cookie/consent banners (OneTrust, Cookiebot, CookieYes, Didomi, generic): pure noise for a reader.
const CONSENT = ["#onetrust-consent-sdk", "#CybotCookiebotDialog", "#cookiebanner", "#cookie-banner", ".cky-consent-container",
  "#didomi-host", "[id*=cookie-consent]", "[class*=cookie-consent]", "[class*=CookieConsent]", "[aria-label*=cookie i]"].join(", ");

/** What a page says about itself in machine-readable form (shops: product, price, stock), as a few Markdown lines. */
function pageData(document: any): string {
  const lines: string[] = [];
  const meta = (k: string) => document.querySelector(`meta[property="${k}"], meta[name="${k}"]`)?.getAttribute("content")?.trim();
  const price = meta("product:price:amount") ?? meta("og:price:amount");
  if (price) lines.push(`- Price: ${price} ${meta("product:price:currency") ?? meta("og:price:currency") ?? ""}`.trim());
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    let json: any;
    try { json = JSON.parse(el.textContent ?? ""); } catch { continue; }
    for (const item of [json, ...(json?.["@graph"] ?? [])].flat()) {
      const type = [item?.["@type"]].flat().join(",");
      if (!/Product/i.test(type)) continue;
      const offers = [item.offers?.offers ?? item.offers].flat().filter(Boolean);
      lines.push(`- Product: ${item.name ?? "?"}${item.sku ? ` (SKU ${item.sku})` : ""}${item.brand?.name ? `, ${item.brand.name}` : ""}`);
      for (const o of offers.slice(0, 5)) {
        const amount = o.price ?? o.lowPrice;
        if (amount !== undefined) lines.push(`- Offer: ${amount} ${o.priceCurrency ?? ""}${o.availability ? `, ${String(o.availability).replace(/^https?:\/\/schema\.org\//, "")}` : ""}`);
      }
      if (item.aggregateRating?.ratingValue) lines.push(`- Rating: ${item.aggregateRating.ratingValue} (${item.aggregateRating.reviewCount ?? item.aggregateRating.ratingCount ?? "?"} reviews)`);
    }
  }
  const unique = [...new Set(lines)];
  return unique.length ? `**Page data** (structured data the page publishes)\n${unique.join("\n")}` : "";
}

const textLength = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length;

function markdown(html: string, base: string, links: boolean) {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  td.use(gfm);
  td.remove(["script", "style", "noscript"] as any);
  // Absolute links, so the agent can follow them; images only as their alt text (they're noise for a reader).
  td.addRule("links", {
    filter: (n) => n.nodeName === "A" && !!n.getAttribute("href"),
    replacement: (text, n: any) => {
      const t = text.trim(), href = n.getAttribute("href");
      if (!t) return "";
      if (!links || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) return t; // in-page anchors, footnotes: noise
      try { return `[${t}](${new URL(href, base).href})`; } catch { return t; }
    },
  });
  td.addRule("images", { filter: "img", replacement: (_, n: any) => (n.getAttribute("alt") ? `[image: ${n.getAttribute("alt")}]` : "") });
  return td.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

/** Throws if `url`'s host resolves to an internal address (for targets something else will fetch, like the browser). */
async function resolvesPublic(settings: Settings, url: string) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if ((settings.web?.allow_internal ?? []).includes(host)) return;
  const addrs = await lookup(host, { all: true }).catch(() => []);
  const bad = addrs.find((a) => isInternalIp(a.address));
  if (bad) throw new Error(`"${host}" resolves to an internal address (${bad.address})`);
}

/** Load `url` in a headless Chrome over the DevTools protocol and return the rendered HTML. No library needed. */
async function renderInBrowser(browserUrl: string, url: string): Promise<string> {
  // Chrome only answers DevTools requests addressed to an IP or localhost, so resolve the service name first.
  const u = new URL(browserUrl);
  if (!/^[\d.]+$|^localhost$/.test(u.hostname)) u.hostname = (await lookup(u.hostname)).address;
  const base = u.href.replace(/\/$/, "");
  const target = await (await fetch(`${base}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(10_000) })).json() as any;
  const ws = new WebSocket(target.webSocketDebuggerUrl.replace(/\/\/[^/]+/, `//${u.host}`));
  let id = 0;
  const waiting = new Map<number, (r: any) => void>();
  let loaded: () => void = () => {};
  const onLoad = new Promise<void>((r) => (loaded = r));
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)!(msg); waiting.delete(msg.id); }
    if (msg.method === "Page.loadEventFired") loaded();
  };
  const send = (method: string, params: object = {}) => new Promise<any>((resolve) => {
    waiting.set(++id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("could not reach the browser")); });
    await send("Network.setUserAgentOverride", { userAgent: UA, acceptLanguage: HEADERS["accept-language"] });
    await send("Page.enable");
    await send("Page.navigate", { url });
    await Promise.race([onLoad, new Promise((r) => setTimeout(r, 25_000))]);
    await new Promise((r) => setTimeout(r, 1500)); // let late scripts fill the page in
    const r = await send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true });
    return r.result?.result?.value ?? "";
  } finally {
    ws.close();
    fetch(`${base}/json/close/${target.id}`).catch(() => {});
  }
}
