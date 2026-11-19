import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyLine, backgroundTaskRows, outputFileOf, parseTaskNotification, plainOutput, readBackgroundTasks, readOutputTail,
  type BackgroundTaskRecord,
} from "./sessionBackgroundTasks.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgtasks-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const SID = "f3c02838-33ed-4ce6-b611-1522d2f0670a";
const TASKS = `/private/tmp/claude-501/-work/${SID}/tasks`;

// Lines as CLI 2.1.325 wrote them (2026-11-16 measurement), trimmed to the fields that matter.
const bashUse = (id: string, input: Record<string, unknown>, at: string) =>
  ({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id, name: "Bash", input }] } });
const bgResult = (id: string, taskId: string, at: string, text: string, extra: Record<string, unknown> = {}) =>
  ({
    type: "user", timestamp: at,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] },
    toolUseResult: { stdout: "", stderr: "", backgroundTaskId: taskId, ...extra },
  });
const written = (taskId: string) =>
  `Command running in background with ID: ${taskId}. Output is being written to: ${TASKS}/${taskId}.output. You will be notified when it completes.`;
const notice = (taskId: string, status: string, summary: string, at: string) => ({
  type: "queue-operation", operation: "enqueue", timestamp: at,
  content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>x</tool-use-id>\n<output-file>${TASKS}/${taskId}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
});

const LINES: unknown[] = [
  bashUse("tu_a", { command: "python3 ticker.py", description: "ticker", run_in_background: true }, "2026-11-16T11:22:40.546Z"),
  bgResult("tu_a", "blg6zxqxg", "2026-11-16T11:22:40.747Z", written("blg6zxqxg")),
  // Ctrl+B: the call has no run_in_background, the result says it was backgrounded by the user.
  bashUse("tu_b", { command: "python3 slow.py", description: "slow fg" }, "2026-11-16T11:25:12.501Z"),
  bgResult("tu_b", "bt3lqqlwx", "2026-11-16T11:25:21.674Z", `Command was manually backgrounded by user with ID: bt3lqqlwx. Output is being written to: ${TASKS}/bt3lqqlwx.output. If it is still running`, { backgroundedByUser: true }),
  { type: "assistant", timestamp: "2026-11-16T11:22:44.332Z", message: { content: [{ type: "tool_use", id: "tu_m", name: "Monitor", input: { command: "tail -f x", description: "watch x", timeout_ms: 50000 } }] } },
  { type: "user", timestamp: "2026-11-16T11:22:44.406Z", message: { content: [{ type: "tool_result", tool_use_id: "tu_m", content: "Monitor started (task befbmr4a8, expires in 50s" }] }, toolUseResult: { taskId: "befbmr4a8", timeoutMs: 50000, persistent: false } },
  // A Monitor event is not an end.
  { type: "queue-operation", operation: "enqueue", timestamp: "2026-11-16T11:22:44.636Z", content: "<task-notification>\n<task-id>befbmr4a8</task-id>\n<summary>Monitor event: \"watch x\"</summary>\n<event>mon 0</event>\n</task-notification>" },
  notice("blg6zxqxg", "failed", 'Background command "ticker" failed with exit code 3', "2026-11-16T11:23:29.040Z"),
  { type: "queue-operation", operation: "dequeue", timestamp: "2026-11-16T11:23:29.100Z" },
];

test("parseTaskNotification: the end of a task, with its exit code; a Monitor event is not one", () => {
  const n = parseTaskNotification((LINES[7] as { content: string }).content);
  assert.deepEqual(n, { taskId: "blg6zxqxg", status: "failed", summary: 'Background command "ticker" failed with exit code 3', exitCode: 3, outputFile: `${TASKS}/blg6zxqxg.output` });
  assert.equal(parseTaskNotification((LINES[6] as { content: string }).content), null);
  assert.equal(parseTaskNotification("plain user text"), null);
  // A Monitor that timed out ends with an event notice only.
  const expired = parseTaskNotification('<task-notification>\n<task-id>b8xko84m0</task-id>\n<summary>Monitor event: "waiting for fg end"</summary>\n<event>[Monitor expired after 50s with 1 event delivered. Re-arm it if you still need the watch.]</event>\nIf this event is something the user would act on now, send a PushNotification.\n</task-notification>');
  assert.deepEqual([expired?.taskId, expired?.status, expired?.summary], ["b8xko84m0", "completed", "Monitor expired after 50s with 1 event delivered. Re-arm it if you still need the watch."]);
  const ok = parseTaskNotification("<task-notification>\n<task-id>t</task-id>\n<status>completed</status>\n<summary>Monitor \"x\" stream ended</summary>\n</task-notification>");
  assert.deepEqual([ok?.status, ok?.exitCode, ok?.outputFile], ["completed", null, null]);
});

