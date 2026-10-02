// End-to-end smoke test with a fake OpenAI-compatible server standing in for Ollama / a cloud model.
// Exercises the real adapters, loop, tool_search, privacy guard, approvals, ingestion, search and the task worker.
import { createServer } from "node:http";
import { mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { loadSettings } from "../src/config.js";
import { createApp } from "../src/app.js";
import { runAgent } from "../src/core/loop.js";
import { createSession, getSession } from "../src/core/session.js";
import { syncSource } from "../src/connectors/index.js";
import { search } from "../src/knowledge/search.js";
import { createTask } from "../src/tasks/queue.js";
import { workLoop, scheduleDue } from "../src/tasks/worker.js";
import { bus } from "../src/core/events.js";

// ── fake LLM server ──
type Req = { path: string; body: any };
const requests: Req[] = [];
let script: ((body: any) => any)[] = [];
const say = (text: string) => () => ({ content: text });
const call = (name: string, args: object) => () => ({ content: "", tool_calls: [{ id: `c${Math.random()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const sse = (...chunks: string[]) => () => ({ sse: chunks }); // answered as a server-sent event stream

const DIM = 16;
const fakeEmbed = (s: string) => {
  const v = new Array(DIM).fill(0);
  for (const w of s.toLowerCase().match(/[\p{L}]+/gu) ?? []) v[[...w].reduce((h, c) => h + c.charCodeAt(0), 0) % DIM] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

const server = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw || "{}");
  requests.push({ path: req.url!, body });
  res.setHeader("content-type", "application/json");
  if (req.url!.endsWith("/embeddings"))
    return res.end(JSON.stringify({ data: body.input.map((t: string) => ({ embedding: fakeEmbed(t) })) }));
  // enrichment calls have no tools and an "index documents" system prompt
  if (body.messages[0].content.startsWith("You index documents"))
    return res.end(JSON.stringify({ choices: [{ message: { content: '{"summary":"Faktura fra Arendal Elektro for landstrøm.","tags":["faktura","landstrøm"]}' } }] }));
  const next = script.shift();
  if (!next) { res.statusCode = 500; return res.end("script exhausted"); }
  const out = next(body);
  if (out.sse && body.stream) {
    res.setHeader("content-type", "text/event-stream");
    for (const t of out.sse) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
    return res.end("data: [DONE]\n\n");
  }
  res.end(JSON.stringify({ choices: [{ message: out }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
});
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;

// ── isolated app ──
const root = mkdtempSync(join(tmpdir(), "los-test-"));
cpSync("config", join(root, "config"), { recursive: true });
cpSync("test/fixtures", join(root, "data/workspace"), { recursive: true });
const settings = loadSettings(root);
settings.brains = {
  local: { type: "openai", base_url: base, model: "fake-local", local: true },
  "local-small": { type: "openai", base_url: base, model: "fake-small", local: true },
  claude: { type: "openai", base_url: base, model: "fake-cloud" }, // cloud: local not set
};
// The test exercises the native loop: point the agents at the fake brains instead of claude-code.
settings.agents.los.brain = "local";
// API brains start with an agent's `tools` (all, by default); the test pins small sets to exercise tool_search.
settings.agents.los.tools = ["memory_*", "todos_*", "plan_*", "jobs_*", "tasks_*", "team_*", "web_search", "web_fetch"];
settings.agents.mira.tools = ["web_search", "web_fetch", "plan_*"];
settings.agents.mira.brain = "claude";
settings.ingest = { brain: "local-small", enrich: true };
settings.embeddings = { brain: "local", model: "fake-embed", dim: DIM };
settings.web = {};
settings.sources[0].private = true; // the fixtures are mail and invoices: private by default, like a mail source
const app = await createApp({ settings, mcp: false });
const toolsSent = () => requests.at(-1)!.body.tools?.map((t: any) => t.function.name) ?? [];
const ok = (msg: string) => console.log(`✓ ${msg}`);

// 1. Ingest: PDF, mail with PDF attachment, markdown — with local enrichment + embeddings
const stats = await syncSource(app, settings.sources[0], () => {});
assert.equal(stats.added, 4); // pdf, mail, mail's attachment, md
const mail = app.db.prepare("SELECT * FROM documents WHERE mime = 'email'").get() as any;
assert.match(mail.summary, /Arendal Elektro/);
assert.equal((app.db.prepare("SELECT count(*) n FROM documents WHERE parent_id = ?").get(mail.id) as any).n, 1);
assert.equal((await syncSource(app, settings.sources[0], () => {})).skipped, 3); // unchanged mail → its attachment is skipped too
ok("ingest: pdf + mail + attachment + md, local summaries, idempotent re-sync");

const hits = await search(app, "faktura landstrøm");
assert.ok(hits.length >= 2 && hits.some((h) => h.title === "Faktura for landstrom"));
const flytebrygge = await search(app, "flytebrygge budsjett");
assert.equal(flytebrygge[0].title, "referat.md");
ok(`hybrid search: ${hits.map((h) => h.title).join(" | ")}`);

// 2. Local assistant: starts small, loads knowledge tools via tool_search, answers
const assistant = settings.agents.los;
const s1 = createSession(app.db, "los");
script = [
  call("tool_search", { query: "find invoice in mail" }),
  call("knowledge_search", { query: "faktura landstrøm" }),
  say("Fakturaen fra Arendal Elektro er på 18 450 NOK, forfall 15. oktober."),
];
const answer = await runAgent(app, { sessionId: s1, agent: assistant, input: "Har jeg fått en faktura for landstrøm?" });
assert.match(answer, /18 450/);
const firstTools = requests.filter((r) => r.body.model === "fake-local" && r.body.tools).at(-3)!.body.tools.map((t: any) => t.function.name);
assert.ok(firstTools.includes("tool_search") && !firstTools.includes("knowledge_search"), "starts without knowledge tools");
assert.ok(firstTools.length < app.registry.tools.size, "does not get every tool");
assert.ok(toolsSent().includes("knowledge_search"), "knowledge_search loaded after tool_search");
assert.equal(getSession(app.db, s1)!.private, 1);
ok(`tool_search: started with ${firstTools.length}/${app.registry.tools.size} tools, loaded knowledge_* on demand; session marked private`);

// 3. Privacy: that session can't continue on a cloud brain
await assert.rejects(runAgent(app, { sessionId: s1, agent: assistant, brain: "claude", input: "fortsett" }), /private data/);
ok("privacy: private session refused on cloud brain");

// 4. Cloud brain: the knowledge tools exist, but private documents are left out of everything it gets
const s2 = createSession(app.db, "los");
script = [call("tool_search", { query: "search mail invoice pdf" }), call("knowledge_search", { query: "faktura landstrøm" }),
  call("knowledge_read", { doc_id: mail.id }), say("Jeg fant ingenting.")];
await runAgent(app, { sessionId: s2, agent: assistant, brain: "claude", input: "Finn fakturaen i mailen min" });
const results = app.db.prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'tool'").all(s2) as any[];
assert.equal(results[1].content, "[]");
assert.match(results[2].content, /no such document/);
assert.ok(!requests.filter((r) => r.body.model === "fake-cloud").some((r) => JSON.stringify(r.body).includes("18 450")), "no private data sent to cloud");
assert.equal(getSession(app.db, s2)!.private, 0);
// One document made public: now the cloud brain finds it, and only it.
app.db.prepare("UPDATE documents SET private = 0 WHERE external_id = 'referat.md'").run();
script = [call("knowledge_search", { query: "flytebrygge budsjett faktura" }), say("ok")];
await runAgent(app, { sessionId: s2, agent: assistant, brain: "claude", input: "og referatet?" });
const found = JSON.parse((app.db.prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'tool' ORDER BY id DESC").get(s2) as any).content);
assert.deepEqual(found.map((h: any) => h.title), ["referat.md"]);
ok("privacy: cloud brain sees public documents only, private ones are invisible (search, read)");

// 4b. Memories: public ones are in every system prompt, private ones never reach a cloud brain
app.db.prepare("INSERT INTO memories (text, private) VALUES ('Båten heter Måke', 0), ('Bank-PIN er 4711', 1)").run();
const m1 = createSession(app.db, "los");
script = [call("memory_search", { query: "PIN Måke" }), say("ok")];
await runAgent(app, { sessionId: m1, agent: { ...assistant, tools: ["memory_*"] }, brain: "claude", input: "hva vet du?" });
const cloudReqs = JSON.stringify(requests.filter((r) => r.body.model === "fake-cloud").slice(-2));
assert.match(requests.at(-1)!.body.messages[0].content, /Båten heter Måke/);
assert.ok(!cloudReqs.includes("4711"), "private memory never sent to cloud");
script = [call("memory_search", { query: "PIN" }), say("ok")];
const m2 = createSession(app.db, "los");
await runAgent(app, { sessionId: m2, agent: { ...assistant, tools: ["memory_*"] }, input: "pin?" });
assert.match(JSON.stringify(requests.at(-1)!.body.messages), /4711/);
assert.equal(getSession(app.db, m2)!.private, 1);
ok("privacy: public memories in the prompt, private ones only for local brains (and that taints the chat)");

// 5. Approval: side-effect tools denied without a human, allowed with one
const s3 = createSession(app.db, "los");
script = [call("todos_add", { text: "Betal faktura Arendal Elektro", due: "2026-10-15" }), call("todos_remove", { id: 1 }), say("ok")];
await runAgent(app, { sessionId: s3, agent: assistant, input: "legg til og fjern" });
assert.equal((app.db.prepare("SELECT count(*) n FROM todos").get() as any).n, 1);
script = [call("todos_remove", { id: 1 }), say("fjernet")];
await runAgent(app, { sessionId: s3, agent: assistant, input: "fjern den", approve: async () => true });
assert.equal((app.db.prepare("SELECT count(*) n FROM todos").get() as any).n, 0);
ok("approvals: todos_remove denied without approval, runs with it");
// Bypass on a chat: no approver needed there, logged as a bypass approval; another chat still asks.
script = [call("todos_add", { text: "Bypass-test" }), say("ok")];
await runAgent(app, { sessionId: s3, agent: assistant, input: "legg til" });
app.db.prepare("UPDATE sessions SET bypass = 1 WHERE id = ?").run(s3);
script = [call("todos_remove", { id: (app.db.prepare("SELECT max(id) id FROM todos").get() as any).id }), say("fjernet")];
await runAgent(app, { sessionId: s3, agent: assistant, input: "fjern den" });
assert.equal((app.db.prepare("SELECT count(*) n FROM todos").get() as any).n, 0, "bypass: ran without an approver");
assert.ok(app.db.prepare("SELECT 1 FROM events WHERE session_id = ? AND type = 'approval' AND json_extract(data, '$.bypass') = 1").get(s3), "bypass is logged");
const s3b = createSession(app.db, "los");
script = [call("todos_add", { text: "Bypass-test 2" }), say("ok")];
await runAgent(app, { sessionId: s3b, agent: assistant, input: "legg til" });
script = [call("todos_remove", { id: (app.db.prepare("SELECT max(id) id FROM todos").get() as any).id }), say("ok")];
await runAgent(app, { sessionId: s3b, agent: assistant, input: "fjern" });
assert.equal((app.db.prepare("SELECT count(*) n FROM todos").get() as any).n, 1, "no bypass in another chat");
app.db.prepare("DELETE FROM todos").run();
ok("bypass: a chat with bypass runs side-effect tools without asking (logged), other chats still ask");

// 6. Plan is injected into the system prompt on every step
const s4 = createSession(app.db, "los");
script = [call("plan_set", { steps: ["Les mail", "Lag todos"] }), call("plan_update", { step: 1, status: "done" }), say("ferdig")];
await runAgent(app, { sessionId: s4, agent: assistant, input: "planlegg" });
assert.match(requests.at(-1)!.body.messages[0].content, /\[x\] 1\. Les mail\n\[ \] 2\. Lag todos/);
ok("plan: working memory shown back to the agent each step");

// 7. Autonomous task: routed agent + per-task brain override, private result hidden from cloud agents
const t1 = createTask(app.db, { title: "Triage mail", prompt: "Gå gjennom ny mail", agent: "vera", brain: "local-small" });
script = [call("knowledge_search", { query: "faktura" }), say("1 faktura: Arendal Elektro 18 450 NOK")];
await workLoop(app, { once: true, log: () => {} });
const task = app.db.prepare("SELECT * FROM tasks WHERE id = ?").get(t1) as any;
assert.equal(task.status, "done");
assert.equal(task.private, 1);
assert.equal(requests.filter((r) => r.body.model === "fake-small" && r.body.tools).length, 2, "ran on the per-task brain");
const t2 = createTask(app.db, { title: "Fix the parser bug in the repo", prompt: "x" });
assert.equal((await import("../src/tasks/queue.js")).route(settings, { agent: null, title: "Fix the parser bug in the repo", prompt: "x" }), "finn");
app.db.prepare("DELETE FROM tasks WHERE id = ?").run(t2);
const s5 = createSession(app.db, "mira");
script = [call("tool_search", { query: "delegate task result" }), call("tasks_get", { id: t1 }), say("skjult")];
await runAgent(app, { sessionId: s5, agent: settings.agents.mira, input: "hva ble resultatet?" });
const hidden = (app.db.prepare("SELECT content FROM messages WHERE session_id = ? AND name = 'tasks_get'").get(s5) as any).content;
assert.match(hidden, /hidden: private result/);
ok("tasks: per-task brain, routing rules, private results hidden from cloud agents");

// 8. Jobs: an agent creates one in Home, the scheduler fires it, a worker runs it, the report lands in Home
const home = createSession(app.db, "los", "Home");
script = [call("jobs_create", { title: "Morgensjekk", prompt: "Si god morgen.", schedule: "0 7 * * *", agent: "los" }), say("Satt opp.")];
await runAgent(app, { sessionId: home, agent: assistant, input: "Si god morgen hver dag kl 7" });
const job = app.db.prepare("SELECT * FROM jobs").get() as any;
assert.equal(job.report_to, home);
assert.match(job.next_run, / 0[56]:00:00$/); // 07:00 in Oslo, summer or winter time
scheduleDue(app, new Date(new Date(job.next_run.replace(" ", "T") + "Z").getTime() + 1000));
script = [say("God morgen! Sol hele dagen.")];
await workLoop(app, { once: true, log: () => {} });
const posted = app.db.prepare("SELECT content FROM messages WHERE session_id = ? AND name = 'report'").get(home) as any;
assert.match(posted.content, /Scheduled job "Morgensjekk" finished[\s\S]*God morgen! Sol hele dagen/);
assert.ok((app.db.prepare("SELECT next_run FROM jobs").get() as any).next_run > job.next_run, "moved on to the next day");
// The next turn in Home sees the report.
script = [say("ok")];
await runAgent(app, { sessionId: home, agent: assistant, input: "hva sa jobben?" });
assert.match(JSON.stringify(requests.at(-1)!.body.messages), /Sol hele dagen/);
ok("jobs: agent creates a job, the scheduler fires it, a worker runs it, the report lands in Home and is seen next turn");

// 9. Streaming: SSE from an OpenAI-compatible server → live deltas, same final message
const deltas: string[] = [];
bus.on("delta", (d) => d.text && deltas.push(d.text));
const s9 = createSession(app.db, "los");
script = [sse("Hei ", "på ", "deg!")];
assert.equal(await runAgent(app, { sessionId: s9, agent: assistant, input: "hei" }), "Hei på deg!");
assert.equal(deltas.join(""), "Hei på deg!");
ok("streaming: tokens arrive live over SSE, the stored answer is the same");

// 10. Rooms: @mention picks who answers, other agents' messages are marked as theirs; team_find; private access
const { addressees, mentions, saveMessage } = await import("../src/core/session.js");
const { rankAgents } = await import("../src/plugins/team/index.js");
const teamList = Object.values(settings.agents);
assert.deepEqual(addressees("hei @mira, kan du sjekke", teamList, "los").handles, ["mira"]);
assert.deepEqual(addressees("@Mira og @finn hva tror dere?", teamList, "los").handles, ["mira", "finn"]);
assert.deepEqual(addressees("ingen nevnt her", teamList, "los").handles, ["los"]);
assert.equal(addressees("@team hva synes dere?", teamList, "los").handles.length, teamList.length);
assert.deepEqual(mentions("Fint. `@finn` i kode teller ikke\n> @finn sa noe\n@Finn, bygg den", teamList, "los").handles, ["finn"]);
assert.deepEqual(mentions("@los er meg selv", teamList, "los").handles, [], "an agent doesn't hand off to itself");
assert.deepEqual(mentions("It's a cat (from Ollie @ollie). Thanks, Mira (@mira)! @finn, save it.", teamList, "los").handles, ["finn"], "credits aren't requests");
assert.deepEqual(mentions("I saved the file for Finn (@finn can build the site once he has this).", teamList, "mira").handles, ["finn"], "a mention inside brackets is still a mention");
// A chat: Los answers with a tool call and hands off; Mira sees Los's words, not his tool call or its result.
const chatId = createSession(app.db, "los", "test-chat");
const t1msg = saveMessage(app.db, chatId, { role: "user", content: "hei, finn ut noe" }, { agent: "los" });
script = [call("memory_search", { query: "HEMMELIG-VERKTØY" }), say("@mira, kan du sjekke dette?")];
await runAgent(app, { sessionId: chatId, agent: assistant, turn: t1msg });
const handoff = saveMessage(app.db, chatId, { role: "user", content: "Los (@los) mentioned you in their message above." }, { agent: "mira", name: "handoff" });
script = [say("Mira her.")];
await runAgent(app, { sessionId: chatId, agent: settings.agents.mira, turn: handoff });
const seen = JSON.stringify(requests.at(-1)!.body.messages);
assert.match(seen, /\[Los \(@los\) said:\]\\n@mira, kan du sjekke/);
assert.doesNotMatch(seen, /HEMMELIG-VERKTØY/, "another agent's tool calls aren't sent");
assert.match(requests.at(-1)!.body.messages[0].content, /You are Mira \(@mira\)[\s\S]*This turn: Los \(@los\) mentioned you/);
// Los's next turn: his earlier tool call and its result aren't sent again, only what was said.
script = [say("Ok.")];
const t2msg = saveMessage(app.db, chatId, { role: "user", content: "takk" }, { agent: "los" });
await runAgent(app, { sessionId: chatId, agent: assistant, turn: t2msg });
const next = JSON.stringify(requests.at(-1)!.body.messages.slice(1)); // the conversation, not the system prompt
assert.doesNotMatch(next, /HEMMELIG-VERKTØY|memory_search/, "earlier turns' tool calls aren't re-sent");
assert.match(next, /@mira, kan du sjekke dette\?/);
const turns = app.db.prepare("SELECT DISTINCT turn, agent FROM messages WHERE session_id = ? AND role = 'assistant' AND turn < ?").all(chatId, t2msg) as any[];
assert.deepEqual(turns.map((t) => [t.turn, t.agent]), [[t1msg, "los"], [handoff, "mira"]]);
assert.equal(rankAgents(teamList, "Build a website for the boat club")[0].agent.name, "finn");
const granted = { ...assistant, brain: "claude", privateAccess: true, tools: ["memory_*"] };
const pg = createSession(app.db, "los");
script = [call("memory_search", { query: "PIN" }), say("ok")];
await runAgent(app, { sessionId: pg, agent: granted, input: "pin?" });
assert.match(JSON.stringify(requests.at(-1)!.body.messages), /4711/, "granted agent reads private memory on a cloud brain");
ok("chats: @mentions (and @team) pick who answers, handoffs get their own turn, others' tool calls (and your own from earlier turns) stay out of an agent's view, private access can be granted");

// 11. Limits, full results, cancel: a tool result is stored whole but sent cut (result_read reads on); over budget the
// agent's calls are answered with "write up now" and it gets no tools; a cancelled task reports no result and wakes nobody.
const { writeFileSync } = await import("node:fs");
writeFileSync(join(root, "data/workspace/big.txt"), "x".repeat(60_000) + "SLUTT");
const reader = { ...assistant, tools: ["files_read"], maxSteps: 3 };
const lim = createSession(app.db, "los");
script = [call("files_read", { path: "big.txt" }), call("result_read", { call_id: "?", offset: 0 }), call("files_read", { path: "big.txt" }), call("files_read", { path: "big.txt" }), say("Oppsummert.")];
assert.equal(await runAgent(app, { sessionId: lim, agent: reader, input: "les big.txt" }), "Oppsummert.");
const stored = app.db.prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'tool' ORDER BY id").all(lim) as any[];
assert.ok(stored[0].content.length > 60_000 && stored[0].content.includes("SLUTT"), "tool result stored in full");
assert.match(JSON.stringify(requests.at(-3)!.body.messages), /cut at 50000 of \d+ chars\. Read on with result_read/);
assert.match(stored.at(-1).content, /reached your limit for this turn \(3 tool calls\)/, "the call over budget wasn't run");
assert.equal(requests.at(-1)!.body.tools, undefined, "no tools offered once over budget");
const callId = JSON.parse((app.db.prepare("SELECT tool_calls FROM messages WHERE session_id = ? AND tool_calls IS NOT NULL ORDER BY id").get(lim) as any).tool_calls)[0].id;
const rest = await app.registry.get("result_read")!.run({ call_id: callId, offset: 50_000 }, { db: app.db, sessionId: lim } as any) as string;
assert.match(rest, /SLUTT/);
const { report } = await import("../src/tasks/worker.js");
const tc = createTask(app.db, { title: "Avbrutt", prompt: "x", agent: "mira", reportTo: home });
app.db.prepare("UPDATE tasks SET status = 'cancelled', result = 'Let me try fetching' WHERE id = ?").run(tc);
let woke = false;
bus.on("wake", () => { woke = true; });
report(app, tc);
const cancelled = (app.db.prepare("SELECT content FROM messages WHERE session_id = ? AND name = 'report' ORDER BY id DESC").get(home) as any).content;
assert.match(cancelled, /was cancelled/);
assert.doesNotMatch(cancelled, /Let me try/);
assert.ok(!woke, "a cancelled task wakes nobody");
ok("limits: results stored whole and sent cut (result_read reads on), budget ends in a write-up, cancelled tasks report no result and wake nobody");

// 12. Context export = what was really sent; the size budget drops old messages, never the current turn.
const { requestContext } = await import("../src/core/loop.js");
const { compact } = await import("../src/core/context.js");
const cx = createSession(app.db, "los", "export-test");
script = [say("Første svar.")];
await runAgent(app, { sessionId: cx, agent: assistant, input: "første" });
script = [call("plan_set", { steps: ["a", "b", "c"] }), say("Andre svar.")];
const cxTurn = saveMessage(app.db, cx, { role: "user", content: "andre" }, { agent: "los" });
await runAgent(app, { sessionId: cx, agent: assistant, turn: cxTurn });
const sent = requests.at(-1)!.body;
const rebuilt = requestContext(app, cx, cxTurn, "los");
assert.deepEqual(rebuilt.messages, sent.messages, "the export is exactly what the brain got");
assert.deepEqual(rebuilt.tools.map((t: any) => t.function.name).sort(), sent.tools.map((t: any) => t.function.name).sort());
assert.equal(rebuilt.los.steps, 2);
const first = requestContext(app, cx, cxTurn, "los", 0);
assert.deepEqual(first.messages, requests.at(-2)!.body.messages, "any step can be exported");
const long = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(1000) + i }) as any);
const squeezed = compact([...long, { role: "user", content: "nå" }], 5000);
assert.ok(squeezed.reduce((n, m) => n + m.content.length, 0) < 7000 && squeezed.at(-1)!.content === "nå" && /left out/.test(squeezed[0].content));
ok("context: the export rebuilds exactly what each step sent; over budget, old messages are left out, never the current turn");

// 13. Public links: a published folder serves what's inside it (not outside), private wins, links survive a move.
const ws = await import("../src/core/workspace.js");
const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
mk(join(root, "data/workspace/site/img"), { recursive: true });
wf(join(root, "data/workspace/site/index.html"), "<h1>hei</h1>");
wf(join(root, "data/workspace/site/img/a.txt"), "a");
wf(join(root, "data/workspace/hemmelig.txt"), "x");
const url = ws.setShared(app, "site", true)!;
const id = /\/s\/([\w-]+)\//.exec(url)![1];
assert.ok(id.length >= 20, "random, unguessable id");
assert.equal(ws.setShared(app, "site", true), url, "publishing twice gives the same link");
assert.equal(ws.resolveShared(app, id, ""), "site");
assert.equal(ws.resolveShared(app, id, "img/a.txt"), "site/img/a.txt");
assert.equal(ws.resolveShared(app, id, "../hemmelig.txt"), null, "can't climb out of the published folder");
assert.equal(ws.resolveShared(app, "nope", ""), null);
app.db.prepare("INSERT INTO file_flags (source, external_id, private) VALUES ('workspace', 'site/img', 1)").run();
assert.equal(ws.resolveShared(app, id, "img/a.txt"), null, "private wins inside a public folder");
assert.throws(() => ws.setShared(app, "site/img/a.txt", true), /private/);
ws.moveShared(app.db, "site", "nettside");
const { renameSync } = await import("node:fs");
renameSync(join(root, "data/workspace/site"), join(root, "data/workspace/nettside"));
assert.equal(ws.resolveShared(app, id, "index.html"), "nettside/index.html", "the link survives a move");
assert.equal(ws.setShared(app, "nettside", false), null);
assert.equal(ws.resolveShared(app, id, ""), null, "unpublished: the link is dead");
assert.ok(app.registry.needsApproval(assistant, "files_share"), "publishing asks first");
// Viewing links (yours, not shared): only their scope, only until they expire, can't be forged.
const { createAuth, writeAuthFile } = await import("../src/web/auth.js");
writeAuthFile(join(root, "data/auth.json"), "toffe", "pw-123456");
const au = createAuth(join(root, "data/auth.json"));
const tok = au.viewToken("nettside");
assert.equal(au.viewScope(tok), "nettside");
assert.equal(au.viewScope(tok.replace(/.$/, (c) => (c === "A" ? "B" : "A"))), null, "a tampered link doesn't open anything");
const [e0, , s0] = tok.split(".");
assert.equal(au.viewScope(`${e0}.${Buffer.from("").toString("base64url")}.${s0}`), null, "the scope can't be swapped");
assert.equal(au.viewScope(au.viewToken("nettside", -1000)), null, "an expired link doesn't open anything");
ok("share links: random permanent ids, confined to what was shared, private wins, survive moves, approval to share; viewing links are scoped and expire");

// 14. Images: image_view loads a workspace image; the log keeps a note, the picture travels as a marker → image.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
wf(join(root, "data/workspace/dot.png"), png);
wf(join(root, "data/workspace/notimage.png"), "hello");
const view = app.registry.get("image_view")!;
const shown = await view.run({ source: "/files/dot.png" }, { db: app.db, sessionId: cx, agent: assistant, brainIsLocal: false, workdir: join(root, "data/workspace") } as any) as string;
assert.match(shown, /^Image dot\.png \(image\/png, 0 KB\): ⟦image:[\w-]+⟧$/);
const { takeImages, withoutImages } = await import("../src/core/images.js");
const taken = takeImages(shown);
assert.equal(taken.images.length, 1);
assert.equal(taken.images[0].mime, "image/png");
assert.equal(Buffer.from(taken.images[0].data, "base64").equals(png), true, "the picture itself goes to the brain");
assert.match(withoutImages(shown), /can only read text/, "text-only brains get a note");
await assert.rejects(view.run({ source: "notimage.png" }, { db: app.db, sessionId: cx, agent: assistant, brainIsLocal: false, workdir: "" } as any) as Promise<unknown>, /isn't a PNG/);
ok("images: image_view shows workspace images to brains that can see (marker → image), text-only brains get a note");

// 15. Security + profile: internal addresses are refused, TOTP matches RFC 6238, {{name}} fills, edits archive.
const { isInternalIp, checkPublicUrl } = await import("../src/core/net.js");
for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "100.64.0.1"])
  assert.ok(isInternalIp(ip), `${ip} is internal`);
for (const ip of ["1.1.1.1", "151.101.1.69", "2606:4700::1111"]) assert.ok(!isInternalIp(ip), `${ip} is public`);
for (const u of ["http://localhost:7001/api", "http://browser:9222/json", "http://169.254.169.254/latest", "file:///etc/passwd", "http://[::1]/", "http://nas.local/"])
  assert.throws(() => checkPublicUrl(settings, u), /internal|only http/, `${u} refused`);
assert.equal(checkPublicUrl(settings, "https://example.com/x").host, "example.com");
assert.equal(checkPublicUrl({ ...settings, web: { allow_internal: ["nas.local"] } }, "http://nas.local/x").host, "nas.local", "allow_internal opens a host");
const { totpCode, totpOk } = await import("../src/web/auth.js");
assert.equal(totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1), "287082", "RFC 6238 test vector (T=59s)");
assert.ok(totpOk("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")));
assert.ok(!totpOk("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "000000") || totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ") === "000000");
const { fill } = await import("../src/core/profile.js");
const authPath = join(root, "data/auth.json");
const af = JSON.parse((await import("node:fs")).readFileSync(authPath, "utf8"));
wf(authPath, JSON.stringify({ ...af, displayName: "Kari" }));
assert.equal(fill(app, "Hei {{name}}, it's {{weekday}} in {{timezone}}. {{unknown}}").replace(/\w+day/, "DAY"), "Hei Kari, it's DAY in Europe/Oslo. {{unknown}}");
// Editing: archived messages leave every view, but a past request can still be rebuilt as it was.
const br = createSession(app.db, "los", "branch");
const u1 = saveMessage(app.db, br, { role: "user", content: "gammel melding" }, { agent: "los" });
saveMessage(app.db, br, { role: "assistant", content: "gammelt svar" }, { agent: "los", turn: u1 });
const u2 = saveMessage(app.db, br, { role: "user", content: "ny melding" }, { agent: "los" });
app.db.prepare("UPDATE messages SET archived = ? WHERE session_id = ? AND id >= ? AND id < ?").run(u2, br, u1, u2);
const { chatView } = await import("../src/core/session.js");
assert.deepEqual(chatView(app.db, br, "los", u2).map((m) => m.content), ["ny melding"], "the edit replaces what came before");
assert.deepEqual(chatView(app.db, br, "los", u1, 0, u1 + 1).map((m) => m.content), ["gammel melding", "gammelt svar"], "a request from before the edit rebuilds as it was");
ok("security + profile: internal addresses refused (allow_internal opens), TOTP = RFC 6238, {{name}} fills, edits archive and stay rebuildable");

await app.close();
server.close();
console.log("\nall good");
