// Expected values come from tmux captures of Claude Code 2.1.325 (`claude --resume`, 120 columns)
// of throwaway sessions; DESIGN.md 6i lists them.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2TurnItem } from "@maru/shared";

import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic.ts";
import {
  agentDoneLine,
  backgroundHintText,
  bashGroupKind,
  boxTable,
  changeSummary,
  cliDuration,
  compactCount,
  effectivePermissionMode,
  fileChangeToolName,
  layoutTable,
  menuWindowStart,
  nextPermissionMode,
  oneLine,
  planSignal,
  statusParts,
  diffRows,
  displayPath,
  foldOutput,
  groupParts,
  groupText,
  modelLabel,
  moreLinesLabel,
  parseUnifiedDiff,
  progressDetail,
  stringWidth,
  terminalBlocks,
  type TermBlock,
  type TerminalContext,
} from "./terminalModel.ts";

const CWD = "/work/ref";
const time = (s: number) => new Date(Date.UTC(2026, 10, 15, 16, 0, s)).toISOString();
let ordinal = 0;
function base(id: string) {
  ordinal += 1;
  return {
    id,
    threadId: "t",
    runId: "run-1",
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: time(ordinal),
    completedAt: time(ordinal),
    updatedAt: time(ordinal),
  };
}
function rows(items: OrchestrationV2TurnItem[]): OrchestrationV2ProjectedTurnItem[] {
  return items.map((item, position) => ({ position, visibility: "local", sourceThreadId: "t", sourceItemId: item.id, item }));
}
function blocksOf(items: OrchestrationV2TurnItem[], ctx: Partial<TerminalContext> = {}): TermBlock[] {
  const entries = deriveTimelineEntriesFromVisibleTurnItems({ visibleTurnItems: rows(items), optimisticMessages: [] });
  return terminalBlocks(entries, { cwd: CWD, columns: 120, verbose: false, ...ctx });
}
const bash = (id: string, input: string, output: string): OrchestrationV2TurnItem => ({ ...base(id), type: "command_execution", input, output });
const tool = (id: string, toolName: string, input: unknown, output?: unknown): OrchestrationV2TurnItem => ({
  ...base(id),
  type: "dynamic_tool",
  toolName,
  input,
  ...(output === undefined ? {} : { output }),
});
const assistant = (id: string, text: string): OrchestrationV2TurnItem => ({ ...base(id), type: "assistant_message", messageId: id, text, streaming: false });

test("output folds to 3 lines and counts the rest (seq 1 30)", () => {
  const seq = Array.from({ length: 30 }, (_, i) => String(i + 1)).join("\n");
  assert.deepEqual(foldOutput(seq, 120), { lines: ["1", "2", "3"], hidden: 27 });
  assert.equal(moreLinesLabel(27), "… +27 lines");
  assert.equal(moreLinesLabel(1), "… +1 line");
});

test("exactly one hidden line shows all four instead", () => {
  assert.deepEqual(foldOutput("a\nb\nc\nd", 120), { lines: ["a", "b", "c", "d"], hidden: 0 });
  assert.deepEqual(foldOutput("a\nb\nc\nd\ne", 120), { lines: ["a", "b", "c"], hidden: 2 });
  assert.deepEqual(foldOutput("a\nb\n\n", 120), { lines: ["a", "b"], hidden: 0 });
  assert.deepEqual(foldOutput("   ", 120), { lines: [], hidden: 0 });
});

test("long lines wrap at columns minus 10, wide characters count two cells", () => {
  const fold = foldOutput("x".repeat(25), 30);
  assert.deepEqual(fold.lines, ["x".repeat(20), "x".repeat(5)]);
  assert.equal(stringWidth("한글a"), 5);
  assert.deepEqual(foldOutput("한".repeat(12), 30).lines, ["한".repeat(10), "한".repeat(2)]);
  // Below 20 columns the width floor of 10 applies.
  assert.deepEqual(foldOutput("y".repeat(15), 12).lines, ["y".repeat(10), "y".repeat(5)]);
});

test("text past the character cap counts its lines from length", () => {
  const fold = foldOutput("z".repeat(10_000), 20);
  assert.equal(fold.lines.length, 3);
  assert.equal(fold.hidden, Math.ceil(10_000 / 10) - 3);
});

