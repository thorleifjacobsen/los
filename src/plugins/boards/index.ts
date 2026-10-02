// Boards (kanban) for the team: any agent can keep a board, add and find cards, comment, and hand cards to the user
// or a teammate. The rules (who may move cards, the agent queue, pass limits) live in core/boards.ts.
import type { App } from "../../app.js";
import { definePlugin, defineTool, z } from "../../tools/define.js";
import {
  SCHEMA, ME, addCard, boardsContext, cardText, columnsOf, createBoard, getBoard, getCard, parseColumns, updateBoard, updateCard,
  type BoardRow, type CardRow,
} from "../../core/boards.js";

const brief = (c: CardRow) => ({
  id: c.id, board: c.board_id, column: c.col, title: c.title, key: c.key ?? undefined, assignee: c.assignee ?? undefined,
  link: c.link ?? undefined, priority: c.priority || undefined, tags: JSON.parse(c.tags).length ? JSON.parse(c.tags) : undefined, updated: c.updated_at,
});
const assignee = z.string().describe('"me" for the user, a teammate\'s handle, or "" for nobody');

export default (app: App) => definePlugin({
  name: "boards",
  description: "Kanban boards for the user and the team: lists of cards (leads, bugs, ideas, things to check) with columns, assignees and history",
  schema: SCHEMA,
  context: ({ agent }) => (agent ? boardsContext(app, agent) : undefined),
  tools: [
    defineTool({
      name: "boards_list",
      description: "List the kanban boards: columns (done columns marked), card counts, owner, whether agents may move cards",
      tags: ["kanban", "board", "cards", "list", "pipeline", "backlog"],
      schema: z.object({}),
      run: async (_, { db }) => (db.prepare("SELECT * FROM boards ORDER BY id").all() as BoardRow[]).map((b) => {
        const counts = Object.fromEntries((db.prepare("SELECT col, count(*) n FROM cards WHERE board_id = ? GROUP BY col").all(b.id) as any[]).map((r) => [r.col, r.n]));
        return { id: b.id, name: b.name, description: b.description ?? undefined, owner: b.owner ?? undefined, agents_can_move: !!b.agents_move,
          columns: columnsOf(b).map((c) => ({ name: c.name, done: c.done || undefined, cards: counts[c.name] ?? 0 })) };
      }),
    }),
    defineTool({
      name: "boards_create",
      description: "Create a kanban board you own (you'll see it in every prompt). Columns in order; mark finished ones as done " +
        "(e.g. [\"New\", \"In progress\", \"Done (done)\"]). Make one only when the user wants a board or a job clearly needs one.",
      tags: ["kanban", "board", "create", "pipeline"],
      schema: z.object({
        name: z.string(),
        description: z.string().optional(),
        columns: z.array(z.string()).min(1).describe('Column names in order; add " (done)" to finished ones'),
        agents_can_move: z.boolean().optional().describe("Let agents move cards between columns (default true; false locks it to the user)"),
      }),
      run: async ({ name, description, columns, agents_can_move }, ctx) => {
        const id = createBoard(ctx.db, { name, description, columns: parseColumns(columns), owner: ctx.agent.name, agentsMove: agents_can_move });
        return `Created board "${name}" (#${id}).`;
      },
    }),
    defineTool({
      name: "boards_update",
      description: "Rename a board, change its description, or change its columns (the full list in order; add \" (done)\" " +
        "to finished ones). A column that still has cards can't be removed: move its cards first.",
      tags: ["kanban", "board", "rename", "columns", "edit"],
      schema: z.object({
        board: z.string().describe("Board name or id"),
        name: z.string().optional(),
        description: z.string().optional(),
        columns: z.array(z.string()).min(1).optional(),
      }),
      run: async ({ board, name, description, columns }, ctx) => {
        const b = updateBoard(ctx.db, board, { name, description, columns: columns ? parseColumns(columns) : undefined });
        return `Board "${b.name}" (#${b.id}): ${columnsOf(b).map((c) => c.name + (c.done ? " (done)" : "")).join(", ")}.`;
      },
    }),
    defineTool({
      name: "cards_find",
      description: "Find cards: by key (\"have I seen this before?\", e.g. a domain), by text, column or assignee. " +
        "Cards in done columns are included only with include_done.",
      tags: ["kanban", "card", "search", "find", "lead", "dedupe", "seen"],
      schema: z.object({
        board: z.string().optional().describe("Board name or id (default: all boards)"),
        key: z.string().optional(),
        query: z.string().optional().describe("Words in the title, body or link"),
        column: z.string().optional(),
        assignee: assignee.optional(),
        include_done: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      run: async ({ board, key, query, column, assignee, include_done, limit = 30 }, { db }) => {
        const where: string[] = [], vals: unknown[] = [];
        if (board) { where.push("board_id = ?"); vals.push(getBoard(db, board).id); }
        if (key) { where.push("key = ?"); vals.push(key.trim().toLowerCase()); }
        if (query) for (const w of query.split(/\s+/).filter(Boolean)) { where.push("(title || ' ' || coalesce(body, '') || ' ' || coalesce(link, '') || ' ' || coalesce(key, '')) LIKE ?"); vals.push(`%${w}%`); }
        if (column) { where.push("lower(col) = lower(?)"); vals.push(column); }
        if (assignee !== undefined) { where.push(assignee ? "assignee = ?" : "assignee IS NULL"); if (assignee) vals.push(assignee); }
        let rows = db.prepare(`SELECT * FROM cards ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT 300`).all(...vals) as CardRow[];
        if (!include_done && !key) {
          const done = new Map((db.prepare("SELECT * FROM boards").all() as BoardRow[]).map((b) => [b.id, columnsOf(b).filter((c) => c.done).map((c) => c.name)]));
          rows = rows.filter((c) => !done.get(c.board_id)?.includes(c.col));
        }
        return rows.length ? rows.slice(0, limit).map(brief) : "No cards match.";
      },
    }),
    defineTool({
      name: "cards_get",
      description: "A card in full: fields, text and its whole history (who moved, assigned, commented)",
      tags: ["kanban", "card", "read", "history"],
      schema: z.object({ id: z.number().int() }),
      run: async ({ id }, { db }) => { const c = getCard(db, id); return cardText(app, c, getBoard(db, c.board_id), 200); },
    }),
    defineTool({
      name: "cards_add",
      description: "Add a card to a board. Give a key (e.g. the domain) when the same thing must never be added twice: a card " +
        "with that key already there is refused and shown. Column defaults to the first. assignee: \"me\" puts it in the " +
        "user's \"needs you\" list; a teammate's handle queues it for them (they do it when they have time).",
      tags: ["kanban", "card", "add", "lead", "todo", "backlog", "assign"],
      schema: z.object({
        board: z.string().describe("Board name or id"),
        title: z.string(),
        body: z.string().optional().describe("Markdown: details, findings, links, ![screenshot](/files/…)"),
        link: z.string().optional(),
        image: z.string().optional().describe("/files/… or https:// picture shown on the card"),
        tags: z.array(z.string()).optional(),
        key: z.string().optional().describe("Dedupe key within the board, e.g. example.no"),
        column: z.string().optional(),
        assignee: assignee.optional(),
        priority: z.number().int().min(0).max(2).optional().describe("0 normal, 1 high, 2 urgent"),
      }),
      run: async ({ board, assignee, ...c }, ctx) => {
        const id = addCard(app, board, { ...c, assignee: assignee || null }, ctx.agent.name);
        return `Added card #${id} to "${getBoard(ctx.db, board).name}".`;
      },
    }),
    defineTool({
      name: "cards_update",
      description: "Change a card: comment on it, edit fields, move it to another column (unless the user locked the " +
        "board), or hand it on: assignee \"me\" when you need the user's decision or input, a teammate's handle when " +
        "they should do the next part (find them with team_find). Handing on needs a comment saying why and what's needed.",
      tags: ["kanban", "card", "update", "move", "assign", "comment", "handoff"],
      schema: z.object({
        id: z.number().int(),
        comment: z.string().optional(),
        column: z.string().optional(),
        assignee: assignee.optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        link: z.string().optional(),
        image: z.string().optional(),
        tags: z.array(z.string()).optional(),
        priority: z.number().int().min(0).max(2).optional(),
      }),
      run: async ({ id, assignee, ...p }, ctx) => {
        const c = updateCard(app, id, { ...p, ...(assignee !== undefined ? { assignee: assignee || null } : {}) }, ctx.agent.name);
        return `Card #${c.id}: ${c.col}, assigned to ${c.assignee === ME ? "the user" : c.assignee ?? "nobody"}.`;
      },
    }),
  ],
});