test("applyLine joins a result to its call (also a Ctrl+B one), and a notice to its task", () => {
  const scan = { calls: new Map(), tasks: new Map() };
  for (const l of LINES) applyLine(scan, l);
  const t = Object.fromEntries([...scan.tasks.values()].map((r: BackgroundTaskRecord) => [r.taskId, r]));
  assert.deepEqual(Object.keys(t).sort(), ["befbmr4a8", "bt3lqqlwx", "blg6zxqxg"].sort());
  assert.equal(t.blg6zxqxg!.kind, "shell");
  assert.equal(t.blg6zxqxg!.description, "ticker");
  assert.equal(t.blg6zxqxg!.command, "python3 ticker.py");
  assert.equal(t.blg6zxqxg!.startedAt, Date.parse("2026-11-16T11:22:40.546Z"), "the call's time, not the result's");
  assert.equal(t.blg6zxqxg!.outputFile, `${TASKS}/blg6zxqxg.output`);
  assert.equal(t.blg6zxqxg!.end?.status, "failed");
  assert.equal(t.blg6zxqxg!.end?.exitCode, 3);
  assert.equal(t.bt3lqqlwx!.command, "python3 slow.py", "a Ctrl+B task has no run_in_background in its call");
  assert.equal(t.bt3lqqlwx!.startedAt, Date.parse("2026-11-16T11:25:12.501Z"), "its real start, not the time it was moved");
  assert.equal(t.bt3lqqlwx!.end, null);
  assert.equal(t.befbmr4a8!.kind, "monitor");
  assert.equal(t.befbmr4a8!.outputFile, null);
  assert.equal(t.befbmr4a8!.end, null, "a Monitor event did not end it");
});

test("backgroundTaskRows: states by the transcript, the live process and the session's life", () => {
  const scan = { calls: new Map(), tasks: new Map() };
  for (const l of LINES) applyLine(scan, l);
  const records = [...scan.tasks.values()];
  const state = (ctx: Parameters<typeof backgroundTaskRows>[1]) => Object.fromEntries(backgroundTaskRows(records, ctx).map((r) => [r.id, r.status]));
  // This server's process has the Ctrl+B task only: the Monitor it lost is interrupted, the ended one keeps its end.
  assert.deepEqual(state({ sessionOpen: true, processStartMs: null, liveTaskIds: new Set(["bt3lqqlwx"]) }), { blg6zxqxg: "failed", bt3lqqlwx: "running", befbmr4a8: "interrupted" });
  // Another process holds an open session: what started with it runs.
  const started = Date.parse("2026-11-16T11:22:00Z");
  assert.deepEqual(state({ sessionOpen: true, processStartMs: started, liveTaskIds: null }), { blg6zxqxg: "failed", bt3lqqlwx: "running", befbmr4a8: "running" });
  // The process started after the tasks did: they went with the old one.
  assert.deepEqual(state({ sessionOpen: true, processStartMs: Date.parse("2026-11-16T12:00:00Z"), liveTaskIds: null }), { blg6zxqxg: "failed", bt3lqqlwx: "interrupted", befbmr4a8: "interrupted" });
  assert.deepEqual(state({ sessionOpen: false, processStartMs: null, liveTaskIds: null }), { blg6zxqxg: "failed", bt3lqqlwx: "interrupted", befbmr4a8: "interrupted" });
  const rows = backgroundTaskRows(records, { sessionOpen: true, processStartMs: null, liveTaskIds: null });
  const failed = rows.find((r) => r.id === "blg6zxqxg")!;
  assert.deepEqual([failed.kind, failed.title, failed.command, failed.exitCode, failed.completedAt], ["shell", "ticker", "python3 ticker.py", 3, "2026-11-16T11:23:29.040Z"]);
  assert.equal(rows.find((r) => r.id === "befbmr4a8")!.title, "watch x");
});

