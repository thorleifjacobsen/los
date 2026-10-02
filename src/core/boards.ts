// Boards: kanban for you and the team. A board has its own columns (some marked "done"), cards have an assignee:
// you ("me"), an agent, or nobody. Cards assigned to an agent are its queue: it works them one at a time, as a
// background task, when it has time (queueCards, called by the scheduler). When that task ends and the agent left
// the card with itself, the card comes back to you with the result as a comment (afterCardTask). Agents can hand a
// card to you (they need your decision) or to a teammate; agent-to-agent passes are capped (MAX_PASSES) until you
// touch the card again. Everything that happens to a card is in card_events, which is also what agents see of your
// decisions. The tables are created by the boards plugin (src/plugins/boards).
import type { App } from "../app.js";
import type { DB } from "../db/index.js";
import { bus } from "./events.js";
import { createTask } from "../tasks/queue.js";

export const ME = "me";
export const MAX_PASSES = 5; // agent → agent hand-offs of one card before it has to come back to you

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  columns     TEXT NOT NULL,                  -- JSON [{name, done?}]: done columns hold finished cards (not queued, not "needs you")
  owner       TEXT,                           -- agent the board belongs to (it sees the board in every prompt), or null
  agents_move INTEGER NOT NULL DEFAULT 1,     -- 1: agents may move cards between columns (0: only you, for boards you lock)
  bypass      INTEGER NOT NULL DEFAULT 0,     -- 1: card work runs approval-needing tools without asking (set by you only)
  report_to   TEXT,                           -- chat that gets card-task reports
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cards (
  id         INTEGER PRIMARY KEY,
  board_id   INTEGER NOT NULL REFERENCES boards(id),
  col        TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,                            -- Markdown
  link       TEXT,
  image      TEXT,                            -- /files/… or https:// picture shown on the card
  tags       TEXT NOT NULL DEFAULT '[]',
  key        TEXT,                            -- dedupe key within the board (a domain, a URL, …)
  assignee   TEXT,                            -- 'me', an agent handle, or null
  priority   INTEGER NOT NULL DEFAULT 0,      -- 0 normal, 1 high, 2 urgent
  passes     INTEGER NOT NULL DEFAULT 0,      -- agent → agent hand-offs since you last touched it
  bypass     INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS cards_key ON cards(board_id, key) WHERE key IS NOT NULL;
CREATE INDEX IF NOT EXISTS cards_assignee ON cards(assignee);
CREATE TABLE IF NOT EXISTS card_events (
  id         INTEGER PRIMARY KEY,
  card_id    INTEGER NOT NULL,
  who        TEXT NOT NULL,                   -- 'me' or an agent handle
  type       TEXT NOT NULL,                   -- created | moved | assigned | comment | updated | result
  text       TEXT,
  data       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS card_events_card ON card_events(card_id);
`;

export type Column = { name: string; done?: boolean };
export type BoardRow = { id: number; name: string; description: string | null; columns: string; owner: string | null; agents_move: number; bypass: number; report_to: string | null; created_at: string };
export type CardRow = {
  id: number; board_id: number; col: string; title: string; body: string | null; link: string | null; image: string | null; tags: string;
  key: string | null; assignee: string | null; priority: number; passes: number; bypass: number; created_by: string | null; created_at: string; updated_at: string;
};
export class BoardError extends Error {}

const ui = (data: Record<string, unknown> = {}) => bus.emit("ui", { kind: "boards", ...data });
export const columnsOf = (b: BoardRow): Column[] => JSON.parse(b.columns);
const doneCols = (b: BoardRow) => columnsOf(b).filter((c) => c.done).map((c) => c.name);
const who = (app: App, h: string | null) => (h === ME ? "the user" : h ? `${app.settings.agents[h]?.displayName ?? h} (@${h})` : "nobody");

export function getBoard(db: DB, ref: number | string): BoardRow {
  const b = (typeof ref === "number" || /^\d+$/.test(String(ref))
    ? db.prepare("SELECT * FROM boards WHERE id = ?").get(Number(ref))
    : db.prepare("SELECT * FROM boards WHERE lower(name) = lower(?)").get(String(ref).trim())) as BoardRow | undefined;
  if (!b) throw new BoardError(`no board "${ref}" (see boards_list)`);
  return b;
}
export function getCard(db: DB, id: number): CardRow {
  const c = db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as CardRow | undefined;
  if (!c) throw new BoardError(`no card #${id}`);
  return c;
}

/** Columns from a list of names; a name ending in "(done)" or listed in `done` is a done column. */
export function parseColumns(names: (string | Column)[], done: string[] = []): Column[] {
  const cols = names.map((n) => typeof n === "string"
    ? { name: n.replace(/\s*\(done\)\s*$/i, "").trim(), done: /\(done\)\s*$/i.test(n) || done.includes(n) || undefined }
    : { name: n.name.trim(), done: n.done || undefined }).filter((c) => c.name);
  if (!cols.length) throw new BoardError("a board needs at least one column");
  if (new Set(cols.map((c) => c.name.toLowerCase())).size !== cols.length) throw new BoardError("column names must be unique");
  return cols;
}

export function createBoard(db: DB, b: { name: string; description?: string; columns: Column[]; owner?: string | null; agentsMove?: boolean; reportTo?: string | null }) {
  if (!b.name.trim()) throw new BoardError("a board needs a name");
  if (db.prepare("SELECT 1 FROM boards WHERE lower(name) = lower(?)").get(b.name.trim())) throw new BoardError(`there's already a board called "${b.name.trim()}"`);
  const id = Number(db.prepare("INSERT INTO boards (name, description, columns, owner, agents_move, report_to) VALUES (?, ?, ?, ?, ?, ?)")
    .run(b.name.trim(), b.description ?? null, JSON.stringify(b.columns), b.owner ?? null, b.agentsMove === false ? 0 : 1, b.reportTo ?? null).lastInsertRowid);
  ui({ boardId: id });
  return id;
}

/** Rename a board, change its description or columns (a column that still has cards can't go). */
export function updateBoard(db: DB, ref: number | string, p: { name?: string; description?: string | null; columns?: Column[] }) {
  const old = getBoard(db, ref);
  const cols = p.columns ?? columnsOf(old);
  const used = (db.prepare("SELECT DISTINCT col FROM cards WHERE board_id = ?").all(old.id) as { col: string }[]).map((r) => r.col);
  const gone = used.filter((c) => !cols.some((x) => x.name === c));
  if (gone.length) throw new BoardError(`these columns still have cards: ${gone.join(", ")}. Move the cards first.`);
  const name = p.name?.trim() || old.name;
  if (name.toLowerCase() !== old.name.toLowerCase() && db.prepare("SELECT 1 FROM boards WHERE lower(name) = lower(?)").get(name))
    throw new BoardError(`there's already a board called "${name}"`);
  db.prepare("UPDATE boards SET name = ?, description = ?, columns = ? WHERE id = ?")
    .run(name, p.description !== undefined ? p.description || null : old.description, JSON.stringify(cols), old.id);
  ui({ boardId: old.id });
  return getBoard(db, old.id);
}

export function logCard(db: DB, cardId: number, by: string, type: string, text?: string | null, data?: unknown) {
  db.prepare("INSERT INTO card_events (card_id, who, type, text, data) VALUES (?, ?, ?, ?, ?)")
    .run(cardId, by, type, text ?? null, data === undefined ? null : JSON.stringify(data));
}

function checkAssignee(app: App, a: string | null | undefined) {
  if (a && a !== ME && !app.settings.agents[a]) throw new BoardError(`"${a}" is neither "me" (the user) nor a teammate's handle`);
}
function checkColumn(b: BoardRow, col: string) {
  const c = columnsOf(b).find((x) => x.name.toLowerCase() === col.trim().toLowerCase());
  if (!c) throw new BoardError(`board "${b.name}" has no column "${col}" (columns: ${columnsOf(b).map((x) => x.name).join(", ")})`);
  return c.name;
}

export type CardInput = { title: string; body?: string; link?: string; image?: string; tags?: string[]; key?: string; column?: string; assignee?: string | null; priority?: number };

export function addCard(app: App, boardRef: number | string, c: CardInput, by: string) {
  const { db } = app;
  const b = getBoard(db, boardRef);
  const col = c.column ? checkColumn(b, c.column) : columnsOf(b)[0].name;
  checkAssignee(app, c.assignee);
  const key = c.key?.trim().toLowerCase() || null;
  if (key) {
    const dup = db.prepare("SELECT id, title, col, assignee FROM cards WHERE board_id = ? AND key = ?").get(b.id, key) as any;
    if (dup) throw new BoardError(`board "${b.name}" already has a card with key "${key}": #${dup.id} "${dup.title}" (${dup.col}${dup.assignee ? `, assigned to ${dup.assignee}` : ""})`);
  }
  if (!c.title?.trim()) throw new BoardError("a card needs a title");
  const id = Number(db.prepare(`INSERT INTO cards (board_id, col, title, body, link, image, tags, key, assignee, priority, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(b.id, col, c.title.trim(), c.body ?? null, c.link ?? null, c.image ?? null,
    JSON.stringify(c.tags ?? []), key, c.assignee ?? null, c.priority ?? 0, by).lastInsertRowid);
  logCard(db, id, by, "created", null, { column: col, assignee: c.assignee ?? null });
  ui({ boardId: b.id, cardId: id });
  if (c.assignee && c.assignee !== ME) queueCards(app);
  return id;
}

export type CardPatch = Partial<Omit<CardInput, "key">> & { comment?: string; bypass?: boolean };

/**
 * Change a card. `by` is "me" (the user, from the UI) or the agent doing it. Agents may only move cards on boards
 * that allow it, must say why when they hand a card on, and can't pass it between agents more than MAX_PASSES times.
 */
export function updateCard(app: App, id: number, p: CardPatch, by: string) {
  const { db } = app;
  const c = getCard(db, id), b = getBoard(db, c.board_id);
  const user = by === ME;
  const sets: string[] = [], vals: unknown[] = [];
  const set = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
  const comment = p.comment?.trim();

  if (p.column !== undefined) {
    const col = checkColumn(b, p.column);
    if (col !== c.col) {
      if (!user && !b.agents_move) throw new BoardError(`on "${b.name}" only the user moves cards between columns; add a comment, or assign the card to "me" with what you suggest`);
      set("col", col);
      logCard(db, id, by, "moved", null, { from: c.col, to: col });
    }
  }
  if (p.assignee !== undefined && (p.assignee ?? null) !== c.assignee) {
    checkAssignee(app, p.assignee);
    const to = p.assignee ?? null;
    if (!user) {
      if (!comment) throw new BoardError("say why when you hand a card on: add a comment (what's done, what you need from them)");
      if (to && to !== ME && to !== by && c.passes >= MAX_PASSES)
        throw new BoardError(`card #${id} has already been passed between teammates ${c.passes} times; assign it to "me" (the user) instead`);
      if (to && to !== ME && to !== by) set("passes", c.passes + 1);
    }
    set("assignee", to);
    logCard(db, id, by, "assigned", null, { from: c.assignee, to });
  }
  if (user) set("passes", 0); // you touched it: the count starts over
  for (const [k, col] of [["title", "title"], ["body", "body"], ["link", "link"], ["image", "image"]] as const)
    if (p[k] !== undefined && p[k] !== c[col]) set(col, p[k] || (k === "title" ? c.title : null));
  if (p.tags !== undefined) set("tags", JSON.stringify(p.tags));
  if (p.priority !== undefined) set("priority", Math.max(0, Math.min(2, Math.round(p.priority))));
  if (p.bypass !== undefined) {
    if (!user) throw new BoardError("only the user can change bypass");
    set("bypass", p.bypass ? 1 : 0);
  }
  if (sets.some((s) => /^(title|body|link|image|tags|priority) /.test(s))) logCard(db, id, by, "updated", null, Object.fromEntries(
    Object.entries(p).filter(([k]) => ["title", "link", "image", "tags", "priority"].includes(k))));
  if (comment) logCard(db, id, by, "comment", comment);
  if (sets.length) db.prepare(`UPDATE cards SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...vals, id);
  else if (comment) db.prepare("UPDATE cards SET updated_at = datetime('now') WHERE id = ?").run(id);
  ui({ boardId: b.id, cardId: id });
  queueCards(app);
  return getCard(db, id);
}

export function deleteCard(db: DB, id: number) {
  const c = getCard(db, id);
  db.prepare("DELETE FROM card_events WHERE card_id = ?").run(id);
  db.prepare("DELETE FROM cards WHERE id = ?").run(id);
  ui({ boardId: c.board_id });
}

export const cardEvents = (db: DB, id: number, limit = 200) =>
  (db.prepare("SELECT * FROM (SELECT * FROM card_events WHERE card_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id").all(id, limit) as any[])
    .map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null }));

/** A card for an agent: plain fields, plus its history in words. */
export function cardText(app: App, c: CardRow, b: BoardRow, history = 15) {
  const evs = cardEvents(app.db, c.id, history).map((e) => `- ${e.created_at} ${who(app, e.who)}: ` + (
    e.type === "moved" ? `moved it ${e.data.from} → ${e.data.to}` : e.type === "assigned" ? `assigned it to ${who(app, e.data.to)}`
    : e.type === "created" ? `created it in ${e.data.column}` : e.type === "updated" ? `edited it` : `${e.type === "result" ? "result" : "comment"}: ${e.text}`));
  return [`Card #${c.id} on board "${b.name}" (#${b.id}), column "${c.col}", assigned to ${who(app, c.assignee)}${c.priority ? `, priority ${["normal", "high", "urgent"][c.priority]}` : ""}`,
    `Title: ${c.title}`, c.link && `Link: ${c.link}`, c.image && `Image: ${c.image}`, JSON.parse(c.tags).length ? `Tags: ${JSON.parse(c.tags).join(", ")}` : "",
    c.body && `\n${c.body}`, evs.length ? `\nHistory:\n${evs.join("\n")}` : ""].filter(Boolean).join("\n");
}

/** The agent queue: each agent with cards assigned to it gets one task at a time, most urgent then oldest card first. */
export function queueCards(app: App) {
  const { db } = app;
  const open = new Set((db.prepare("SELECT agent FROM tasks WHERE card_id IS NOT NULL AND status IN ('queued', 'running', 'waiting')").all() as { agent: string }[]).map((r) => r.agent));
  const cards = db.prepare(`SELECT c.*, b.columns AS board_columns FROM cards c JOIN boards b ON b.id = c.board_id
    WHERE c.assignee IS NOT NULL AND c.assignee != 'me' ORDER BY c.priority DESC, c.created_at, c.id`).all() as (CardRow & { board_columns: string })[];
  let queued = 0;
  for (const c of cards) {
    if (open.has(c.assignee!) || !app.settings.agents[c.assignee!]) continue;
    if ((JSON.parse(c.board_columns) as Column[]).some((x) => x.done && x.name === c.col)) continue;
    const b = getBoard(db, c.board_id);
    const agent = app.settings.agents[c.assignee!];
    createTask(db, {
      title: `Card #${c.id}: ${c.title}`.slice(0, 120), agent: agent.name, cardId: c.id, bypass: !!(b.bypass || c.bypass), reportTo: b.report_to ?? undefined,
      prompt: `${cardText(app, c, b)}\n\n---\nThis card on the board "${b.name}" is assigned to you, so it's your job now. Do what it asks.\n` +
        `When you're done, write the result on the card: cards_update with id ${c.id} and a comment saying what you did, with links to anything you made` +
        (b.agents_move ? `, and move it to the right column (columns: ${columnsOf(b).map((x) => x.name + (x.done ? " (done)" : "")).join(", ")}).` : ". Only the user moves cards on this board.") +
        `\nIf you need the user's decision or input, assign it to "me" with a comment saying exactly what you need. If a teammate should do the next part, ` +
        `find them with team_find and assign it to them with a comment. If you leave it assigned to yourself, it goes back to the user for review when you finish. ` +
        `Your final answer is a short summary of the result.`,
    });
    open.add(agent.name);
    queued++;
  }
  if (queued) bus.emit("ui", { kind: "tasks" });
  return queued;
}

/** A card task ended: its result goes on the card, and a card the agent left with itself comes back to you. */
export function afterCardTask(app: App, t: { id: number; card_id: number | null; agent: string | null; status: string; result: string | null }) {
  const { db } = app;
  if (!t.card_id || !t.agent) return;
  const c = db.prepare("SELECT * FROM cards WHERE id = ?").get(t.card_id) as CardRow | undefined;
  if (!c) return;
  const ok = t.status === "done";
  const result = (t.result ?? "").trim();
  logCard(db, c.id, t.agent, "result", ok ? result || "(no result)" : `Task #${t.id} ${t.status}${result && t.status !== "cancelled" ? `: ${result.slice(0, 2000)}` : ""}`, { task: t.id, status: t.status });
  const b = getBoard(db, c.board_id);
  if (c.assignee === t.agent && !doneCols(b).includes(c.col)) {
    db.prepare("UPDATE cards SET assignee = 'me', updated_at = datetime('now') WHERE id = ?").run(c.id);
    logCard(db, c.id, t.agent, "assigned", ok ? "Done: back to you for review." : "Didn't finish: back to you.", { from: t.agent, to: ME });
  }
  ui({ boardId: b.id, cardId: c.id });
  queueCards(app);
}

/** For an agent's system prompt: its boards, its cards, and what the user decided lately. */
export function boardsContext(app: App, agent: string) {
  const { db } = app;
  const boards = db.prepare(`SELECT * FROM boards WHERE owner = ? OR id IN (SELECT board_id FROM cards WHERE assignee = ?) ORDER BY id`).all(agent, agent) as BoardRow[];
  if (!boards.length) return undefined;
  const lines = ["Boards you work with (kanban; tools cards_find / cards_add / cards_update):"];
  for (const b of boards) {
    const counts = db.prepare("SELECT col, count(*) n FROM cards WHERE board_id = ? GROUP BY col").all(b.id) as { col: string; n: number }[];
    lines.push(`- "${b.name}" (#${b.id}${b.owner === agent ? ", yours" : ""}): ${columnsOf(b).map((c) => `${c.name} ${counts.find((x) => x.col === c.name)?.n ?? 0}`).join(", ")}` +
      `${b.agents_move ? "" : ". Only the user moves cards here."}`);
    const mine = db.prepare("SELECT id, title, col FROM cards WHERE board_id = ? AND assignee = ? ORDER BY priority DESC, id LIMIT 10").all(b.id, agent) as any[];
    for (const c of mine) lines.push(`  - assigned to you: #${c.id} "${c.title}" (${c.col})`);
    // The user's recent decisions on this board, so the agent learns what they want.
    const recent = db.prepare(`SELECT e.*, c.title FROM card_events e JOIN cards c ON c.id = e.card_id
      WHERE c.board_id = ? AND e.who = 'me' AND e.type IN ('moved', 'comment', 'assigned') AND e.created_at > datetime('now', '-30 days')
      ORDER BY e.id DESC LIMIT 12`).all(b.id) as any[];
    for (const e of recent.reverse()) {
      const d = e.data ? JSON.parse(e.data) : {};
      lines.push(`  - the user ${e.type === "moved" ? `moved #${e.card_id} "${e.title}" to ${d.to}` : e.type === "assigned" ? `assigned #${e.card_id} "${e.title}" to ${who(app, d.to)}` : `commented on #${e.card_id} "${e.title}": ${String(e.text).slice(0, 200)}`} (${e.created_at.slice(0, 10)})`);
    }
  }
  return lines.join("\n");
}

/** Cards waiting for you: assigned to "me" and not in a done column. */
export function needsYou(db: DB) {
  const rows = db.prepare("SELECT c.id, c.col, b.columns FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.assignee = 'me'").all() as any[];
  return rows.filter((r) => !(JSON.parse(r.columns) as Column[]).some((x) => x.done && x.name === r.col)).length;
}
