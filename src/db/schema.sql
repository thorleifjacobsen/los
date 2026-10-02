-- Core tables. Plugins add their own via Plugin.schema.

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  agent      TEXT NOT NULL,
  title      TEXT,
  private    INTEGER NOT NULL DEFAULT 0,   -- 1 once a local-only tool ran: cloud brains are refused from then on
  tools      TEXT NOT NULL DEFAULT '[]',   -- tools loaded via tool_search, kept across turns
  brain      TEXT,                         -- chat's brain override (null → the agent's brain)
  kind       TEXT NOT NULL DEFAULT 'chat', -- chat | task (a background task's own conversation)
  members    TEXT,                         -- JSON handles that have taken part (the lead first)
  allow      TEXT NOT NULL DEFAULT '[]',   -- JSON tool names allowed for the rest of this chat
  folder     TEXT,                         -- the chat's workspace folder (chats/…): uploads and files made for it
  archived   INTEGER NOT NULL DEFAULT 0,   -- hidden from the chat list
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  role         TEXT NOT NULL,              -- user | assistant | tool
  content      TEXT NOT NULL,
  tool_calls   TEXT,                       -- JSON, assistant only
  tool_call_id TEXT,
  name         TEXT,
  brain        TEXT,                       -- assistant only: the brain that wrote it (a chat can switch brains)
  agent        TEXT,                       -- assistant: who wrote it; user: who it was addressed to (@mention)
  turn         INTEGER,                    -- assistant/tool: the run it's part of (id of the message that started it)
  archived     INTEGER,                    -- set when an edit replaced this part of the chat: the edited message's id
  edit_of      INTEGER,                    -- on an edited message: the message it replaced
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  session_id TEXT,
  task_id    INTEGER,
  turn       INTEGER,                     -- id of the user message that started this turn
  agent      TEXT,                        -- who was working
  type       TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);

CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued', -- queued | running | waiting (for your approval) | done | failed | cancelled
  agent      TEXT,                           -- null → routed by settings.routing
  brain      TEXT,                           -- per-task override of the agent's brain
  parent_id  INTEGER REFERENCES tasks(id),
  session_id TEXT,
  result     TEXT,
  private    INTEGER NOT NULL DEFAULT 0,
  report_to  TEXT,                           -- session the result is posted to when it finishes (the chat that asked)
  requested_by TEXT,                         -- agent that started it from report_to: woken up when the report arrives
  job_id     INTEGER,                        -- the schedule that started it
  run_at     TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(status, run_at);

-- Knowledge index: everything ingested (mail, PDFs, files) ends up here.
CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,                -- "mail:work", "files:docs"
  external_id TEXT NOT NULL,                -- message-id, file path
  title       TEXT,
  author      TEXT,
  date        TEXT,
  mime        TEXT,
  hash        TEXT,
  summary     TEXT,                         -- written by the local ingest brain
  tags        TEXT,
  content     TEXT NOT NULL,
  parent_id   INTEGER REFERENCES documents(id), -- attachment → its mail
  private     INTEGER NOT NULL DEFAULT 0,   -- 1 = never shown to a cloud brain (source default, or set per file)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, external_id)
);

CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  text        TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

-- Privacy set on a file before (or regardless of) ingest: wins over the source's default. Key = documents' key.
CREATE TABLE IF NOT EXISTS file_flags (
  source      TEXT NOT NULL,
  external_id TEXT NOT NULL,
  private     INTEGER NOT NULL,
  PRIMARY KEY (source, external_id)
);

-- Jobs: recurring work. Each time a job is due, the worker queues a task for it; the result goes to report_to.
CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  schedule   TEXT NOT NULL,                  -- cron "0 10 * * *" (owner's timezone) or "every 2h"
  agent      TEXT,
  brain      TEXT,
  report_to  TEXT,                           -- session that gets each result (usually Home)
  enabled    INTEGER NOT NULL DEFAULT 1,
  next_run   TEXT,                           -- UTC
  last_run   TEXT,
  last_task  INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Workspace files or folders you made public: a permanent link with a random id (/p/<id>/…), no login needed.
CREATE TABLE IF NOT EXISTS public_links (
  id         TEXT PRIMARY KEY,                 -- random, unguessable
  path       TEXT NOT NULL UNIQUE,             -- workspace-relative file or folder
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
