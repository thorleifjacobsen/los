// Example plugin — copy this folder to make a new one.
import { definePlugin, defineTool, z } from "../../tools/define.js";

export default definePlugin({
  name: "todos",
  description: "Personal todo list: add, list, complete and remove todos",
  schema: `CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
    due TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  tools: [
    defineTool({
      name: "todos_add",
      description: "Add a todo to the user's list",
      tags: ["task", "reminder"],
      schema: z.object({ text: z.string(), due: z.string().optional().describe("YYYY-MM-DD") }),
      run: async ({ text, due }, { db }) => {
        const r = db.prepare("INSERT INTO todos (text, due) VALUES (?, ?)").run(text, due ?? null);
        return { id: Number(r.lastInsertRowid), text, due };
      },
    }),
    defineTool({
      name: "todos_list",
      description: "List the user's todos (open by default)",
      schema: z.object({ include_done: z.boolean().optional() }),
      run: async ({ include_done }, { db }) =>
        db.prepare(`SELECT id, text, due, done FROM todos ${include_done ? "" : "WHERE done = 0"} ORDER BY due IS NULL, due, id`).all(),
    }),
    defineTool({
      name: "todos_done",
      description: "Mark a todo as done",
      schema: z.object({ id: z.number().int() }),
      run: async ({ id }, { db }) => db.prepare("UPDATE todos SET done = 1 WHERE id = ?").run(id).changes ? "ok" : "no such todo",
    }),
    defineTool({
      name: "todos_remove",
      description: "Delete a todo permanently",
      sideEffect: true,
      schema: z.object({ id: z.number().int() }),
      run: async ({ id }, { db }) => db.prepare("DELETE FROM todos WHERE id = ?").run(id).changes ? "deleted" : "no such todo",
    }),
  ],
});
