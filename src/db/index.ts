import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

export function openDb(path: string, opts: { embedDim?: number } = {}): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");   // chat + workers can write at the same time
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  sqliteVec.load(db);
  db.exec(schema);
  migrate(db);
  if (opts.embedDim) {
    // Vector table needs a fixed dimension; it matches the embedding model in settings.yaml.
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${opts.embedDim}])`);
  }
  return db;
}

export const hasTable = (db: DB, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);

/** Columns added after a table first shipped (CREATE TABLE IF NOT EXISTS won't add them to an existing db).
 *  Runs after the core schema and again after plugin schemas, so plugin tables can be listed here too. */
export function migrate(db: DB) {
  const add = (table: string, col: string, def: string) => {
    if (!hasTable(db, table)) return;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  add("messages", "brain", "TEXT");                          // which brain wrote an assistant message
  add("documents", "private", "INTEGER NOT NULL DEFAULT 0"); // per-document privacy
  add("memories", "private", "INTEGER NOT NULL DEFAULT 0");  // per-memory privacy
  add("tasks", "report_to", "TEXT");                         // chat that gets the result
  add("tasks", "job_id", "INTEGER");                         // schedule that started it
  add("sessions", "kind", "TEXT NOT NULL DEFAULT 'chat'");   // chat | task
  add("messages", "agent", "TEXT");                          // who wrote it / who it was addressed to
  add("sessions", "members", "TEXT");                        // agents invited to a room
  add("tasks", "requested_by", "TEXT");                      // (unused since chats replaced wake-ups)
  add("sessions", "bypass", "INTEGER NOT NULL DEFAULT 0");   // 1: tools that need approval run without asking here
  add("tasks", "bypass", "INTEGER NOT NULL DEFAULT 0");      // same for a background task (copied to its session)
  add("jobs", "bypass", "INTEGER NOT NULL DEFAULT 0");       // passed on to every task the job starts
  // 2026-10: plain chats with visible handoffs. Home, DMs and rooms all became chats.
  const newTurn = hasTable(db, "messages") && !(db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).some((c) => c.name === "turn");
  add("messages", "turn", "INTEGER");                        // the run (its starting user/handoff message) a reply belongs to
  add("events", "agent", "TEXT");                            // who was working (several agents can work in one chat)
  add("sessions", "allow", "TEXT NOT NULL DEFAULT '[]'");    // tools allowed for the rest of this chat
  if (hasTable(db, "sessions")) {
    db.exec(`UPDATE sessions SET title = 'Home' WHERE kind = 'home' AND title IS NULL`);
    db.exec(`DELETE FROM sessions WHERE kind = 'dm' AND id NOT IN (SELECT DISTINCT session_id FROM messages)`); // never used
    db.exec(`UPDATE sessions SET title = 'Chat with ' || agent WHERE kind = 'dm' AND title IS NULL`);
    db.exec(`UPDATE sessions SET kind = 'chat' WHERE kind IN ('home', 'dm', 'room')`);
  }
  // 2026-10: agents are named by their names (@los, @mira, @finn, @vera), not their jobs. Once (user_version 1).
  if (hasTable(db, "sessions") && (db.pragma("user_version", { simple: true }) as number) < 1) {
    const renames: [string, string][] = [["assistant", "los"], ["researcher", "mira"], ["coder", "finn"], ["mail-clerk", "vera"]];
    db.transaction(() => {
      for (const [from, to] of renames) {
        for (const [t, c] of [["sessions", "agent"], ["messages", "agent"], ["events", "agent"], ["tasks", "agent"], ["jobs", "agent"]] as const)
          if (hasTable(db, t)) db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`).run(to, from);
        db.prepare(`UPDATE sessions SET members = replace(members, ?, ?) WHERE members LIKE ?`).run(`"${from}"`, `"${to}"`, `%"${from}"%`);
        db.prepare(`UPDATE sessions SET title = ? WHERE title = ?`).run(`Chat with ${to[0].toUpperCase()}${to.slice(1)}`, `Chat with ${from}`);
        // CLI sessions are resumed per brain and agent: keep the agent in their runtime events in step.
        db.prepare(`UPDATE events SET data = json_set(data, '$.agent', ?) WHERE type = 'runtime' AND json_extract(data, '$.agent') = ?`).run(to, from);
      }
    })();
    db.pragma("user_version = 1");
  }
  // Plans became per agent and run (2026-10): rebuild the old per-session table (its primary key changes).
  if (hasTable(db, "plan_steps") && !(db.prepare("PRAGMA table_info(plan_steps)").all() as { name: string }[]).some((c) => c.name === "agent")) {
    db.exec(`ALTER TABLE plan_steps RENAME TO plan_steps_old;
      CREATE TABLE plan_steps (session_id TEXT NOT NULL, agent TEXT NOT NULL DEFAULT '', turn INTEGER, idx INTEGER NOT NULL, text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY (session_id, agent, idx));
      INSERT INTO plan_steps (session_id, agent, turn, idx, text, status)
        SELECT p.session_id, coalesce(s.agent, ''), NULL, p.idx, p.text, p.status FROM plan_steps_old p LEFT JOIN sessions s ON s.id = p.session_id;
      DROP TABLE plan_steps_old;`);
  }
  // 2026-10-02: editing a message branches the chat (later messages archived, not deleted); chats have a files
  // folder and can be archived.
  add("messages", "archived", "INTEGER");                   // id of the edited message that replaced this part of the chat
  add("messages", "edit_of", "INTEGER");                    // on an edited message: the one it replaced
  add("sessions", "folder", "TEXT");                        // the chat's workspace folder (uploads, its files)
  add("sessions", "archived", "INTEGER NOT NULL DEFAULT 0");// hidden from the chat list
  if (!hasTable(db, "public_links")) db.exec(`CREATE TABLE public_links (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  // Before this, a reply belonged to the last user message before it.
  if (newTurn) db.exec(`UPDATE messages SET turn = (SELECT max(u.id) FROM messages u WHERE u.session_id = messages.session_id
    AND u.role = 'user' AND u.id < messages.id) WHERE role != 'user'`);
}
