// Web search through a self-hosted SearXNG (private, no API key) when one is set, else DuckDuckGo's HTML page.
// Plus page fetching.
import type { App } from "../../app.js";
import { definePlugin, defineTool, z } from "../../tools/define.js";
import { htmlToText } from "../../knowledge/extract.js";
import { fetchPage } from "./fetch.js";

export default (app: App) =>
  definePlugin({
    name: "web",
    description: "Search the internet and read web pages",
    tools: [
      defineTool({
        name: "web_search",
        description: "Search the web. Returns titles, urls and snippets. Read a result with web_fetch.",
        tags: ["internet", "google", "lookup", "news"],
        schema: z.object({ query: z.string() }),
        run: async ({ query }) => {
          const base = app.settings.web?.searxng_url;
          if (!base) return duckduckgo(query);
          const res = await fetch(`${base.replace(/\/$/, "")}/search?format=json&q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(20_000) });
          if (!res.ok) throw new Error(`SearXNG HTTP ${res.status} (is format: json enabled?)`);
          const data: any = await res.json();
          const results = (data.results ?? []).slice(0, 10).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content }));
          if (!results.length && data.unresponsive_engines?.length)
            throw new Error(`no results; engines that failed: ${data.unresponsive_engines.map((e: any) => e.join(": ")).join(", ")}`);
          return results;
        },
      }),
      defineTool({
        name: "web_fetch",
        description: "Read a web page (or PDF) as Markdown. mode \"article\" (default) picks out the main text; \"page\" keeps " +
          "the whole page (shop listings, tables, search results). render: true loads it in a real browser first, for " +
          "pages built by JavaScript (only if a browser is set up). Articles come without link URLs; links: true keeps them " +
          "(to follow links). Shops: a \"Page data\" block on top has product, price and stock when the page publishes them.",
        tags: ["internet", "read", "url", "page", "scrape"],
        schema: z.object({
          url: z.string().url(),
          mode: z.enum(["article", "page"]).optional(),
          render: z.boolean().optional(),
          links: z.boolean().optional().describe("Keep link URLs (default: only in page mode)"),
        }),
        run: async ({ url, mode, render, links }) => {
          const p = await fetchPage(url, { mode, render, links, browserUrl: app.settings.web?.browser_url, settings: app.settings });
          const head = [`# ${p.title ?? p.url}`, `${p.url} (HTTP ${p.status}${p.via === "browser" ? ", rendered in a browser" : ""})`, p.note && `Note: ${p.note}`];
          return [...head.filter(Boolean), "", p.text].join("\n");
        },
      }),
    ],
  });

/** No API key, no setup. Scrapes html.duckduckgo.com, so it breaks if they change their markup. */
async function duckduckgo(query: string) {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST", body: new URLSearchParams({ q: query }),
    headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) los/0.1" }, signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();
  const text = (s: string) => htmlToText(s).replace(/\s+/g, " ").trim();
  const results = [...html.matchAll(/class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
    .map(([, href, title, snippet]) => {
      const u = href.startsWith("//") ? new URL("https:" + href) : new URL(href, "https://duckduckgo.com");
      const url = u.searchParams.get("uddg") ?? u.href; // DuckDuckGo sometimes wraps links in a redirect
      return { title: text(title), url, snippet: text(snippet) };
    })
    .filter((r) => !r.url.includes("duckduckgo.com/y.js")) // ads
    .slice(0, 8);
  if (!results.length) throw new Error("DuckDuckGo returned no results (or changed its page)");
  return results;
}