test("a stopped task (the CLI says killed) is cancelled, a completed one completed with its exit code", () => {
  const scan = { calls: new Map(), tasks: new Map() };
  applyLine(scan, bashUse("u1", { command: "sleep 9", description: "" }, "2026-11-16T11:00:00Z"));
  applyLine(scan, bgResult("u1", "bz1", "2026-11-16T11:00:01Z", written("bz1")));
  applyLine(scan, notice("bz1", "killed", 'Task "sleep 9" was stopped', "2026-11-16T11:00:05Z"));
  applyLine(scan, bashUse("u2", { command: "true\nline two", description: "" }, "2026-11-16T11:00:00Z"));
  applyLine(scan, bgResult("u2", "bz2", "2026-11-16T11:00:01Z", written("bz2")));
  applyLine(scan, notice("bz2", "completed", 'Background command "x" completed (exit code 0)', "2026-11-16T11:00:02Z"));
  // Exit 144 is the CLI's code for a shell ended by SIGTERM: cancelled, not failed.
  applyLine(scan, bashUse("u3", { command: "sleep 60", description: "" }, "2026-11-16T11:00:00Z"));
  applyLine(scan, bgResult("u3", "bz3", "2026-11-16T11:00:01Z", written("bz3")));
  applyLine(scan, notice("bz3", "failed", 'Background command "sleep 60" failed with exit code 144', "2026-11-16T11:00:09Z"));
  const rows = backgroundTaskRows([...scan.tasks.values()], { sessionOpen: true, processStartMs: null, liveTaskIds: null });
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.exitCode, r.title]), [["bz1", "cancelled", null, "sleep 9"], ["bz2", "completed", 0, "true"], ["bz3", "cancelled", 144, "sleep 60"]]);
});

test("readBackgroundTasks reads a transcript once and then only what was appended", () => {
  const file = path.join(root, "t.jsonl");
  fs.writeFileSync(file, LINES.slice(0, 2).map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.deepEqual(readBackgroundTasks(file).map((r) => [r.taskId, r.end]), [["blg6zxqxg", null]]);
  // A half-written last line is read when it is whole.
  const rest = LINES.slice(2).map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.appendFileSync(file, rest.slice(0, 40));
  assert.equal(readBackgroundTasks(file).length, 1);
  fs.appendFileSync(file, rest.slice(40));
  const all = readBackgroundTasks(file);
  assert.deepEqual(all.map((r) => r.taskId).sort(), ["befbmr4a8", "blg6zxqxg", "bt3lqqlwx"]);
  assert.equal(all.find((r) => r.taskId === "blg6zxqxg")!.end?.status, "failed");
  // A transcript that shrank (rewritten) is read from the start.
  fs.writeFileSync(file, JSON.stringify(LINES[0]) + "\n");
  assert.deepEqual(readBackgroundTasks(file), []);
  assert.deepEqual(readBackgroundTasks(path.join(root, "missing.jsonl")), []);
});

test("readOutputTail: the end of the file, cut at a character, with the size and whether it was cut", () => {
  const f = path.join(root, "o.output");
  fs.writeFileSync(f, "tick 0\ntick 1\n");
  assert.deepEqual(readOutputTail(f, 1000), { output: "tick 0\ntick 1\n", totalBytes: 14, truncated: false });
  fs.writeFileSync(f, "가나다라"); // 12 bytes, 3 each
  // 7 bytes back lands inside "나": the broken character is dropped.
  assert.deepEqual(readOutputTail(f, 7), { output: "다라", totalBytes: 12, truncated: true });
  assert.equal(readOutputTail(path.join(root, "none.output")), null);
  fs.writeFileSync(f, "");
  assert.deepEqual(readOutputTail(f), { output: "", totalBytes: 0, truncated: false });
});

test("plainOutput drops escape sequences and CRLF", () => {
  assert.equal(plainOutput("\u001b[31mred\u001b[0m\r\nnext \u001b]0;title\u0007end"), "red\nnext end");
});

test("outputFileOf trusts only .../<session>/tasks/<task>.output and finds a Monitor's by its siblings", () => {
  const bz = { taskId: "bz1", outputFile: `${TASKS}/bz1.output` };
  assert.equal(outputFileOf(bz, SID, [], []), `${TASKS}/bz1.output`);
  // A path that names another session or task is not used.
  assert.equal(outputFileOf({ taskId: "bz1", outputFile: "/etc/passwd" }, SID, [], []), null);
  assert.equal(outputFileOf({ taskId: "bz1", outputFile: `/x/other-session/tasks/bz1.output` }, SID, [], []), null);
  assert.equal(outputFileOf({ taskId: "../x", outputFile: null }, SID, [], []), null);
  // A Monitor names none: the folder of a sibling.
  assert.equal(outputFileOf({ taskId: "mon1", outputFile: null }, SID, [bz], []), `${TASKS}/mon1.output`);
  assert.equal(outputFileOf({ taskId: "mon1", outputFile: null }, "another", [bz], []), null);
  // Or the tmp root's folders.
  const tmp = path.join(root, "claude-1");
  fs.mkdirSync(path.join(tmp, "-cwd-name", SID, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "-cwd-name", SID, "tasks", "mon2.output"), "x");
  assert.equal(outputFileOf({ taskId: "mon2", outputFile: null }, SID, [], [tmp]), path.join(tmp, "-cwd-name", SID, "tasks", "mon2.output"));
  assert.equal(outputFileOf({ taskId: "mon3", outputFile: null }, SID, [], [tmp]), null);
});