test("shell commands sort into the CLI's summary kinds", () => {
  assert.equal(bashGroupKind("ls /nonexistent-dir-xyz ."), "list");
  assert.equal(bashGroupKind("find . -maxdepth 1 -name '*.txt'"), "search");
  assert.equal(bashGroupKind("grep -rn 'a' ."), "search");
  assert.equal(bashGroupKind("seq 1 30"), "bash");
  assert.equal(bashGroupKind("bash -lc 'ls -la'"), "list");
});

test("a finished run of shell commands folds into one line (measured bash session)", () => {
  const blocks = blocksOf([bash("b1", "echo hello", "hello"), bash("b2", "seq 1 30", "1\n2"), bash("b3", "ls /nonexistent-dir-xyz .", "Error"), assistant("a1", "done")]);
  assert.equal(blocks[0]?.kind, "group");
  if (blocks[0]?.kind !== "group") return;
  assert.equal(groupText(blocks[0].parts, false), "Listed 1 directory, ran 2 shell commands");
  assert.equal(blocks[1]?.kind, "assistant");
});

test("search, glob and read fold into one line and hidden calls keep the group (measured synthetic session)", () => {
  const blocks = blocksOf([
    tool("g1", "Grep", { pattern: "row 1" }, { mode: "content", numLines: 3 }),
    tool("ts", "ToolSearch", { query: "select:Glob" }),
    tool("g2", "Glob", { pattern: "*.txt" }, { numFiles: 2 }),
    tool("r1", "Read", { file_path: `${CWD}/long.txt` }, { type: "text", file: { numLines: 40 } }),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.kind === "group" && groupText(blocks[0].parts, false), "Searched for 2 patterns, read 1 file");
});

test("an MCP call names its server; several count as times", () => {
  assert.equal(groupText(groupParts([], false), false), "");
  const one = blocksOf([tool("m1", "mcp__ref__echo", { text: "hi" }, "echo: hi")]);
  assert.equal(one[0]?.kind === "group" && groupText(one[0].parts, false), "Called ref");
  const two = blocksOf([tool("m1", "mcp__ref__echo", { text: "a" }, "a"), tool("m2", "mcp__ref__echo", { text: "b" }, "b"), bash("b1", "true", "")]);
  assert.equal(two[0]?.kind === "group" && groupText(two[0].parts, false), "Called ref 2 times, ran 1 shell command");
});

test("an active group uses -ing verbs and an ellipsis", () => {
  const running = { ...tool("r1", "Read", { file_path: "x" }), status: "running" as const };
  const blocks = blocksOf([running]);
  assert.equal(blocks[0]?.kind === "group" && groupText(blocks[0].parts, blocks[0].active), "Reading 1 file…");
});

test("a running shell command is drawn on its own", () => {
  const blocks = blocksOf([{ ...bash("b1", "sleep 6; seq 1 30", ""), status: "running" as const }]);
  assert.equal(blocks[0]?.kind, "tool");
  assert.equal(blocks[0]?.kind === "tool" && blocks[0].tone, "running");
});

test("the transcript view draws every call with full output and stamps answers", () => {
  const seq = Array.from({ length: 30 }, (_, i) => String(i + 1)).join("\n");
  const blocks = blocksOf([bash("b1", "seq 1 30", seq), assistant("a1", "done")], { verbose: true, model: "claude-haiku-4-5-20251001" });
  assert.equal(blocks[0]?.kind, "tool");
  if (blocks[0]?.kind !== "tool") return;
  assert.equal(blocks[0].name, "Bash");
  assert.equal(blocks[0].rows.length, 30);
  assert.equal(blocks[1]?.kind, "stamp");
  assert.equal(blocks[1]?.kind === "stamp" && blocks[1].model, "claude-haiku-4-5-20251001");
});

test("an opened group shows its calls with the 3-line fold and the ctrl+o hint", () => {
  const seq = Array.from({ length: 30 }, (_, i) => String(i + 1)).join("\n");
  const blocks = blocksOf([bash("b1", "seq 1 30", seq)], { openGroups: new Set(["group:b1"]) });
  assert.equal(blocks[0]?.kind, "tool");
  if (blocks[0]?.kind !== "tool") return;
  assert.deepEqual(blocks[0].rows.slice(0, 3).map((r) => (r.k === "text" ? r.segs[0]?.t : null)), ["1", "2", "3"]);
  assert.deepEqual(blocks[0].rows[3], { k: "more", hidden: 27, hint: true });
});

test("a failed command is red and an empty one says (No output)", () => {
  const failed = blocksOf([{ ...base("b1"), type: "command_execution", input: "false", output: "Error: Exit code 1", status: "failed", exitCode: 1 }], { verbose: true });
  assert.equal(failed[0]?.kind === "tool" && failed[0].tone, "error");
  const empty = blocksOf([bash("b1", "true", "")], { verbose: true });
  assert.deepEqual(empty[0]?.kind === "tool" && empty[0].rows, [{ k: "text", segs: [{ t: "(No output)" }], tone: "dim" }]);
});

const WRITE_DIFF = `--- /dev/null\n+++ ${CWD}/notes.txt\n@@ -0,0 +1,6 @@\n+alpha\n+beta\n+gamma\n+delta\n+epsilon\n+zeta\n`;
const EDIT_DIFF = `--- ${CWD}/notes.txt\n+++ ${CWD}/notes.txt\n@@ -1,6 +1,6 @@\n alpha\n beta\n-gamma\n+GAMMA CHANGED\n delta\n epsilon\n zeta\n`;

test("Write shows Wrote N lines and numbered lines with a relative path (measured files session)", () => {
  const blocks = blocksOf([{ ...base("w1"), type: "file_change", fileName: `${CWD}/notes.txt`, diffStr: WRITE_DIFF }]);
  const block = blocks[0];
  assert.equal(block?.kind, "tool");
  if (block?.kind !== "tool") return;
  assert.equal(block.name, "Write");
  assert.equal(block.args[0]?.t, "notes.txt");
  assert.equal(block.args[0]?.path, `${CWD}/notes.txt`);
  const head = block.rows[0];
  assert.equal(head?.k === "text" && head.segs.map((s) => s.t).join(""), "Wrote 6 lines to notes.txt");
  assert.deepEqual(block.rows[1], { k: "code", n: 1, w: 1, text: "alpha" });
  assert.equal(block.rows.length, 7);
});

test("Write of 30 lines shows 10 then … +20 lines without the hint (measured synthetic session)", () => {
  const body = Array.from({ length: 30 }, (_, i) => `+row ${i + 1}`).join("\n");
  const blocks = blocksOf([{ ...base("w1"), type: "file_change", fileName: `${CWD}/long.txt`, diffStr: `--- /dev/null\n+++ ${CWD}/long.txt\n@@ -0,0 +1,30 @@\n${body}\n` }]);
  const block = blocks[0];
  if (block?.kind !== "tool") return assert.fail("not a tool block");
  assert.deepEqual(block.rows.filter((r) => r.k === "code").length, 10);
  assert.deepEqual(block.rows.at(-1), { k: "more", hidden: 20, hint: false });
  assert.equal(block.rows[10]?.k === "code" && block.rows[10].w, 2);
});

test("Update numbers context and added lines with the new number and removed ones with the old", () => {
  const blocks = blocksOf([{ ...base("e1"), type: "file_change", fileName: `${CWD}/notes.txt`, diffStr: EDIT_DIFF }]);
  const block = blocks[0];
  if (block?.kind !== "tool") return assert.fail("not a tool block");
  assert.equal(block.name, "Update");
  const head = block.rows[0];
  assert.equal(head?.k === "text" && head.segs.map((s) => s.t).join(""), "Added 1 line, removed 1 line");
  assert.deepEqual(
    block.rows.slice(1).map((r) => (r.k === "diff" ? `${r.n}${r.sign}${r.text}` : r.k)),
    ["1 alpha", "2 beta", "3-gamma", "3+GAMMA CHANGED", "4 delta", "5 epsilon", "6 zeta"],
  );
});

test("each hunk sizes its own number column and hunks are split by a gap row (measured Update)", () => {
  const diff = "--- a\n+++ a\n@@ -2,8 +2,7 @@\n row 2\n-row 5\n+row five\n row 9\n@@ -17,7 +16,8 @@\n row 17\n row 18\n row 19\n-row 20\n+row twenty\n+row twenty-b\n row 21\n";
  const out = diffRows(parseUnifiedDiff(diff)[0]!);
  // CLI: "16  row 17", "17  row 18", "18  row 19", "20 -row 20", "19 +row twenty", "20 +row twenty-b", "21  row 21".
  assert.deepEqual(
    out.map((r) => (r.k === "diff" ? `${r.w}:${r.n}${r.sign}` : r.k)),
    ["1:2 ", "1:3-", "1:3+", "1:4 ", "gap", "2:16 ", "2:17 ", "2:18 ", "2:20-", "2:19+", "2:20+", "2:21 "],
  );
});

test("change summary wording", () => {
  const text = (a: number, d: number) => changeSummary(a, d).map((s) => s.t).join("");
  assert.equal(text(1, 2), "Added 1 line, removed 2 lines");
  assert.equal(text(3, 3), "Added 3 lines, removed 3 lines");
  assert.equal(text(0, 2), "Removed 2 lines");
});

test("paths outside the transcript view are relative to the session folder", () => {
  assert.equal(displayPath(`${CWD}/notes.txt`, CWD, false), "notes.txt");
  assert.equal(displayPath(`${CWD}/notes.txt`, CWD, true), `${CWD}/notes.txt`);
  assert.equal(displayPath("/etc/hosts", CWD, false), "/etc/hosts");
});

test("MCP calls drawn alone use the CLI's server - tool (MCP) name", () => {
  const blocks = blocksOf([tool("m1", "mcp__ref__echo", { text: "hello from maru" }, "echo: hello from maru\nlength: 15")], { verbose: true });
  const block = blocks[0];
  if (block?.kind !== "tool") return assert.fail("not a tool block");
  assert.equal(block.name, "ref - echo (MCP)");
  assert.equal(block.args[0]?.t, 'text: "hello from maru"');
  assert.equal(block.rows.length, 2);
});

test("ToolSearch and the task tools are not drawn", () => {
  assert.deepEqual(blocksOf([tool("t1", "ToolSearch", {}), tool("t2", "TaskCreate", { subject: "x" })], { verbose: true }), []);
});

test("thinking shows only while it streams outside the transcript view", () => {
  const thought: OrchestrationV2TurnItem = { ...base("r1"), type: "reasoning", text: "a thought", streaming: false };
  assert.deepEqual(blocksOf([thought]), []);
  assert.equal(blocksOf([thought], { verbose: true })[0]?.kind, "thinking");
  assert.equal(blocksOf([{ ...thought, streaming: true, status: "running" as const }])[0]?.kind, "thinking");
});

test("a plain interrupt gets its own line; one during a tool call does not", () => {
  const plain: OrchestrationV2TurnItem = { ...base("i1"), type: "run_interrupt_result", message: "[Request interrupted by user]" };
  const toolUse: OrchestrationV2TurnItem = { ...base("i2"), type: "run_interrupt_result", message: "[Request interrupted by user for tool use]" };
  assert.equal(blocksOf([plain])[0]?.kind, "interrupted");
  assert.deepEqual(blocksOf([toolUse]), []);
});

test("tables are boxed with centered headers (measured markdown)", () => {
  assert.deepEqual(boxTable([["a", "b"], ["17", "23"]]), [
    "\u250c\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2510",
    "\u2502  a  \u2502  b  \u2502",
    "\u251c\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2524",
    "\u2502 17  \u2502 23  \u2502",
    "\u2514\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2518",
  ]);
  // The /context table: a header centered in a 23-cell column.
  assert.equal(boxTable([["Category"], ["MCP server instructions"]])[1], "\u2502        Category         \u2502");
});

test("model labels and the progress parenthesis", () => {
  assert.equal(modelLabel("claude-haiku-4-5"), "Haiku 4.5");
  assert.equal(modelLabel("claude-opus-5-5-20261101"), "Opus 5.5");
  assert.equal(modelLabel("haiku"), "Haiku");
  assert.equal(modelLabel("claude-opus-4-6[1m]"), "Opus 4.6 (1M context)", "the CLI's name for a 1M run");
  const wide = { state: { model: "claude-opus-4-6", oneMillion: true }, tokenUsage: { usedTokens: 34_000, maxTokens: 1_000_000 } } as unknown as Parameters<typeof statusParts>[0];
  assert.deepEqual(statusParts(wide, null), ["Opus 4.6 (1M context)", "34k/1M context (3%)"]);
  assert.equal(progressDetail(3_000, 184), "(3s  ↓ 184 tokens)");
  assert.equal(progressDetail(65_000, 1_234), "(1m 5s  ↓ 1.2k tokens)");
  assert.equal(progressDetail(8_000, null), "(8s)");
});

test("after a compaction the screen starts at it, with the messages it kept (measured /compact)", () => {
  const user: OrchestrationV2TurnItem = { ...base("u1"), type: "user_message", messageId: "u1", text: "Run these", attachments: [], inputIntent: "turn_start", createdBy: "user", creationSource: "web" };
  const kept: OrchestrationV2TurnItem = { ...assistant("a1", "done"), nativeItemRef: { driver: "claude", nativeId: "uuid-kept", strength: "strong" } };
  const compaction: OrchestrationV2TurnItem = { ...base("c1"), type: "compaction", driver: "claude", summary: "Summary text" };
  const visible = rows([user, bash("b1", "seq 1 3", "1\n2\n3"), kept, compaction, assistant("a2", "after")]);
  visible[3] = { ...visible[3]!, x: { raw: [], sourceKey: "c", compaction: { preservedUuids: ["uuid-kept"] } } };
  const entries = deriveTimelineEntriesFromVisibleTurnItems({ visibleTurnItems: visible, optimisticMessages: [] });
  const ctx = { cwd: CWD, columns: 120, verbose: false };
  assert.deepEqual(terminalBlocks(entries, ctx).map((b) => b.kind), ["compaction", "assistant", "assistant"]);
  assert.deepEqual(terminalBlocks(entries, { ...ctx, beforeCompaction: true }).map((b) => b.kind), ["user", "group", "assistant", "compaction", "assistant"]);
});

// ---- 2026-11-16 terminal fixes (verify-2, B4) ----

const projected = (items: OrchestrationV2TurnItem[], x: Record<number, OrchestrationV2ProjectedTurnItem["x"]> = {}) =>
  rows(items).map((row, i) => (x[i] ? { ...row, x: x[i] } : row));
function blocksOfRows(visible: OrchestrationV2ProjectedTurnItem[], ctx: Partial<TerminalContext> = {}): TermBlock[] {
  const entries = deriveTimelineEntriesFromVisibleTurnItems({ visibleTurnItems: visible, optimisticMessages: [] });
  const items = new Map(visible.map((r) => [r.item.id, r.item]));
  return terminalBlocks(entries, { cwd: CWD, columns: 120, verbose: false, items, ...ctx });
}
const toolRowsText = (block: TermBlock | undefined) =>
  block?.kind === "tool" ? block.rows.map((r) => (r.k === "text" ? r.segs.map((s) => s.t).join("") : r.k)) : null;

const groupRowsText = (block: TermBlock | undefined) =>
  block?.kind === "group" ? (block.rows ?? []).map((r) => (r.k === "text" ? r.segs.map((s) => s.t).join("") : r.k)) : null;

test("a shell command stopped with esc stays in its group, which shows the command and the interrupt (measured capture 49)", () => {
  const stopped: OrchestrationV2TurnItem = { ...bash("b2", "python3 -c 'import time; time.sleep(30)'", "User rejected tool use"), status: "failed", toolNonExecutionKind: "user-rejected" };
  const after: OrchestrationV2TurnItem = { ...base("i1"), type: "run_interrupt_result", message: "[Request interrupted by user for tool use]" };
  const blocks = blocksOf([bash("b1", "echo hi", "hi"), stopped, after]);
  assert.deepEqual(blocks.map((b) => b.kind), ["group"]);
  assert.equal(blocks[0]?.kind === "group" && groupText(blocks[0].parts, false), "Ran 1 shell command, no result recorded for 1 other call");
  assert.deepEqual(groupRowsText(blocks[0]), ["$ python3 -c 'import time; time.sleep(30)'", "section", "Interrupted  What should Claude do instead?"]);
  // The transcript view draws it alone with a red bullet and the interrupt (measured capture 50).
  const verbose = blocksOf([bash("b1", "echo hi", "hi"), stopped, after], { verbose: true });
  assert.deepEqual(verbose.map((b) => b.kind), ["tool", "tool"]);
  assert.equal(verbose[1]?.kind === "tool" && verbose[1].tone, "error");
  assert.deepEqual(toolRowsText(verbose[1]), ["Interrupted  What should Claude do instead?"]);
});

test("a Read stopped with esc counts as read and shows the interrupt; failed commands stay in the group (captures 52, 56)", () => {
  const read: OrchestrationV2TurnItem = { ...tool("r1", "Read", { file_path: `${CWD}/pipe.txt` }), status: "failed", toolNonExecutionKind: "user-rejected" };
  const blocks = blocksOf([read]);
  assert.equal(blocks[0]?.kind === "group" && groupText(blocks[0].parts, false), "Read 1 file");
  assert.deepEqual(groupRowsText(blocks[0]), ["Interrupted  What should Claude do instead?"]);
  const failing = blocksOf([
    { ...bash("f1", "ls /nonexistent-dir-xyz", "ls: /nonexistent-dir-xyz: No such file or directory"), status: "failed", exitCode: 1 } as OrchestrationV2TurnItem,
    { ...bash("f2", "false", "Error: Exit code 1"), status: "failed", exitCode: 1 } as OrchestrationV2TurnItem,
  ]);
  assert.equal(failing[0]?.kind === "group" && groupText(failing[0].parts, false), "Listed 1 directory, ran 1 shell command");
  assert.equal(failing[0]?.kind === "group" && failing[0].rows, undefined);
});

test("a Codex command stopped with esc names Codex, and the plain interrupt after it is not drawn twice", () => {
  const stopped: OrchestrationV2TurnItem = { ...bash("c1", "sleep 60", ""), status: "interrupted" };
  const after: OrchestrationV2TurnItem = { ...base("i1"), type: "run_interrupt_result", message: "Turn interrupted" };
  const blocks = blocksOf([stopped, after], { agentName: "Codex" });
  assert.deepEqual(blocks.map((b) => b.kind), ["group"]);
  assert.equal(blocks[0]?.kind === "group" && groupText(blocks[0].parts, false), "No result recorded for 1 call");
  assert.deepEqual(groupRowsText(blocks[0]), ["$ sleep 60", "section", "Interrupted  What should Codex do instead?"]);
  // A plain interrupt with nothing stopped keeps its own line and the agent's name.
  const plain = blocksOf([assistant("a1", "thinking"), after], { agentName: "Codex" });
  assert.deepEqual(plain.at(-1), { kind: "interrupted", id: after.id, agent: "Codex" });
});

test("plan mode: EnterPlanMode result, an answered plan with its file, nothing for a failed empty call or the mode notices", () => {
  const enter = tool("e1", "EnterPlanMode", {}, { message: "Entered plan mode." });
  const failed: OrchestrationV2TurnItem = { ...base("p1"), type: "proposed_plan", planId: "p1", markdown: "", streaming: false, status: "failed" };
  const write: OrchestrationV2TurnItem = { ...base("w1"), type: "file_change", fileName: "/Users/u/.claude/plans/x.md", diffStr: "--- /dev/null\n+++ /Users/u/.claude/plans/x.md\n@@ -0,0 +1,1 @@\n+1. Reply with the word done\n" };
  const approved: OrchestrationV2TurnItem = { ...base("p2"), type: "proposed_plan", planId: "p2", markdown: "1. Reply with the word done\n", streaming: false };
  const exit: OrchestrationV2TurnItem = { ...base("n1"), type: "system_notice", message: "/Users/u/.claude/plans/x.md", level: "info" };
  const unknown: OrchestrationV2TurnItem = { ...base("n2"), type: "system_notice", message: "알 수 없는 기록", level: "info" };
  const visible = projected([enter, failed, write, approved, exit, unknown], {
    4: { raw: [], sourceKey: "claude|top|type=attachment|attachment.type=plan_mode_exit", noticeKind: "mode" },
    5: { raw: [], sourceKey: "claude|top|type=attachment|attachment.type=unknown_command_fallback", unknown: true },
  });
  const blocks = blocksOfRows(visible);
  assert.deepEqual(blocks.map((b) => b.kind), ["plan-mode", "tool", "plan"]);
  assert.deepEqual(toolRowsText(blocks[1]), ["/plan to preview"]);
  assert.deepEqual(blocks[2], { kind: "plan", id: approved.id, state: "approved", markdown: "1. Reply with the word done\n", path: "/Users/u/.claude/plans/x.md" });
  // While it waits for the answer the picker shows the plan, not the transcript.
  assert.deepEqual(blocksOfRows(projected([{ ...approved, status: "running" }])), []);
  // A refusal keeps the plan in a box.
  const rejected = blocksOfRows(projected([{ ...approved, status: "failed", toolNonExecutionKind: "user-rejected" }]));
  assert.equal(rejected[0]?.kind === "plan" && rejected[0].state, "rejected");
});

test("a goal notice shows its reason (the folded body) in the transcript view, and always when the goal could not be achieved", () => {
  const notMet: OrchestrationV2TurnItem = { ...base("g1"), type: "system_notice", message: "목표 미달: tests pass", level: "info" };
  const failed: OrchestrationV2TurnItem = { ...base("g2"), type: "system_notice", message: "목표 달성 불가: tests pass", level: "error" };
  const visible = projected([notMet, failed], {
    0: { raw: [], sourceKey: "claude|top|type=attachment|attachment.type=goal_status", noticeKind: "goal", body: "Two tests fail." },
    1: { raw: [], sourceKey: "claude|top|type=attachment|attachment.type=goal_status", noticeKind: "goal", body: "The suite cannot run here." },
  });
  const text = (blocks: TermBlock[]) => blocks.map((b) => (b.kind === "notice" ? b.text : b.kind));
  assert.deepEqual(text(blocksOfRows(visible)), ["목표 미달: tests pass", "목표 달성 불가: tests pass\nThe suite cannot run here."]);
  assert.deepEqual(text(blocksOfRows(visible, { verbose: true })), ["목표 미달: tests pass\nTwo tests fail.", "목표 달성 불가: tests pass\nThe suite cannot run here."]);
});

test("Codex model ids keep their own spelling; Claude ids and aliases get the CLI's name", () => {
  assert.equal(modelLabel("gpt-6-luna"), "gpt-6-luna");
  assert.equal(modelLabel("gpt-6.1-sol"), "gpt-6.1-sol");
  assert.equal(modelLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(modelLabel("opus"), "Opus");
});

test("the status line leaves out the HEAD a folder outside git records", () => {
  const snap = (gitBranch: string) => ({ state: { cwd: "/tmp/x", gitBranch }, tokenUsage: null }) as unknown as Parameters<typeof statusParts>[0];
  assert.deepEqual(statusParts(snap("HEAD"), null), ["/tmp/x"]);
  assert.deepEqual(statusParts(snap("main"), null), ["/tmp/x", "main"]);
});

test("Write and Update come from the server's tool name; an overwriting Write keeps its name over the diff", () => {
  const overwrite: OrchestrationV2TurnItem = { ...base("w1"), type: "file_change", fileName: `${CWD}/notes.txt`, diffStr: EDIT_DIFF };
  const named = blocksOfRows(projected([overwrite], { 0: { raw: [], sourceKey: "k", data: { toolName: "Write" } } }));
  assert.equal(named[0]?.kind === "tool" && named[0].name, "Write");
  assert.equal(toolRowsText(named[0])?.[0], "Added 1 line, removed 1 line");
  const unnamed = blocksOfRows(projected([overwrite]));
  assert.equal(unnamed[0]?.kind === "tool" && unnamed[0].name, "Update");
  assert.equal(fileChangeToolName("MultiEdit", true), "Update");
  assert.equal(fileChangeToolName(undefined, true), "Write");
});

test("a running Bash call with the server's description shows it and the command under it (measured live capture)", () => {
  const running: OrchestrationV2TurnItem = { ...bash("b1", "sleep 6; seq 1 30", ""), status: "running" };
  const blocks = blocksOfRows(projected([running], { 0: { raw: [], sourceKey: "k", data: { description: "Sleeping 6 seconds then output sequence 1 to 30" } } }));
  const block = blocks[0];
  if (block?.kind !== "tool") return assert.fail("not a tool block");
  assert.equal(block.name, "Sleeping 6 seconds then output sequence 1 to 30");
  assert.equal(block.plainName, true);
  assert.deepEqual(toolRowsText(block), ["$ sleep 6; seq 1 30"]);
});

test("the Agent Done line uses the server's counts in the CLI's number and time formats", () => {
  assert.equal(agentDoneLine({ toolUses: 1, totalTokens: 4012, durationMs: 3400 }, null), "Done (1 tool use, 4.0k tokens, 3s)");
  assert.equal(agentDoneLine({ toolUses: 12, totalTokens: 999, durationMs: 65_000 }, null), "Done (12 tool uses, 999 tokens, 1m 5s)");
  assert.equal(agentDoneLine({}, 7), "Done (7s)");
  assert.equal(compactCount(12_345), "12.3k");
  assert.equal(compactCount(1_234_567), "1.2m");
  assert.equal(cliDuration(3_725_000), "1h 2m 5s");
});

test("shift+tab cycles in the CLI's order and plan mode from EnterPlanMode shows until the server's mode moves", () => {
  assert.deepEqual(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", undefined].map(nextPermissionMode), ["acceptEdits", "plan", "bypassPermissions", "default", "default", "default"]);
  const enter = { item: { ...tool("e1", "EnterPlanMode", {}, {}), completedAt: "2026-11-16T10:00:00.000Z" } };
  const plan = { item: { ...base("p1"), type: "proposed_plan" as const, planId: "p1", markdown: "x", streaming: false, completedAt: "2026-11-16T10:05:00.000Z" } };
  assert.deepEqual(planSignal([enter]), { on: true, at: "2026-11-16T10:00:00.000Z" });
  assert.deepEqual(planSignal([enter, plan]), { on: false, at: "2026-11-16T10:05:00.000Z" });
  const on = planSignal([enter]);
  assert.equal(effectivePermissionMode("bypassPermissions", on, null), "plan");
  assert.equal(effectivePermissionMode("bypassPermissions", on, Date.parse("2026-11-16T10:01:00.000Z")), "bypassPermissions");
  assert.equal(effectivePermissionMode("acceptEdits", null, null), "acceptEdits");
});

test("the / menu keeps a window of rows around the highlight and one line per description", () => {
  assert.equal(menuWindowStart(0, 20, 5), 0);
  assert.equal(menuWindowStart(7, 20, 5), 3);
  assert.equal(menuWindowStart(19, 20, 5), 15);
  assert.equal(menuWindowStart(2, 3, 5), 0);
  assert.equal(oneLine("Deep research\n  harness, fan-out"), "Deep research harness, fan-out");
});

test("a table narrower than its text wraps cells; one that cannot fit becomes records (bundle table layout)", () => {
  const table = [
    ["Name", "Description"],
    ["alpha", "the first letter of the Greek alphabet used as a label"],
    ["beta", "second"],
  ];
  const wide = layoutTable(table, 120);
  assert.equal(wide.kind === "box" && wide.lines.length, 7);
  const narrow = layoutTable(table, 40);
  if (narrow.kind !== "box") return assert.fail("expected a box");
  assert.ok(Math.max(...narrow.lines.map(stringWidth)) <= 36);
  // A shorter cell sits in the middle of its row (bundle: floor((rowLines - cellLines) / 2)).
  assert.deepEqual(narrow.lines.slice(3, 6), ["│       │ the first letter of the  │", "│ alpha │ Greek alphabet used as a │", "│       │ label                    │"]);
  const tiny = layoutTable(table, 20);
  if (tiny.kind !== "vertical") return assert.fail("expected records");
  assert.deepEqual(tiny.records[1], [{ label: "Name", lines: ["beta"] }, { label: "Description", lines: ["second"] }]);
  assert.equal(tiny.rule, "─".repeat(19));
});

test("a running Bash call and a running Agent call that is not background carry the background offer (DESIGN.md 4.5)", () => {
  const running = (id: string, over: Record<string, unknown> = {}) => ({ ...bash(id, "sleep 60", ""), status: "running" as const, ...over }) as OrchestrationV2TurnItem;
  const offerOf = (blocks: TermBlock[]) => blocks.flatMap((b) => (b.kind === "tool" && b.background ? [b.background.itemId] : []));
  assert.deepEqual(offerOf(blocksOf([running("t:tool:b1")])), ["t:tool:b1"]);
  assert.deepEqual(offerOf(blocksOf([bash("t:tool:b2", "sleep 1", "")])), [], "a finished call has none");
  const agent = (id: string, over: Record<string, unknown> = {}) => ({
    ...base(id), type: "subagent", subagentId: id, origin: "provider_native", driver: "claude", providerInstanceId: "p",
    childThreadId: null, prompt: "count", result: null, status: "running", title: "Count", ...over,
  }) as unknown as OrchestrationV2TurnItem;
  assert.deepEqual(offerOf(blocksOf([agent("t:tool:a1")])), ["t:tool:a1"]);
  assert.deepEqual(offerOf(blocksOf([agent("t:tool:a2", { status: "completed" })])), []);
  const record = (id: string, over: Record<string, unknown>) => ({ id, status: "running", background: false, ...over }) as never;
  assert.deepEqual(offerOf(blocksOf([agent("t:tool:a3")], { subagents: [record("t:tool:a3", { background: true })] })), [], "a background agent");
  assert.deepEqual(offerOf(blocksOf([agent("t:tool:a4")], { subagents: [record("t:tool:a4", { workflow: { name: "w", agents: [] } })] })), [], "a workflow");
});

test("the hint is the CLI's wording with the key as this screen names it", () => {
  assert.equal(backgroundHintText("ctrl+b"), "(ctrl+b to run in background)");
  assert.equal(backgroundHintText("ctrl+shift+b"), "(ctrl+shift+b to run in background)");
});
