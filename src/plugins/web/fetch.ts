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
  return inBrowser(browserUrl, url, {}, async (send) => {
    const r = await send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true });
    return r.result?.result?.value ?? "";
  });
}

export const VIEWPORTS = { desktop: { width: 1440, height: 900, mobile: false }, mobile: { width: 390, height: 844, mobile: true } };
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/**
 * Screenshots of `url` as JPEG, in a desktop or phone-sized window: the first screen, or with `fullPage` the whole
 * scrolled page in parts (each about two screens tall, so a model sees them at a readable size), at most `maxParts`.
 * Public addresses only, like web_fetch.
 */
export async function screenshot(settings: Settings, browserUrl: string, url: string, o: { device: keyof typeof VIEWPORTS; fullPage: boolean; maxParts?: number }) {
  await resolvesPublic(settings, url);
  const vp = VIEWPORTS[o.device];
  return inBrowser(browserUrl, url, { viewport: vp, ua: vp.mobile ? MOBILE_UA : undefined }, async (send) => {
    let height = vp.height;
    if (o.fullPage) {
      // Scroll through once so lazy images load, then measure.
      await send("Runtime.evaluate", { expression: "(async () => { for (let y = 0; y < document.documentElement.scrollHeight && y < 20000; y += innerHeight) { scrollTo(0, y); await new Promise(r => setTimeout(r, 150)); } scrollTo(0, 0); })()", awaitPromise: true });
      await new Promise((r) => setTimeout(r, 500));
      const m = await send("Runtime.evaluate", { expression: "Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)", returnByValue: true });
      height = Math.max(Number(m.result?.result?.value) || vp.height, vp.height);
    }
    const t = await send("Runtime.evaluate", { expression: "[document.title, location.href]", returnByValue: true });
    const [title, finalUrl] = (t.result?.result?.value ?? []) as string[];
    const part = vp.mobile ? 1600 : 1800, max = o.maxParts ?? 4;
    const parts: { bytes: Buffer; y: number; height: number }[] = [];
    for (let y = 0; y < height && parts.length < max; y += part) {
      const h = Math.min(part, height - y);
      const shot = await send("Page.captureScreenshot", {
        format: "jpeg", quality: 80, captureBeyondViewport: o.fullPage, clip: { x: 0, y, width: vp.width, height: h, scale: 1 },
      });
      if (!shot.result?.data) throw new Error(`the browser couldn't take the screenshot${shot.error ? `: ${shot.error.message}` : ""}`);
      parts.push({ bytes: Buffer.from(shot.result.data, "base64"), y, height: h });
    }
    return { parts, width: vp.width, pageHeight: height, cut: parts.at(-1)!.y + parts.at(-1)!.height < height, title: title || undefined, url: finalUrl || url };
  });
}

const CALL_MS = 30_000;
const withTimeout = <T>(p: Promise<T>, ms: number, why: string) => {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, j) => { timer = setTimeout(() => j(new Error(why)), ms); })]).finally(() => clearTimeout(timer));
};

/** Open `url` in a fresh tab of the headless Chrome, wait for it to load, run `fn` with a DevTools `send`, close the tab. */
async function inBrowser<T>(browserUrl: string, url: string, o: { viewport?: { width: number; height: number; mobile: boolean }; ua?: string },
  fn: (send: (method: string, params?: object) => Promise<any>) => Promise<T>): Promise<T> {
  // Chrome only answers DevTools requests addressed to an IP or localhost, so resolve the service name first.
  const u = new URL(browserUrl);
  if (!/^[\d.]+$|^localhost$/.test(u.hostname)) u.hostname = (await lookup(u.hostname)).address;
  const base = u.href.replace(/\/$/, "");
  const target = await (await fetch(`${base}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(10_000) })).json() as any;
  const ws = new WebSocket(target.webSocketDebuggerUrl.replace(/\/\/[^/]+/, `//${u.host}`));
  let id = 0;
  let loaded: () => void = () => {};
  const onLoad = new Promise<void>((r) => (loaded = r));
  const waiting = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)!.resolve(msg); waiting.delete(msg.id); }
    if (msg.method === "Page.loadEventFired") loaded();
  };
  // Every DevTools call has a time limit, and a dropped connection fails whatever is still waiting: a page that
  // wedges the tab (or a browser that goes away) must not leave the agent waiting forever (it once hung 8 hours).
  const gone = (why: string) => { for (const w of waiting.values()) w.reject(new Error(why)); waiting.clear(); };
  ws.onclose = () => gone("the browser closed the connection");
  const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { waiting.delete(n); reject(new Error(`the browser didn't answer ${method} within ${CALL_MS / 1000}s`)); }, CALL_MS);
    waiting.set(n, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const opened = new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("could not reach the browser")); });
  try {
    await withTimeout(opened, 10_000, "could not reach the browser (timed out)");
    await send("Network.setUserAgentOverride", { userAgent: o.ua ?? UA, acceptLanguage: HEADERS["accept-language"] });
    if (o.viewport) await send("Emulation.setDeviceMetricsOverride", { width: o.viewport.width, height: o.viewport.height, deviceScaleFactor: 1, mobile: o.viewport.mobile });
    await send("Page.enable");
    await send("Page.navigate", { url });
    await Promise.race([onLoad, new Promise((r) => setTimeout(r, 25_000))]);
    await new Promise((r) => setTimeout(r, 1500)); // let late scripts fill the page in
    return await withTimeout(fn(send), 90_000, "the browser took too long with this page");
  } finally {
    gone("done");
    ws.close();
    fetch(`${base}/json/close/${target.id}`).catch(() => {});
  }
}
