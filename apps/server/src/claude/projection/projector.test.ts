// Projection of Claude transcripts (docs/event-model.md). Fixture lines are trimmed copies of the
// census examples the document cites (EX:L<n> = census/examples.jsonl line n) or small
// hand-written transcripts in the same shape.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OrchestrationV2ProjectedTurnItem, ThreadLiveEvent } from "@maru/shared";
import { deliveredIds, deliveredIdsOfLine } from "@maru/shared";
import type { RawRecord } from "../../transcript/claudeTranscript.ts";
import { createClaudeProjector } from "./projector.ts";
import type { ClaudeLiveStatus, ClaudeProjectorCtx } from "./projector.ts";
import type { ClaudeSidecars } from "./sidecars.ts";

const T = "claude:acc:S1";
const PATH = "/home/u/.claude/projects/-work/S1.jsonl";

function ctx(over: Partial<ClaudeProjectorCtx> = {}): ClaudeProjectorCtx {
  return { threadId: T, account: "acc", sessionId: "S1", path: PATH, readonly: true, ...over };
}

/** Records with byte offsets as a file holding these lines would have them. */
function records(values: unknown[]): RawRecord[] {
  let offset = 0;
  return values.map((value) => {
    const length = Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value)) + 1;
    const r: RawRecord = { offset, length, line: null, value: typeof value === "string" ? { __parseError: true, raw: value } : value };
    offset += length;
    return r;
  });
}

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let clock = 0;
const ts = () => new Date(Date.UTC(2026, 10, 15, 0, 0, clock++)).toISOString();

function prompt(n: number, parent: number | null, text: string, extra: Record<string, unknown> = {}) {
  // EX:L287
  return { parentUuid: parent === null ? null : U(parent), type: "user", message: { role: "user", content: text }, uuid: U(n), timestamp: ts(), promptId: `p${n}`, origin: { kind: "human" }, ...extra };
}

function assistant(n: number, parent: number, msgId: string, apiBlockIndex: number | undefined, block: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  // EX:L154 (thinking), EX:L158 (tool_use Bash), same message.id
  return {
    parentUuid: U(parent),
    type: "assistant",
    message: { model: "claude-opus-5-5", id: msgId, type: "message", role: "assistant", content: [block], usage: { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 } },
    ...(apiBlockIndex === undefined ? {} : { apiBlockIndex }),
    uuid: U(n),
    timestamp: ts(),
    ...extra,
  };
}

function toolResult(n: number, parent: number, toolUseId: string, content: unknown, toolUseResult?: unknown, extra: Record<string, unknown> = {}) {
  // EX:L283
  return {
    parentUuid: U(parent),
    type: "user",
    message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content, is_error: extra.is_error === true }] },
    uuid: U(n),
    timestamp: ts(),
    ...(toolUseResult === undefined ? {} : { toolUseResult }),
    sourceToolAssistantUUID: U(parent),
    ...extra,
  };
}

const bash = (id: string, command: string) => ({ type: "tool_use", id, name: "Bash", input: { command, description: "d" } });

function ids(rows: OrchestrationV2ProjectedTurnItem[]): string[] {
  return rows.map((r) => r.item.id.slice(T.length + 1));
}

function sum(o: Record<string, number>): number {
  return Object.values(o).reduce((a, b) => a + b, 0);
}

function invariantHolds(p: ReturnType<typeof createClaudeProjector>): boolean {
  const s = p.stats();
  return s.linesRead === s.parseFailures + sum(s.displayedByKey) + sum(s.hiddenByKey) + sum(s.unknownByKey);
}

function onePiece(values: unknown[], over: Partial<ClaudeProjectorCtx> = {}) {
  const p = createClaudeProjector(ctx(over));
  p.push(records(values));
  return p;
}

/** A small turn: prompt, thinking + Bash in one message, result, text, turn_duration. */
function basicTurn() {
  return [
    prompt(1, null, "list files"),
    assistant(2, 1, "msg_A", 0, { type: "thinking", thinking: "", signature: "s" }, { thinkingDurationMs: 1958 }),
    assistant(3, 2, "msg_A", 1, bash("toolu_1", "ls")),
    toolResult(4, 3, "toolu_1", "a\nb", { stdout: "a\nb", stderr: "", interrupted: false, isImage: false }),
    assistant(5, 4, "msg_B", 0, { type: "text", text: "two files" }),
    { parentUuid: U(5), type: "system", subtype: "turn_duration", durationMs: 1000, messageCount: 4, uuid: U(6), timestamp: ts() }, // EX:L281
  ];
}

describe("block grouping and tool pairing (7.1, 7.2)", () => {
  test("one item per block; the result merges into its tool item and makes no row", () => {
    const p = onePiece(basicTurn());
    const s = p.snapshot();
    assert.deepEqual(ids(s.visibleTurnItems), [`uuid:${U(1)}`, "blk:msg_A:0", "tool:toolu_1", "blk:msg_B:0"]);
    const tool = s.visibleTurnItems[2]!.item;
    assert.equal(tool.type, "command_execution");
    if (tool.type !== "command_execution") return;
    assert.equal(tool.input, "ls");
    assert.equal(tool.output, "a\nb");
    assert.equal(tool.status, "completed");
    assert.equal(s.visibleTurnItems[2]!.x?.raw.length, 2, "tool_use line and result line");
    assert.equal(s.visibleTurnItems[1]!.x?.durationMs, 1958);
    assert.equal(s.runs.length, 1);
    assert.equal(s.runs[0]!.status, "completed");
    assert.equal(s.runs[0]!.runId, `${T}:run:${U(1)}`);
    assert.equal(s.runs[0]!.assistantMessageId, `${T}:blk:msg_B:0`);
    assert.ok(invariantHolds(p));
  });

  test("a message split by interleaved results still gives one item per block (T3296a420:6840)", () => {
    const p = onePiece([
      prompt(1, null, "go"),
      assistant(2, 1, "msg_P", 0, bash("t1", "a")),
      toolResult(3, 2, "t1", "A"),
      assistant(4, 2, "msg_P", 1, bash("t2", "b")),
      toolResult(5, 4, "t2", "B"),
    ]);
    assert.deepEqual(ids(p.snapshot().visibleTurnItems), [`uuid:${U(1)}`, "tool:t1", "tool:t2"]);
  });

  test("result status: denials, errors, and unresolved calls by liveness (7.1 4)", () => {
    const lines = [
      prompt(1, null, "x"),
      assistant(2, 1, "m", 0, bash("t_int", "a")),
      toolResult(3, 2, "t_int", "Interrupted", "Interrupted", { is_error: true, toolDenialKind: "interrupted" }),
      assistant(4, 3, "m", 1, bash("t_can", "b")),
      toolResult(5, 4, "t_can", "no", "no", { is_error: true, toolDenialKind: "cancelled" }),
      assistant(6, 5, "m", 2, bash("t_rej", "c")),
      toolResult(7, 6, "t_rej", "rejected", "User rejected tool use", { is_error: true, toolDenialKind: "user-rejected" }),
      assistant(8, 7, "m", 3, bash("t_err", "d")),
      toolResult(9, 8, "t_err", "boom", undefined, { is_error: true }),
      assistant(10, 9, "m", 4, bash("t_open", "e")),
      assistant(11, 10, "m", 5, { type: "tool_use", id: "t_ask", name: "AskUserQuestion", input: { questions: [{ question: "Q?", header: "H", options: [{ label: "a", description: "A" }] }] } }),
    ];
    const byId = (p: ReturnType<typeof createClaudeProjector>) => new Map(p.snapshot().visibleTurnItems.map((r) => [r.item.id.slice(T.length + 1), r.item]));
    const dead = byId(onePiece(lines));
    assert.equal(dead.get("tool:t_int")!.status, "interrupted");
    assert.equal(dead.get("tool:t_can")!.status, "cancelled");
    assert.equal(dead.get("tool:t_rej")!.status, "failed");
    assert.equal(dead.get("tool:t_rej")!.toolNonExecutionKind, "user-rejected");
    assert.equal(dead.get("tool:t_err")!.status, "failed");
    assert.equal(dead.get("tool:t_open")!.status, "interrupted", "no result, no live process");
    assert.equal(dead.get("tool:t_ask")!.status, "interrupted");
    const alive = byId(onePiece(lines, { live: "busy" }));
    assert.equal(alive.get("tool:t_open")!.status, "running");
    assert.equal(alive.get("tool:t_ask")!.status, "waiting");
  });

  test("a second result moves the first to x.previousOutputs (7.1 5, Te84b998c:3898/3926)", () => {
    const p = onePiece([
      prompt(1, null, "x"),
      assistant(2, 1, "m", 0, { type: "tool_use", id: "t", name: "Read", input: { file_path: "/a.txt" } }),
      toolResult(3, 2, "t", "Interrupted", undefined, { is_error: true, toolDenialKind: "interrupted" }),
      toolResult(4, 2, "t", "real", { type: "text", file: { filePath: "/a.txt", content: "real" } }),
    ]);
    const r = p.snapshot().visibleTurnItems.find((x) => x.item.id === `${T}:tool:t`)!;
    assert.equal(r.item.status, "completed");
    assert.equal(r.item.title, "Read /a.txt");
    assert.deepEqual(r.x?.previousOutputs, ["Interrupted"]);
  });

  test("base64 images in results become BlobRefs to the line", () => {
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
    const p = onePiece([
      prompt(1, null, "x"),
      assistant(2, 1, "m", 0, { type: "tool_use", id: "t", name: "Read", input: { file_path: "/s.png" } }),
      toolResult(3, 2, "t", [img], { type: "image", file: { base64: "iVBORw0KGgo=", type: "image/png" } }), // EX:L292
    ]);
    const item = p.snapshot().visibleTurnItems[1]!.item;
    assert.equal(item.type, "dynamic_tool");
    if (item.type !== "dynamic_tool") return;
    assert.equal(item.viewedImagePath, "/s.png");
    const text = JSON.stringify(item.output);
    assert.ok(!text.includes("iVBORw0KGgo="), "no inline base64");
    assert.match(text, /"jsonPath":"\$\.message\.content\[0\]\.content\[0\]\.source\.data"/);
    assert.match(text, /"jsonPath":"\$\.toolUseResult\.file\.base64"/);
  });
});

describe("page boundaries (prepend)", () => {
  test("a result without its call is an orphan until the older page arrives, then joins it", () => {
    const all = records(basicTurn());
    const p = createClaudeProjector(ctx());
    p.push(all.slice(3)); // tail page starts at the tool_result line
    const tail = p.snapshot();
    const orphan = tail.visibleTurnItems.find((r) => r.item.id === `${T}:tool:toolu_1`)!;
    assert.equal(orphan.item.type, "dynamic_tool");
    if (orphan.item.type === "dynamic_tool") assert.equal(orphan.item.toolName, null);
    assert.equal(orphan.x?.unknown, true);
    assert.equal(tail.hasMoreBefore, true);
    assert.equal(tail.visibleTurnItems[0]!.item.runId, null, "the opener is on the older page");

    p.prepend(all.slice(0, 3));
    const full = onePiece(basicTurn().map((v) => v)); // same lines in one piece
    const paged = p.snapshot();
    assert.deepEqual(ids(paged.visibleTurnItems), ids(full.snapshot().visibleTurnItems));
    const joined = paged.visibleTurnItems.find((r) => r.item.id === `${T}:tool:toolu_1`)!;
    assert.equal(joined.item.type, "command_execution");
    assert.equal(joined.x?.unknown, undefined);
    assert.equal(paged.hasMoreBefore, false);
    assert.equal(paged.visibleTurnItems[0]!.x?.raw[0]!.line, 1, "line numbers are known once the page starts at offset 0");
  });

  test("paged and one-piece projections are equal row for row; ids are deterministic", () => {
    clock = 0;
    const values = [...basicTurn(), prompt(7, 6, "again"), assistant(8, 7, "msg_C", 0, { type: "text", text: "ok" })];
    const all = records(values);
    const a = createClaudeProjector(ctx());
    a.push(all);
    const b = createClaudeProjector(ctx());
    b.push(all.slice(5));
    b.prepend(all.slice(2, 5));
    b.prepend(all.slice(0, 2));
    assert.deepEqual(b.snapshot(), a.snapshot());
    const again = createClaudeProjector(ctx());
    again.push(all);
    assert.deepEqual(again.snapshot(), a.snapshot());
  });
});

describe("main lane of a branched tree (7.3)", () => {
  // T8e2bf76d: two resumed processes answer under the same parent; ALPHA (written later) is main.
  const base = () => [
    prompt(1, null, "hi"),
    assistant(2, 1, "m1", 0, { type: "text", text: "ONE" }),
    prompt(3, 2, "Reply with exactly the word BETA."),
    prompt(4, 2, "Reply with exactly the word ALPHA."),
    assistant(5, 3, "m2", 0, { type: "text", text: "BETA" }),
    assistant(6, 4, "m3", 0, { type: "text", text: "ALPHA" }),
  ];

  test("the last opener's path is main; the other opener's subtree is an alternate lane with a notice", () => {
    const s = onePiece(base()).snapshot();
    assert.deepEqual(ids(s.visibleTurnItems), [`uuid:${U(1)}`, "blk:m1:0", `syn:branch:${U(2)}`, `uuid:${U(4)}`, "blk:m3:0"]);
    assert.equal(s.branches.lanes.length, 1);
    assert.equal(s.branches.lanes[0]!.laneId, `lane:${U(3)}`);
    assert.deepEqual(ids(s.branches.lanes[0]!.items), [`uuid:${U(3)}`, "blk:m2:0"]);
    const notice = s.visibleTurnItems[2]!;
    assert.equal(notice.visibility, "synthetic");
    assert.equal(notice.x?.branch?.alternates[0]!.itemCount, 2);
    assert.equal(s.state.mainLeafUuid, U(6));
  });

  test("late replies on the alternate do not move the main lane; a new opener elsewhere replaces rows", () => {
    const all = records([...base(), assistant(7, 5, "m4", 0, { type: "text", text: "BETA again" }), prompt(8, 5, "continue BETA")]);
    const p = createClaudeProjector(ctx());
    p.push(all.slice(0, 6));
    const mainBefore = ids(p.snapshot().visibleTurnItems);
    const ev1 = p.push(all.slice(6, 7));
    assert.deepEqual(ids(p.snapshot().visibleTurnItems), mainBefore, "main lane unchanged");
    assert.ok(ev1.some((e) => e.t === "turnItems.replaced" && e.reason === "branch"), "alternate content is resent with branches");
    const ev2 = p.push(all.slice(7));
    const replaced = ev2.find((e) => e.t === "turnItems.replaced");
    assert.ok(replaced !== undefined && replaced.t === "turnItems.replaced" && replaced.reason === "branch");
    assert.ok(ids(replaced.visibleTurnItems).includes(`uuid:${U(8)}`), "BETA side is main now");
    assert.ok(!ids(replaced.visibleTurnItems).includes("blk:m3:0"));
  });

  test("a waiting rewind (DESIGN.md 6o) hides what came after the kept line until the next message", () => {
    const lines = records([
      prompt(1, null, "first"),
      assistant(2, 1, "m1", 0, { type: "text", text: "ONE" }),
      prompt(3, 2, "second"),
      assistant(4, 3, "m2", 0, { type: "text", text: "TWO" }),
      prompt(5, 2, "second, edited"),
      assistant(6, 5, "m3", 0, { type: "text", text: "TWO again" }),
    ]);
    const p = createClaudeProjector(ctx({ readonly: false }));
    p.push(lines.slice(0, 4));
    const marker = { atUuid: U(3), keepUuid: U(2), lastUuid: U(4), createdAt: 1 };
    const ev = p.setTurns({ run: null, ends: [], rewind: marker });
    const replaced = ev.find((e) => e.t === "turnItems.replaced");
    assert.ok(replaced !== undefined && replaced.t === "turnItems.replaced" && replaced.reason === "branch");
    assert.deepEqual(ids(p.snapshot().visibleTurnItems), [`uuid:${U(1)}`, "blk:m1:0", `syn:branch:${U(2)}`]);
    assert.deepEqual(ids(p.snapshot().branches.lanes[0]!.items), [`uuid:${U(3)}`, "blk:m2:0"]);
    assert.equal(p.needsOlder(), false);
    // The next message goes under the kept line, after the marker's last line: it is main, the marker is spent.
    p.push(lines.slice(4));
    const s = p.snapshot();
    assert.deepEqual(ids(s.visibleTurnItems), [`uuid:${U(1)}`, "blk:m1:0", `syn:branch:${U(2)}`, `uuid:${U(5)}`, "blk:m3:0"]);
    assert.equal(s.visibleTurnItems[2]!.x?.branch?.alternates.length, 1, "the marker adds no lane of its own");
    // Dropping the spent marker changes nothing.
    p.setTurns({ run: null, ends: [], rewind: null });
    assert.deepEqual(ids(p.snapshot().visibleTurnItems), ids(s.visibleTurnItems));
  });

  test("a rewind marker that a later opener passed has no effect; one whose kept line is older asks for older pages", () => {
    const lines = records([prompt(1, null, "a"), assistant(2, 1, "m1", 0, { type: "text", text: "A" }), prompt(3, 2, "b"), assistant(4, 3, "m2", 0, { type: "text", text: "B" })]);
    const p = createClaudeProjector(ctx({ readonly: false }));
    p.push(lines.slice(0, 3));
    const before = ids(p.snapshot().visibleTurnItems);
    p.setTurns({ run: null, ends: [], rewind: { atUuid: U(9), keepUuid: U(8), lastUuid: U(2), createdAt: 1 } });
    assert.deepEqual(ids(p.snapshot().visibleTurnItems), before, "prompt 3 came after the marker's last line");
    assert.equal(p.needsOlder(), false);
    // Only the tail is loaded: the kept line (1) is older than the loaded lines.
    const tail = createClaudeProjector(ctx({ readonly: false }));
    tail.push(lines.slice(2));
    tail.setTurns({ run: null, ends: [], rewind: { atUuid: U(3), keepUuid: U(2), lastUuid: U(4), createdAt: 1 } });
    assert.equal(tail.needsOlder(), true);
    tail.prepend(lines.slice(0, 2));
    assert.equal(tail.needsOlder(), false);
    assert.deepEqual(ids(tail.snapshot().visibleTurnItems), [`uuid:${U(1)}`, "blk:m1:0", `syn:branch:${U(2)}`]);
    // A first page of lines without a uuid reaches neither line: older pages tell (measured with a 5-line page).
    const bare = records([...[prompt(1, null, "a"), assistant(2, 1, "m1", 0, { type: "text", text: "A" }), prompt(3, 2, "b"), assistant(4, 3, "m2", 0, { type: "text", text: "B" })], { type: "last-prompt", lastPrompt: "b" }]);
    const quiet = createClaudeProjector(ctx({ readonly: false }));
    quiet.push(bare.slice(4));
    quiet.setTurns({ run: null, ends: [], rewind: { atUuid: U(3), keepUuid: U(2), lastUuid: U(4), createdAt: 1 } });
    assert.equal(quiet.needsOlder(), true);
    quiet.prepend(bare.slice(0, 4));
    assert.equal(quiet.needsOlder(), false);
    assert.deepEqual(ids(quiet.snapshot().visibleTurnItems), [`uuid:${U(1)}`, "blk:m1:0", `syn:branch:${U(2)}`]);
  });

  test("parent cycles are cut (7.3 rule 2)", () => {
    const a = { ...prompt(1, 2, "a") };
    const b = { ...assistant(2, 1, "m", 0, { type: "text", text: "b" }) };
    const s = onePiece([a, b]).snapshot();
    assert.equal(s.visibleTurnItems.length, 2);
  });
});

describe("meta lines fold into thread state (7.5, 7.9)", () => {
  test("last write wins; equal rewrites emit nothing; title precedence", () => {
    const p = createClaudeProjector(ctx());
    const all = records([
      prompt(1, null, "first prompt text"),
      { type: "ai-title", aiTitle: "AI", sessionId: "S1" }, // EX:L108
      { type: "agent-name", agentName: "agent", sessionId: "S1" }, // EX:L107
      { type: "custom-title", customTitle: "web-pentest", sessionId: "S1" }, // EX:L259
      { type: "custom-title", customTitle: "web-pentest", sessionId: "S1" },
      { type: "permission-mode", permissionMode: "bypassPermissions", sessionId: "S1" }, // EX:L266
      { type: "custom-title", customTitle: "renamed", sessionId: "S1" },
    ]);
    p.push(all.slice(0, 1));
    assert.equal(p.snapshot().state.nameSource, "first-prompt");
    p.push(all.slice(1, 4));
    const s = p.snapshot();
    assert.equal(s.title, "web-pentest");
    assert.equal(s.state.nameSource, "custom-title");
    assert.equal(s.state.aiTitle, "AI");
    assert.deepEqual(p.push(all.slice(4, 5)), [], "same value again: no event");
    const ev = p.push(all.slice(5, 6));
    assert.deepEqual(ev, [{ t: "thread.patched", threadId: T, state: { permissionMode: "bypassPermissions" } }]);
    const ev2 = p.push(all.slice(6));
    assert.deepEqual(ev2, [{ t: "thread.patched", threadId: T, title: "renamed", state: { customTitle: "renamed" } }]);
    assert.equal(sum(p.stats().hiddenByKey), 6);
    assert.equal(p.snapshot().visibleTurnItems.length, 1);
  });

  test("queue-operation: enqueue is a pending queued_turn row, dequeue removes it (EX:L268)", () => {
    const all = records([
      prompt(1, null, "work"),
      { type: "queue-operation", operation: "enqueue", timestamp: ts(), sessionId: "S1", content: "later please" },
      { type: "queue-operation", operation: "dequeue", timestamp: ts(), sessionId: "S1" },
      { parentUuid: U(1), type: "attachment", uuid: U(5), timestamp: ts(), attachment: { type: "queued_command", prompt: "also this", source_uuid: U(9), commandMode: "prompt", origin: { kind: "human" } } },
    ]);
    const p = createClaudeProjector(ctx());
    p.push(all.slice(0, 2));
    const q = p.snapshot().visibleTurnItems[1]!;
    assert.equal(q.visibility, "synthetic");
    assert.equal(q.item.type, "user_message");
    if (q.item.type === "user_message") {
      assert.equal(q.item.inputIntent, "queued_turn");
      assert.equal(q.item.status, "pending");
    }
    const ev = p.push(all.slice(2, 3));
    assert.ok(ev.some((e) => e.t === "turnItems.replaced" && e.reason === "resync"));
    assert.equal(p.snapshot().visibleTurnItems.length, 1);
    // The rows name the uuid each message was sent with (DESIGN.md 4.4): the prompt line's own, and
    // a message folded in between tool rounds by its source_uuid (CLI 2.1.325, measured).
    p.push(all.slice(3));
    const rows = p.snapshot().visibleTurnItems;
    assert.deepEqual(rows.map((r) => [r.item.type === "user_message" ? r.item.inputIntent : r.item.type, r.x?.data?.clientId]), [["turn_start", U(1)], ["steer", U(9)]]);
  });

  test("a line the CLI made of several queued sends names every uuid it folded in", () => {
    // Top-level `mergedSendUuids` on the user line (CLI 2.1.325 bundle): the line's own uuid is the
    // first send, the others are listed. The UI settles each send on this one row (DESIGN.md 4.4).
    const p = onePiece([prompt(1, null, "one\ntwo\nthree", { mergedSendUuids: [U(2), U(3)] }), prompt(4, 1, "solo")]);
    const rows = p.snapshot().visibleTurnItems.filter((r) => r.item.type === "user_message");
    assert.deepEqual(rows.map((r) => [r.x?.data?.clientId, r.x?.data?.mergedClientIds]), [[U(1), [U(2), U(3)]], [U(4), undefined]]);
  });

  test("a slash command and a shell escape row name the uuid they were sent with (/goal left its waiting bubble up)", () => {
    // The CLI writes `/goal x` as a `<command-name>` user line under the uuid it was sent with
    // (measured 2026-11-19). Without clientId on that row the waiting message was settled only by the
    // turn's end, so a goal loop kept the faded bubble on screen until a reload read the transcript.
    const goal = "<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>all green</command-args>";
    const p = onePiece([prompt(1, null, goal), prompt(2, 1, "<bash-input>ls</bash-input>"), prompt(3, 2, "plain")]);
    const rows = p.snapshot().visibleTurnItems.filter((r) => r.item.type === "user_message");
    assert.deepEqual(rows.map((r) => [r.item.type === "user_message" ? r.item.text : "", r.x?.data?.clientId]), [["/goal all green", U(1)], ["!ls", U(2)], ["plain", U(3)]]);
    // The same ids the server's transcript scan reads off the raw lines.
    assert.deepEqual([...deliveredIds(p.snapshot().visibleTurnItems)].sort(), [U(1), U(2), U(3)].sort());
  });

  test("the ids of the projected rows are the ids the raw lines name (one definition of delivered)", () => {
    const lines = [
      prompt(1, null, "one\ntwo", { mergedSendUuids: [U(2)] }),
      { type: "queue-operation", operation: "remove", timestamp: ts(), sessionId: "S1", content: "x", commandUuid: U(7) },
      { parentUuid: U(1), type: "attachment", uuid: U(5), timestamp: ts(), attachment: { type: "queued_command", prompt: "steer", source_uuid: U(9), commandMode: "prompt", origin: { kind: "human" } } },
      { parentUuid: U(5), type: "attachment", uuid: U(6), timestamp: ts(), attachment: { type: "queued_command", prompt: "no id", commandMode: "prompt", origin: { kind: "human" } } },
    ];
    const rowIds = deliveredIds(onePiece(lines).snapshot().visibleTurnItems);
    const lineIds = new Set(lines.flatMap((l) => deliveredIdsOfLine(l)));
    assert.deepEqual([...rowIds].sort(), [U(1), U(2), U(9)].sort());
    assert.deepEqual([...lineIds].sort(), [...rowIds].sort());
  });

  test("pr-link makes one notice per URL", () => {
    const pr = { type: "pr-link", sessionId: "S1", prNumber: 12, prUrl: "https://x/pull/12", prRepository: "o/r", timestamp: ts() }; // EX:L267
    const p = onePiece([prompt(1, null, "x"), pr, pr]);
    assert.equal(p.snapshot().visibleTurnItems.filter((r) => r.item.id === `${T}:pr:https://x/pull/12`).length, 1);
    assert.equal(p.stats().hiddenByKey["claude|top|type=pr-link|repeat"], 1);
  });
});

describe("compaction (7.8)", () => {
  test("boundary item with token counts, summary from the next line; logicalParentUuid is only recorded", () => {
    const p = onePiece([
      prompt(1, null, "before"),
      assistant(2, 1, "m1", 0, { type: "text", text: "old answer" }),
      // EX:L273 shape: parentUuid null, logicalParentUuid points at its own descendant (T3296a420:21)
      { parentUuid: null, logicalParentUuid: U(5), type: "system", subtype: "compact_boundary", content: "Conversation compacted", level: "info", compactMetadata: { trigger: "auto", preTokens: 967894, postTokens: 29386, durationMs: 94028, preservedMessages: { allUuids: [U(5)] } }, uuid: U(3), timestamp: ts() },
      { parentUuid: U(3), type: "user", message: { role: "user", content: "This session is being continued..." }, isCompactSummary: true, isVisibleInTranscriptOnly: true, uuid: U(4), timestamp: ts() },
      assistant(5, 4, "m2", 0, { type: "text", text: "continuing" }),
    ]);
    const s = p.snapshot();
    assert.deepEqual(ids(s.visibleTurnItems), [`uuid:${U(1)}`, "blk:m1:0", `uuid:${U(3)}`, "blk:m2:0"]);
    const c = s.visibleTurnItems[2]!;
    assert.equal(c.item.type, "compaction");
    if (c.item.type !== "compaction") return;
    assert.equal(c.item.beforeTokenCount, 967894);
    assert.equal(c.item.afterTokenCount, 29386);
    assert.equal(c.item.summary, "This session is being continued...");
    assert.deepEqual(c.x?.compaction, { trigger: "auto", durationMs: 94028, logicalParentUuid: U(5), preservedUuids: [U(5)] });
    assert.equal(s.visibleTurnItems[3]!.item.runId, `${T}:run:${U(1)}`, "a mid-turn compaction keeps the run");
    assert.equal(s.runs.length, 1, "the summary line opens no run");
  });
});

function fakeSidecars(over: Partial<ClaudeSidecars>): ClaudeSidecars {
  return { agentMetas: () => [], ownMeta: () => null, workflowFinal: () => null, workflowJournal: () => [], workflowResumed: () => false, ...over };
}

describe("subagents and workflows (7.7)", () => {
  const agentCall = (n: number, parent: number, id: string) =>
    assistant(n, parent, `msg_${n}`, 0, { type: "tool_use", id, name: "Agent", input: { description: "Market research", subagent_type: "general-purpose", model: "sonnet", run_in_background: "true", prompt: "research prices" } }); // EX:L155

  test("async Agent: linked by toolUseResult.agentId, settled by the task notification", () => {
    const p = onePiece([
      prompt(1, null, "spawn"),
      agentCall(2, 1, "toolu_A"),
      toolResult(3, 2, "toolu_A", [{ type: "text", text: "Async agent launched successfully." }], { isAsync: true, status: "async_launched", agentId: "adf30a45303a0efdb" }), // T3296a420:172
      {
        parentUuid: U(3),
        type: "user",
        message: { role: "user", content: "<task-notification>\n<task-id>adf30a45303a0efdb</task-id>\n<tool-use-id>toolu_A</tool-use-id>\n<status>completed</status>\n<summary>Agent \"Market research\" finished</summary>\n<result># Report</result>\n</task-notification>" },
        origin: { kind: "task-notification" },
        uuid: U(4),
        timestamp: ts(),
      }, // T3296a420:1019
    ]);
    const s = p.snapshot();
    const sub = s.subagents[0]!;
    assert.equal(sub.childThreadId, `${T}:agent-adf30a45303a0efdb`);
    assert.equal(sub.status, "completed");
    assert.equal(sub.result, "# Report");
    assert.equal(sub.model, "sonnet");
    const item = s.visibleTurnItems.find((r) => r.item.type === "subagent")!;
    assert.deepEqual(item.x?.link, { threadId: `${T}:agent-adf30a45303a0efdb`, evidence: "toolUseResult.agentId" });
    const note = s.visibleTurnItems.find((r) => r.item.type === "notification")!;
    assert.deepEqual(note.item.type === "notification" && note.item.source, { kind: "subagent", childThreadId: `${T}:agent-adf30a45303a0efdb` });
    assert.equal(s.runs.length, 2, "the notification opens a run");
    assert.deepEqual(p.children(), [
      {
        childThreadId: `${T}:agent-adf30a45303a0efdb`,
        agentId: "adf30a45303a0efdb",
        parentItemId: `${T}:tool:toolu_A`,
        relativePath: "projects/-work/S1/subagents/agent-adf30a45303a0efdb.jsonl",
      },
    ]);
  });

  test("meta.json links a running foreground Agent before any result; the same files give the same rows whenever read", () => {
    const sidecars = fakeSidecars({
      agentMetas: () => [{ agentId: "a0251b6774d67bf0b", meta: { agentType: "general-purpose", description: "Extract policies", name: "policy-extractor", toolUseId: "toolu_F", finished: false } }],
    });
    const all = records([prompt(1, null, "go"), agentCall(2, 1, "toolu_F")]);
    const live = createClaudeProjector(ctx({ sidecars, live: "busy" }));
    live.push(all);
    const s = live.snapshot();
    assert.equal(s.subagents[0]!.status, "running");
    assert.equal(s.subagents[0]!.title, "policy-extractor");
    assert.equal(s.visibleTurnItems[1]!.x?.link?.evidence, "meta.toolUseId");
    const dead = createClaudeProjector(ctx({ sidecars }));
    dead.push(all);
    assert.equal(dead.snapshot().subagents[0]!.status, "interrupted", "no process and no result");
  });

  test("Workflow: run handles from the result, agents from the final json or the journal", () => {
    const wfCall = assistant(2, 1, "m", 0, { type: "tool_use", id: "toolu_W", name: "Workflow", input: { script: "export const meta = { name: 'ah' }" } });
    const wfResult = toolResult(3, 2, "toolu_W", "Workflow launched in background.", { status: "async_launched", taskId: "wn9u7by8l", taskType: "local_workflow", workflowName: "ah-calibrate", runId: "wf_ed6e6520-43d", transcriptDir: "/old/place", scriptPath: "/old/s.js" }); // T3296a420:6633
    const journal = [
      { type: "launched" },
      { type: "started", key: "k1", agentId: "a8434b96582978c48", label: "type:runs", phase: "Type" }, // EX:L91
      { type: "result", key: "k1", agentId: "a8434b96582978c48", result: { ok: true } }, // EX:L90
    ];
    const lines = [prompt(1, null, "run wf"), wfCall, wfResult];
    const p1 = onePiece(lines, { sidecars: fakeSidecars({ workflowJournal: (runId) => (runId === "wf_ed6e6520-43d" ? journal : []) }), live: "busy" });
    const s1 = p1.snapshot().subagents[0]!;
    assert.equal(s1.status, "running");
    assert.equal(s1.title, "ah-calibrate");
    assert.deepEqual(s1.workflow?.runHandles, { runId: "wf_ed6e6520-43d", transcriptDir: "/old/place", scriptPath: "/old/s.js" });
    assert.deepEqual(s1.workflow?.phases, [{ index: 1, title: "Type" }]);
    assert.deepEqual(
      s1.workflow?.agents.map((a) => [a.label, a.state, a.childThreadId, a.result]),
      [["type:runs", "completed", `${T}:agent-a8434b96582978c48`, '{"ok":true}']],
    );
    assert.equal(p1.children()[0]!.relativePath, "projects/-work/S1/subagents/workflows/wf_ed6e6520-43d/agent-a8434b96582978c48.jsonl");

    const final = {
      runId: "wf_ed6e6520-43d",
      workflowName: "ah-calibrate",
      status: "completed",
      phases: [{ title: "Type" }],
      workflowProgress: [
        { type: "workflow_phase", index: 1, title: "Type" },
        { type: "workflow_agent", index: 1, label: "type:runs", phaseIndex: 1, phaseTitle: "Type", agentId: "a8434b96582978c48", model: "claude-sonnet-5-5", state: "done", tokens: 316976, toolCalls: 85, durationMs: 1079865, resultPreview: "{\"summary\":\"ok\"}" },
      ],
      totalTokens: 1488164,
      totalToolCalls: 377,
      durationMs: 1187333,
    };
    const p2 = onePiece(lines, { sidecars: fakeSidecars({ workflowFinal: () => final, workflowJournal: () => journal }) });
    const s2 = p2.snapshot().subagents[0]!;
    assert.equal(s2.status, "completed");
    assert.equal(s2.workflow?.totalTokens, 1488164);
    assert.equal(s2.workflow?.toolCalls, 377);
    assert.equal(s2.workflow?.agents[0]!.totalTokens, 316976);
    assert.equal(s2.workflow?.agents[0]!.state, "completed");
  });

  test("Workflow resumed after its final record: every card of the run shows the journal and keeps the earlier numbers (DESIGN.md 6e, 6i)", () => {
    const RUN = "wf_5d1c0a2b-9e1";
    const launch = (n: number, id: string, taskId: string) => [
      assistant(n, n - 1, `m${n}`, 0, { type: "tool_use", id, name: "Workflow", input: { script: "export const meta = { name: 'probe' }" } }),
      toolResult(n + 1, n, id, "Workflow launched in background.", { status: "async_launched", taskId, taskType: "local_workflow", workflowName: "probe", runId: RUN }),
    ];
    const killed = {
      runId: RUN, workflowName: "probe", status: "killed",
      workflowProgress: [
        { type: "workflow_agent", index: 1, label: "quick", agentId: "aquick000000000001", state: "done", tokens: 21087, toolCalls: 0, durationMs: 2700 },
        { type: "workflow_agent", index: 2, label: "slow", agentId: "aslow0000000000001", state: "running" },
      ],
    };
    // The resume appends to the journal: slow starts again under a new agent id, quick comes from the cache.
    const journal = [
      { type: "launched" },
      { type: "started", key: "q", agentId: "aquick000000000001", label: "quick" },
      { type: "result", key: "q", agentId: "aquick000000000001", result: "ok" },
      { type: "started", key: "s", agentId: "aslow0000000000001", label: "slow" },
      { type: "launched" },
      { type: "started", key: "s", agentId: "aslow0000000000002", label: "slow" },
    ];
    // The resumed run's own final record: quick only `cached: true`, no numbers (measured 2026-11-16).
    const done = {
      runId: RUN, workflowName: "probe", status: "completed",
      workflowProgress: [
        { type: "workflow_agent", index: 1, label: "quick", agentId: "aquick000000000001", state: "done", cached: true },
        { type: "workflow_agent", index: 2, label: "slow", agentId: "aslow0000000000002", state: "done", tokens: 24500, toolCalls: 1, durationMs: 45800 },
      ],
    };
    const files = { final: killed as object, journal, resumed: false };
    const sidecars = fakeSidecars({ workflowFinal: () => files.final, workflowJournal: () => files.journal, workflowResumed: () => files.resumed });
    const notification = (n: number, toolUseId: string, taskId: string) => ({
      parentUuid: U(n - 1), type: "user", origin: { kind: "task-notification" }, uuid: U(n), timestamp: ts(),
      message: { role: "user", content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>killed</status>\n<summary>stopped</summary>\n</task-notification>` },
    });
    const p = onePiece([prompt(1, null, "run it"), ...launch(2, "toolu_W1", "w1"), notification(4, "toolu_W1", "w1"), ...launch(5, "toolu_W2", "w2")], { sidecars, live: "busy" });
    const cards = () => p.snapshot().subagents.map((s) => ({ status: s.status, agents: s.workflow?.agents.map((a) => [a.agentId, a.state, a.totalTokens ?? null]) }));
    const stopped = cards();
    assert.deepEqual(stopped.map((c) => c.status), ["cancelled", "cancelled"], "both cards show the final record's status");
    assert.deepEqual(stopped[1]!.agents, [["aquick000000000001", "completed", 21087], ["aslow0000000000001", "running", null]]);

    files.resumed = true;
    p.refreshSidecars();
    const running = cards();
    assert.deepEqual(running.map((c) => c.status), ["running", "running"], "the journal written after the final record runs the run again");
    assert.deepEqual(running[0]!.agents, [["aquick000000000001", "completed", 21087], ["aslow0000000000002", "running", null]],
      "the journal's agents, the restarted one in its row, the cached one with the earlier numbers");
    assert.deepEqual(running[0], running[1]);

    files.final = done;
    files.resumed = false;
    p.refreshSidecars();
    const finished = cards();
    assert.deepEqual(finished.map((c) => c.status), ["completed", "completed"]);
    assert.deepEqual(finished[0]!.agents, [["aquick000000000001", "completed", 21087], ["aslow0000000000002", "completed", 24500]],
      "the cached agent keeps the numbers of the run that did its work");

    const after = onePiece([prompt(1, null, "run it"), ...launch(2, "toolu_W1", "w1"), notification(4, "toolu_W1", "w1")], { sidecars: fakeSidecars({ workflowFinal: () => done }) });
    assert.deepEqual(after.snapshot().subagents[0]!.workflow?.agents.map((a) => a.totalTokens ?? null), [null, 24500],
      "a projector that never saw the earlier record has no numbers for the cached agent");
  });

  test("fork subagent: inherited-context notice, the copied Agent call hidden, the boilerplate as first prompt (Tfork:1-3)", () => {
    const sub = createClaudeProjector(ctx({ threadId: `${T}:agent-ad98`, agentId: "ad98", path: "/home/u/.claude/projects/-work/S1/subagents/agent-ad98.jsonl" }));
    sub.push(
      records([
        { type: "fork-context-ref", agentId: "ad98", parentSessionId: "S1", parentLastUuid: U(90), contextLength: 1597 }, // EX:L88
        { parentUuid: null, isSidechain: true, type: "assistant", message: { model: "m", id: "msg_F", role: "assistant", content: [{ type: "tool_use", id: "toolu_K", name: "Agent", input: { subagent_type: "fork", prompt: "p" } }] }, apiBlockIndex: 2, uuid: U(91), timestamp: ts() },
        { parentUuid: U(91), isSidechain: true, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_K", content: [{ type: "text", text: "Fork started - that fork is you." }] }, { type: "text", text: "<fork-boilerplate>\nYou are a worker fork." }] }, uuid: U(92), timestamp: ts() }, // EX:L94
      ]),
    );
    const s = sub.snapshot();
    assert.deepEqual(
      s.visibleTurnItems.map((r) => [r.item.type, r.visibility]),
      [["system_notice", "synthetic"], ["user_message", "local"]],
    );
    assert.equal(s.visibleTurnItems[0]!.x?.inheritsContextUntil, U(90));
    assert.deepEqual(s.lineage, { parentThreadId: T, relationshipToParent: "subagent", rootThreadId: T });
    assert.equal(s.runs.length, 1, "row 1a opens a run");
    assert.equal(sub.stats().hiddenByKey["claude|sub|type=assistant|block=tool_use|tool=Agent|forkCopy"], 1);
  });
});

describe("unknown records and the denominator (7.11)", () => {
  test("unknown keys are counted, uuid lines become folded notices, the invariant holds", () => {
    const p = onePiece([
      prompt(1, null, "x"),
      { type: "brand-new-type", uuid: U(2), parentUuid: U(1), timestamp: ts() },
      { type: "another-new-type", sessionId: "S1" },
      { parentUuid: U(1), type: "attachment", attachment: { type: "brand_new_attachment" }, uuid: U(3), timestamp: ts() },
      { parentUuid: U(1), type: "attachment", attachment: { type: "date", date: "2026-11-15" }, uuid: U(4), timestamp: ts() }, // EX:L217
      { noType: true },
      "{broken json",
      assistant(5, 1, "m", 0, { type: "tool_use", id: "t_mcp", name: "mcp__new__thing", input: {} }),
    ]);
    const st = p.stats();
    assert.equal(st.linesRead, 8);
    assert.equal(st.parseFailures, 1);
    assert.deepEqual(st.unknownByKey, {
      "claude|top|type=brand-new-type": 1,
      "claude|top|type=another-new-type": 1,
      "claude|top|type=attachment|attachment.type=brand_new_attachment": 1,
      "claude|top|<no-type>": 1,
    });
    assert.equal(st.hiddenByKey["claude|top|type=attachment|attachment.type=date"], 1);
    assert.equal(st.displayedByKey["claude|top|type=assistant|block=tool_use|tool=mcp__new__thing"], 1, "a new tool name is shown and counted by name");
    assert.ok(invariantHolds(p));
    const unknownRows = p.snapshot().visibleTurnItems.filter((r) => r.x?.unknown === true);
    assert.deepEqual(unknownRows.map((r) => r.item.id.slice(T.length + 1)), [`uuid:${U(2)}`, `uuid:${U(3)}`]);
  });

  test("goal_status: a sentinel draws nothing; a row is the state and the condition, the reason its folded body (2.1.325)", () => {
    const goal = (n: number, attachment: Record<string, unknown>) => ({ parentUuid: U(1), type: "attachment", attachment: { type: "goal_status", ...attachment }, uuid: U(n), timestamp: ts() });
    const p = onePiece([
      prompt(1, null, "/goal all tests pass"),
      goal(2, { met: false, sentinel: true, condition: "all tests pass" }), // the 105 of 297 records the survey found
      goal(3, { met: false, condition: "all tests pass", reason: "Two tests still fail.\nThe build is red." }),
      goal(4, { met: false, failed: true, condition: "all tests pass", reason: "The suite cannot run here." }),
      goal(5, { met: true, condition: "all tests pass", reason: "All 12 tests pass.", iterations: 3, durationMs: 61000, tokens: 12000 }),
      goal(6, { met: true, sentinel: true, condition: "all tests pass" }),
    ]);
    const st = p.stats();
    assert.equal(st.hiddenByKey["claude|top|type=attachment|attachment.type=goal_status|sentinel"], 2);
    assert.equal(st.displayedByKey["claude|top|type=attachment|attachment.type=goal_status"], 3);
    assert.ok(invariantHolds(p));
    const rows = p.snapshot().visibleTurnItems.filter((r) => r.x?.noticeKind === "goal");
    assert.deepEqual(
      rows.map((r) => [r.item.type === "system_notice" ? r.item.message : null, r.item.type === "system_notice" ? r.item.level : null, r.x?.body ?? null]),
      [
        ["Goal not met: all tests pass", "info", "Two tests still fail.\nThe build is red."],
        ["Goal cannot be met: all tests pass", "error", "The suite cannot run here."],
        ["Goal met: all tests pass", "info", "All 12 tests pass."],
      ],
    );
    assert.deepEqual(rows[2]!.x?.data, { condition: "all tests pass", met: true, failed: false, reason: "All 12 tests pass.", iterations: 3, durationMs: 61000, tokens: 12000 });
  });

  describe("state.goal (the /goal of a Claude session)", () => {
    const att = (n: number, attachment: Record<string, unknown>, sec: number) => ({
      parentUuid: U(n - 1), type: "attachment", attachment: { type: "goal_status", ...attachment }, uuid: U(n), timestamp: new Date(Date.UTC(2026, 10, 15, 0, 0, sec)).toISOString(),
    });
    const at = (sec: number) => Date.UTC(2026, 10, 15, 0, 0, sec);
    const setRec = (n: number, sec: number, c = "all tests pass") => att(n, { met: false, sentinel: true, condition: c }, sec);
    const unmetRec = (n: number, sec: number, reason: string, c = "all tests pass") => att(n, { met: false, condition: c, reason }, sec);
    const metRec = (n: number, sec: number, c = "all tests pass") => att(n, { met: true, condition: c, reason: "done", iterations: 2 }, sec);
    const clearRec = (n: number, sec: number, c = "all tests pass") => att(n, { met: true, sentinel: true, condition: c }, sec);
    const goalOf = (p: ReturnType<typeof onePiece>) => p.snapshot().state.goal;

    test("absent while no goal_status line is known", () => {
      const p = onePiece([prompt(1, null, "hello")]);
      assert.equal("goal" in p.snapshot().state, false);
    });

    test("a set alone, then checks with the newest reason", () => {
      const p = onePiece([prompt(1, null, "/goal all tests pass"), setRec(2, 10)]);
      assert.deepEqual(goalOf(p), { objective: "all tests pass", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, claude: { checks: 0, setAt: at(10), lastReason: null } });
      p.push(records([unmetRec(3, 20, "one"), unmetRec(4, 30, "two")]).map((r, i) => ({ ...r, offset: 10_000 + i * 1000 })));
      assert.deepEqual(goalOf(p)!.claude, { checks: 2, setAt: at(10), lastReason: "two" });
    });

    test("met ends it as null (present, so a patch can clear it), and a goal set again starts over", () => {
      const p = onePiece([setRec(2, 10), unmetRec(3, 20, "x")]);
      const patched = (events: ThreadLiveEvent[]) => events.flatMap((e) => (e.t === "thread.patched" && e.state && "goal" in e.state ? [e.state.goal] : []));
      const afterMet = patched(p.push(records([metRec(4, 30)]).map((r) => ({ ...r, offset: 10_000 }))));
      assert.deepEqual(afterMet, [null]);
      assert.equal(goalOf(p), null);
      const afterSet = patched(p.push(records([setRec(5, 40, "b")]).map((r) => ({ ...r, offset: 20_000 }))));
      assert.equal(afterSet.length, 1);
      assert.equal(goalOf(p)!.objective, "b");
      assert.equal(goalOf(p)!.claude!.checks, 0);
    });

    test("failed and clear end it", () => {
      assert.equal(goalOf(onePiece([setRec(2, 10), att(3, { met: false, failed: true, condition: "all tests pass", reason: "no" }, 20)])), null);
      assert.equal(goalOf(onePiece([setRec(2, 10), unmetRec(3, 15, "x"), clearRec(4, 20)])), null);
    });

    test("an older page that holds the set joins the later lines (refold keeps one count)", () => {
      const lines = records([setRec(2, 10), prompt(3, 2, "more"), unmetRec(4, 20, "a"), unmetRec(5, 30, "b")]);
      const p = createClaudeProjector(ctx());
      p.push(lines.slice(2));
      assert.deepEqual(goalOf(p)!.claude, { checks: 2, setAt: at(20), lastReason: "b" }, "without the set, the first unmet starts the count");
      p.prepend(lines.slice(0, 2));
      assert.deepEqual(goalOf(p)!.claude, { checks: 2, setAt: at(10), lastReason: "b" });
    });

    test("a scanned history stands for the lines before its end; later lines add to it", () => {
      const lines = records([setRec(2, 10), unmetRec(3, 20, "a"), unmetRec(4, 30, "b"), unmetRec(5, 40, "c")]);
      const p = createClaudeProjector(ctx());
      p.push(lines.slice(2)); // the page reaches back to the second check only
      const scanEnd = lines[3]!.offset; // the scan saw the file up to the last line
      const events = p.setGoalHistory({
        events: [
          { offset: lines[0]!.offset, kind: "set", condition: "all tests pass", reason: null, at: at(10) },
          { offset: lines[1]!.offset, kind: "unmet", condition: "all tests pass", reason: "a", at: at(20) },
          { offset: lines[2]!.offset, kind: "unmet", condition: "all tests pass", reason: "b", at: at(30) },
        ],
        endOffset: scanEnd,
      });
      const patch = events.find((e) => e.t === "thread.patched");
      assert.ok(patch, "the scan changes state.goal, which goes out as a patch");
      // history: set + a + b (2 checks); the page's line at/after the end (c) is counted once
      assert.deepEqual(goalOf(p)!.claude, { checks: 3, setAt: at(10), lastReason: "c" });
    });

    test("a long turn with no goal_status line in the page: the scan alone gives the goal", () => {
      const p = onePiece([prompt(1, null, "work")]);
      assert.equal("goal" in p.snapshot().state, false);
      p.setGoalHistory({ events: [{ offset: 0, kind: "set", condition: "c", reason: null, at: at(5) }], endOffset: 1 });
      assert.deepEqual(goalOf(p)!.claude, { checks: 0, setAt: at(5), lastReason: null });
    });

    test("a live process's active_goal wins while the transcript is behind it, then the transcript takes over", () => {
      const p = onePiece([setRec(2, 10), unmetRec(3, 20, "t")]);
      const live = { value: { condition: "all tests pass", iterations: 5, setAt: at(10), lastReason: "live" }, receivedAt: at(25) };
      p.setTurns({ run: { busy: true, waiting: false, busySince: null, permissionMode: null, activeGoal: live }, ends: [] });
      assert.deepEqual(goalOf(p)!.claude, { checks: 5, setAt: at(10), lastReason: "live" });
      // the transcript's next record is newer than the live message
      p.push(records([unmetRec(4, 40, "later")]).map((r) => ({ ...r, offset: 10_000 })));
      assert.deepEqual(goalOf(p)!.claude, { checks: 2, setAt: at(10), lastReason: "later" });
    });

    test("a live clear hides a goal the transcript still shows; no process, the transcript decides", () => {
      const p = onePiece([setRec(2, 10)]);
      p.setTurns({ run: { busy: false, waiting: false, busySince: null, permissionMode: null, activeGoal: { value: null, receivedAt: at(20) } }, ends: [] });
      assert.equal(goalOf(p), null);
      p.setTurns({ run: null, ends: [] });
      assert.equal(goalOf(p)!.objective, "all tests pass");
    });
  });

  test("user line rows 5.4: interrupt, slash command, command output, meta reminder", () => {
    const p = onePiece([
      prompt(1, null, "<command-name>/config</command-name>\n<command-message>config</command-message>\n<command-args>x y</command-args>"), // T3296a420:7336
      { parentUuid: U(1), type: "user", message: { role: "user", content: "<local-command-stdout>Set it</local-command-stdout>" }, uuid: U(2), timestamp: ts() },
      { parentUuid: U(2), type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, uuid: U(3), timestamp: ts() }, // EX:L285
      { parentUuid: U(3), type: "user", message: { role: "user", content: "<system-reminder>x</system-reminder>" }, isMeta: true, uuid: U(4), timestamp: ts() },
    ]);
    const s = p.snapshot();
    assert.deepEqual(
      s.visibleTurnItems.map((r) => [r.item.type, "text" in r.item ? r.item.text : "message" in r.item ? r.item.message : ""]),
      [["user_message", "/config x y"], ["system_notice", "Set it"], ["run_interrupt_result", "[Request interrupted by user]"]],
    );
    assert.equal(s.runs[0]!.status, "interrupted");
    assert.equal(p.stats().hiddenByKey["claude|top|type=user|content=str|row=12"], 1);
  });
});

describe("pending requests and readonly threads (6.1, 7.10)", () => {
  const ask = () => [
    prompt(1, null, "ask me"),
    assistant(2, 1, "m", 0, { type: "tool_use", id: "t_ask", name: "AskUserQuestion", input: { questions: [{ question: "Which?", header: "H", options: [{ label: "A", description: "a" }], multiSelect: false }] } }), // EX:L157
  ];

  test("a readonly thread lists no pending input and sends no pending event", () => {
    const p = createClaudeProjector(ctx({ live: "waiting" }));
    const ev = p.push(records(ask()));
    assert.deepEqual(p.pending(), { approvals: [], userInputs: [] });
    assert.ok(!ev.some((e) => e.t === "pending.updated"));
    const item = p.snapshot().visibleTurnItems[1]!.item;
    assert.equal(item.status, "waiting", "the request item itself shows waiting");
    assert.equal(p.snapshot().runs[0]!.status, "waiting");
  });

  test("a controllable thread lists it, and the answer clears it", () => {
    const all = records([
      ...ask(),
      toolResult(3, 2, "t_ask", "answered", { questions: [], answers: { "Which?": "A" }, annotations: {} }), // T3296a420:71
    ]);
    const p = createClaudeProjector(ctx({ readonly: false, live: "busy" }));
    const ev = p.push(all.slice(0, 2));
    const pending = ev.find((e) => e.t === "pending.updated");
    assert.ok(pending !== undefined && pending.t === "pending.updated" && pending.userInputs.length === 1);
    assert.equal(p.snapshot().state.control, "headless");
    const ev2 = p.push(all.slice(2));
    assert.ok(ev2.some((e) => e.t === "pending.updated" && e.userInputs.length === 0));
    const item = p.snapshot().visibleTurnItems[1]!.item;
    assert.equal(item.type, "user_input_request");
    if (item.type === "user_input_request") {
      assert.deepEqual(item.questionAnswer?.answers, { "0": "A" });
      assert.equal(item.requestId, item.id);
    }
  });
});

describe("terminal mode contract (DESIGN.md 6i)", () => {
  const byId = (p: ReturnType<typeof createClaudeProjector>) => new Map(p.snapshot().visibleTurnItems.map((r) => [r.item.id.slice(T.length + 1), r]));

  test("file_change keeps its tool name; Bash keeps description and run_in_background", () => {
    const p = onePiece([
      prompt(1, null, "x"),
      // A Write over an existing file: the result says "update" (2.1.325 transcripts, 369 of 2,358 Writes).
      assistant(2, 1, "m", 0, { type: "tool_use", id: "t_w", name: "Write", input: { file_path: "/a.txt", content: "new\n" } }),
      toolResult(3, 2, "t_w", "updated", { type: "update", filePath: "/a.txt", content: "new\n", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }], originalFile: "old\n" }),
      assistant(4, 3, "m", 1, { type: "tool_use", id: "t_e", name: "Edit", input: { file_path: "/a.txt", old_string: "new", new_string: "x" } }),
      assistant(5, 4, "m", 2, { type: "tool_use", id: "t_bg", name: "Bash", input: { command: "sleep 9", description: "Wait nine seconds", run_in_background: true } }),
      assistant(6, 5, "m", 3, { type: "tool_use", id: "t_old", name: "Bash", input: { command: "ls" } }),
    ]);
    const rows = byId(p);
    assert.deepEqual(rows.get("tool:t_w")!.x?.data, { toolName: "Write" });
    const w = rows.get("tool:t_w")!.item;
    assert.equal(w.type === "file_change" && w.additions, 1);
    assert.deepEqual(rows.get("tool:t_e")!.x?.data, { toolName: "Edit" });
    assert.deepEqual(rows.get("tool:t_bg")!.x?.data, { description: "Wait nine seconds", runInBackground: true });
    assert.equal(rows.get("tool:t_old")!.x?.data, undefined, "a call without either field has no data");
  });

  test("WebFetch: the answer is the snippet and the fetch facts ride on the result row", () => {
    const fetch = (id: string) => ({ type: "tool_use", id, name: "WebFetch", input: { url: "https://x.com/s/1", prompt: "summary" } });
    const answer = "The server returned HTTP 402 Payment Required.";
    const p = onePiece([
      prompt(1, null, "x"),
      assistant(2, 1, "m", 0, fetch("t_f")),
      // 2.1.325 shape (361 of 361 WebFetch results scanned)
      toolResult(3, 2, "t_f", answer, { bytes: 0, code: 402, codeText: "Payment Required", result: answer, durationMs: 338, url: "https://x.com/s/1" }),
      assistant(4, 3, "m", 1, fetch("t_old")),
      toolResult(5, 4, "t_old", "page text"),
    ]);
    const rows = byId(p);
    const f = rows.get("tool:t_f")!.item;
    assert.equal(f.type, "web_search");
    if (f.type === "web_search") {
      assert.deepEqual(f.results, [{ url: "https://x.com/s/1", snippet: answer, bytes: 0, code: 402, codeText: "Payment Required", durationMs: 338 }]);
    }
    const old = rows.get("tool:t_old")!.item;
    assert.deepEqual(old.type === "web_search" && old.results, [{ url: "https://x.com/s/1", snippet: "page text" }], "a result without toolUseResult keeps the text only");
  });

  test("assistant text carries its model; effort and transcriptPath land in the thread state", () => {
    const p = createClaudeProjector(ctx());
    const all = records([
      prompt(1, null, "x"),
      assistant(2, 1, "m1", 0, { type: "text", text: "a" }, { effort: "xhigh" }),
      { ...assistant(3, 2, "m2", 0, { type: "text", text: "b" }), message: { model: "claude-haiku-4-5-20251001", id: "m2", role: "assistant", content: [{ type: "text", text: "b" }] } },
    ]);
    p.push(all.slice(0, 2));
    const s = p.snapshot();
    const a = s.visibleTurnItems[1]!.item;
    assert.equal(a.type === "assistant_message" && a.model, "claude-opus-5-5");
    assert.equal(s.state.effort, "xhigh");
    assert.equal(s.state.transcriptPath, PATH);
    const ev = p.push(all.slice(2));
    const patched = ev.find((e) => e.t === "thread.patched");
    assert.ok(patched !== undefined && patched.t === "thread.patched");
    assert.equal(patched.state?.model, "claude-haiku-4-5-20251001");
    assert.equal(patched.state?.effort, null, "a response without effort clears it, as null so the merge carries it");
    assert.equal(p.snapshot().state.effort, null);
    const old = onePiece([prompt(1, null, "x"), assistant(2, 1, "m1", 0, { type: "text", text: "a" })]);
    assert.ok(!("effort" in old.snapshot().state), "a transcript that never recorded effort has no key");
    const b = p.snapshot().visibleTurnItems[2]!.item;
    assert.equal(b.type === "assistant_message" && b.model, "claude-haiku-4-5-20251001");
  });

  test("tokenUsage: maxTokens from the request record or the model, runOutputTokens for the latest run", () => {
    const req = (model: string, betas: string[]) => ({ type: "api-request", sessionId: "S1", timestamp: ts(), querySource: "repl_main_thread", params: { model, betas, max_tokens: 64000 } });
    const step = (n: number, parent: number, id: string, model: string, output: number) => ({
      ...assistant(n, parent, id, 0, { type: "text", text: id }),
      message: { model, id, role: "assistant", content: [{ type: "text", text: id }], usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output } },
    });
    // claude-opus-4-6 takes 1M only with the context-1m beta (CLI 2.1.325 catalog).
    const wide = onePiece([prompt(1, null, "x"), req("claude-opus-4-6", ["claude-code-20250219", "context-1m-2025-08-07"]), step(2, 1, "a", "claude-opus-4-6", 7)]);
    assert.equal(wide.snapshot().tokenUsage?.maxTokens, 1_000_000);
    const narrow = onePiece([prompt(1, null, "x"), req("claude-opus-4-6", ["claude-code-20250219"]), step(2, 1, "a", "claude-opus-4-6", 7)]);
    assert.equal(narrow.snapshot().tokenUsage?.maxTokens, 200_000);
    // state.oneMillion: the transcript's model has no [1m], the request's beta stands for it.
    assert.equal(wide.snapshot().state.oneMillion, true);
    assert.equal(narrow.snapshot().state.oneMillion, false);
    const nativeWide = onePiece([prompt(1, null, "x"), req("claude-opus-5-5", ["context-1m-2025-08-07"]), step(2, 1, "a", "claude-opus-5-5", 7)]);
    assert.equal(nativeWide.snapshot().state.oneMillion, false, "a model with one window has no 1M run to name");
    const noRequest = onePiece([prompt(1, null, "x"), step(2, 1, "a", "claude-opus-4-6", 7)]);
    assert.equal(noRequest.snapshot().state.oneMillion, undefined, "no request record");
    assert.equal(noRequest.snapshot().tokenUsage?.maxTokens, undefined, "without a request record the 1M context is unknown");
    const big = step(3, 2, "b", "claude-opus-4-6", 7);
    big.message.usage = { input_tokens: 1, cache_read_input_tokens: 240_000, cache_creation_input_tokens: 0, output_tokens: 7 };
    const overflow = onePiece([prompt(1, null, "x"), step(2, 1, "a", "claude-opus-4-6", 7), big, step(4, 3, "c", "claude-opus-4-6", 7)]);
    assert.equal(overflow.snapshot().tokenUsage?.maxTokens, 1_000_000, "an earlier context over 200k shows the 1M context");
    const native = onePiece([prompt(1, null, "x"), step(2, 1, "a", "claude-opus-5-5", 7)]);
    assert.equal(native.snapshot().tokenUsage?.maxTokens, 1_000_000);
    const unknown = onePiece([prompt(1, null, "x"), step(2, 1, "a", "claude-future-9", 7)]);
    assert.equal(unknown.snapshot().tokenUsage?.maxTokens, undefined);

    const p = createClaudeProjector(ctx());
    const all = records([prompt(1, null, "x"), step(2, 1, "r1a", "claude-opus-5-5", 10), step(3, 2, "r1b", "claude-opus-5-5", 20), prompt(4, 3, "y"), step(5, 4, "r2a", "claude-opus-5-5", 5)]);
    p.push(all.slice(0, 3));
    assert.equal(p.snapshot().tokenUsage?.runOutputTokens, 30);
    const ev = p.push(all.slice(3, 4));
    const fresh = ev.find((e) => e.t === "tokenUsage.updated");
    assert.ok(fresh !== undefined && fresh.t === "tokenUsage.updated" && fresh.usage.runOutputTokens === 0, "a new run starts at 0");
    p.push(all.slice(4));
    const u = p.snapshot().tokenUsage!;
    assert.equal(u.runOutputTokens, 5);
    assert.equal(u.lastOutputTokens, 5);
    assert.equal(u.outputTokens, 35);
  });

  test("tokenUsage.promptCache: the latest cache-using message's first line time and TTL, cold after a compaction", () => {
    const step = (n: number, parent: number, id: string, usage: Record<string, unknown>, at: string) => ({
      ...assistant(n, parent, id, 0, { type: "text", text: id }),
      timestamp: at,
      message: { model: "claude-opus-5-5", id, role: "assistant", content: [{ type: "text", text: id }], usage: { input_tokens: 1, output_tokens: 4, ...usage } },
    });
    const cc = (fiveMinute: number, oneHour: number) => ({ cache_creation: { ephemeral_5m_input_tokens: fiveMinute, ephemeral_1h_input_tokens: oneHour } });
    const hour = step(2, 1, "a", { cache_creation_input_tokens: 50, cache_read_input_tokens: 0, ...cc(0, 50) }, "2026-11-17T01:00:00.000Z");
    assert.deepEqual(onePiece([prompt(1, null, "x"), hour]).snapshot().tokenUsage?.promptCache, { at: "2026-11-17T01:00:00.000Z", ttlMs: 3_600_000 });
    const five = step(2, 1, "a", { cache_creation_input_tokens: 50, cache_read_input_tokens: 9, ...cc(50, 0) }, "2026-11-17T01:00:00.000Z");
    assert.equal(onePiece([prompt(1, null, "x"), five]).snapshot().tokenUsage?.promptCache?.ttlMs, 300_000);
    // A pure read keeps the TTL of the write before it and moves the time.
    const read = step(3, 2, "b", { cache_creation_input_tokens: 0, cache_read_input_tokens: 70, ...cc(0, 0) }, "2026-11-17T01:30:00.000Z");
    assert.deepEqual(onePiece([prompt(1, null, "x"), hour, read]).snapshot().tokenUsage?.promptCache, { at: "2026-11-17T01:30:00.000Z", ttlMs: 3_600_000 });
    // A second line of the same message keeps the first line's time.
    const later = { ...step(3, 2, "a", { cache_creation_input_tokens: 50, cache_read_input_tokens: 0, ...cc(0, 50) }, "2026-11-17T01:02:00.000Z"), apiBlockIndex: 1 };
    assert.equal(onePiece([prompt(1, null, "x"), hour, later]).snapshot().tokenUsage?.promptCache?.at, "2026-11-17T01:00:00.000Z");
    // No cache tokens, no cache information; no split falls back to five minutes.
    assert.equal(onePiece([prompt(1, null, "x"), step(2, 1, "a", { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, "2026-11-17T01:00:00.000Z")]).snapshot().tokenUsage?.promptCache, undefined);
    assert.equal(onePiece([prompt(1, null, "x"), step(2, 1, "a", { cache_creation_input_tokens: 5, cache_read_input_tokens: 0 }, "2026-11-17T01:00:00.000Z")]).snapshot().tokenUsage?.promptCache?.ttlMs, 300_000);
    // Compaction: cold until the next cache-using response.
    const boundary = { parentUuid: null, logicalParentUuid: U(2), type: "system", subtype: "compact_boundary", content: "Conversation compacted", level: "info", compactMetadata: { trigger: "manual", preTokens: 9, postTokens: 3, durationMs: 1 }, uuid: U(3), timestamp: "2026-11-17T01:05:00.000Z" };
    const cold = onePiece([prompt(1, null, "x"), hour, boundary]).snapshot().tokenUsage?.promptCache;
    assert.deepEqual(cold, { at: "2026-11-17T01:00:00.000Z", ttlMs: 3_600_000, cold: true });
    const after = step(4, 3, "c", { cache_creation_input_tokens: 5, cache_read_input_tokens: 0, ...cc(0, 5) }, "2026-11-17T01:06:00.000Z");
    assert.deepEqual(onePiece([prompt(1, null, "x"), hour, boundary, after]).snapshot().tokenUsage?.promptCache, { at: "2026-11-17T01:06:00.000Z", ttlMs: 3_600_000 });
  });

  test("subagent record: type, resolved model, totals and background from results, notifications and meta.json", () => {
    const call = (n: number, parent: number, id: string, input: Record<string, unknown>) => assistant(n, parent, `msg_${n}`, 0, { type: "tool_use", id, name: "Agent", input: { description: id, prompt: "p", ...input } });
    const sidecars = fakeSidecars({
      agentMetas: () => [{ agentId: "a3", meta: { agentType: "Explore", description: "t_meta", toolUseId: "t_meta", model: "haiku", pickedEffortModel: "claude-haiku-4-5", finished: true } }],
    });
    const p = onePiece(
      [
        prompt(1, null, "x"),
        // Foreground agent, final result (2.1.325: 8 of 1,235 Agent results carry the totals).
        call(2, 1, "t_fg", { subagent_type: "general-purpose" }),
        toolResult(3, 2, "t_fg", [{ type: "text", text: "done" }], { status: "completed", agentId: "a1", agentType: "general-purpose", content: [{ type: "text", text: "done" }], resolvedModel: "claude-opus-4-6", totalDurationMs: 99383, totalTokens: 43490, totalToolUseCount: 6 }),
        // Async launch, then the task notification with <usage>.
        call(4, 3, "t_bg", { subagent_type: "Explore", model: "sonnet" }),
        toolResult(5, 4, "t_bg", [{ type: "text", text: "Async agent launched successfully." }], { isAsync: true, status: "async_launched", agentId: "a2", resolvedModel: "claude-sonnet-5-5" }),
        {
          parentUuid: U(5),
          type: "user",
          message: { role: "user", content: "<task-notification>\n<task-id>a2</task-id>\n<tool-use-id>t_bg</tool-use-id>\n<status>completed</status>\n<summary>Agent \"t_bg\" finished</summary>\n<result>ok</result>\n<usage><subagent_tokens>71038</subagent_tokens><tool_uses>1</tool_uses><duration_ms>127884</duration_ms></usage>\n</task-notification>" },
          origin: { kind: "task-notification" },
          uuid: U(6),
          timestamp: ts(),
        },
        // Asked to run in the background; the record knows it before any result.
        call(7, 6, "t_ask", { run_in_background: true }),
        // Only meta.json knows the type and the resolved model.
        call(8, 7, "t_meta", {}),
        // An old call with nothing but description and prompt.
        call(9, 8, "t_old", {}),
      ],
      { sidecars },
    );
    const subs = new Map(p.snapshot().subagents.map((s) => [s.nativeTaskRef?.nativeId, s]));
    const pick = (id: string) => {
      const s = subs.get(id)!;
      return { agentType: s.agentType, modelResolved: s.modelResolved, toolUses: s.toolUses, totalTokens: s.totalTokens, durationMs: s.durationMs, background: s.background };
    };
    assert.deepEqual(pick("t_fg"), { agentType: "general-purpose", modelResolved: "claude-opus-4-6", toolUses: 6, totalTokens: 43490, durationMs: 99383, background: undefined });
    assert.deepEqual(pick("t_bg"), { agentType: "Explore", modelResolved: "claude-sonnet-5-5", toolUses: 1, totalTokens: 71038, durationMs: 127884, background: true });
    assert.equal(subs.get("t_bg")!.model, "sonnet", "model stays what the call asked for");
    assert.deepEqual(pick("t_ask"), { agentType: undefined, modelResolved: undefined, toolUses: undefined, totalTokens: undefined, durationMs: undefined, background: true });
    assert.deepEqual(pick("t_meta"), { agentType: "Explore", modelResolved: "claude-haiku-4-5", toolUses: undefined, totalTokens: undefined, durationMs: undefined, background: undefined });
    const old = subs.get("t_old")!;
    for (const k of ["agentType", "modelResolved", "toolUses", "totalTokens", "durationMs", "background"]) assert.ok(!(k in old), `${k} is absent`);
  });
});

describe("live events", () => {
  test("rows keep their positions; a result upserts its tool row; liveness changes statuses", () => {
    clock = 0;
    const all = records(basicTurn());
    const p = createClaudeProjector(ctx({ live: "busy" }));
    const ev1 = p.push(all.slice(0, 3));
    const ups = (ev: ThreadLiveEvent[]) => ev.flatMap((e) => (e.t === "turnItem.upserted" ? [[e.row.position, e.row.item.id.slice(T.length + 1), e.row.item.status]] : []));
    assert.deepEqual(ups(ev1), [
      [0, `uuid:${U(1)}`, "completed"],
      [1, "blk:msg_A:0", "completed"],
      [2, "tool:toolu_1", "running"],
    ]);
    const ev2 = p.push(all.slice(3, 4));
    assert.deepEqual(ups(ev2), [[2, "tool:toolu_1", "completed"]]);
    const ev3 = p.push(all.slice(4));
    assert.ok(ev3.some((e) => e.t === "run.upserted" && e.run.status === "completed"));
    assert.ok(ev3.some((e) => e.t === "tokenUsage.updated"));
    const ev4 = p.setLiveStatus(null);
    assert.ok(ev4.some((e) => e.t === "runtime.updated" && e.runtime?.status === "idle"));
  });
});

describe("turn ends of SDK runs (no turn_duration line)", () => {
  // An SDK run writes no turn_duration line; queue operations of the next request follow the
  // finished run's last line (measured on maru transcripts, 2026-11-16).
  const queueOp = (operation: string) => ({ type: "queue-operation", operation, timestamp: ts(), sessionId: "S1" });
  const text = (n: number, parent: number, msg: string, words: string) => assistant(n, parent, msg, 0, { type: "text", text: words });
  const iso = (sec: number) => new Date(Date.UTC(2026, 10, 15, 1, 0, sec)).toISOString();
  const run = (n: number) => `${T}:run:${U(n)}`;

  test("a finished run ends at its last displayed line, not at the next request", () => {
    const lines = [prompt(1, null, "one"), text(2, 1, "m1", "first"), queueOp("enqueue"), queueOp("dequeue"), prompt(3, 2, "two"), text(4, 3, "m2", "second")];
    const p = onePiece(lines);
    const runs = p.snapshot().runs;
    assert.deepEqual(runs.map((r) => r.status), ["completed", "completed"]);
    assert.equal(runs[0]!.completedAt, lines[1]!.timestamp, "the answer's time, not the queue operation's");
    assert.equal(runs[1]!.completedAt, lines[5]!.timestamp);
  });

  test("a run of a process this server runs ends at the result naming its opener, though the registry still says busy", () => {
    const lines = [prompt(1, null, "go"), text(2, 1, "m1", "launched a background agent")];
    const p = createClaudeProjector(ctx({
      readonly: false, live: "busy",
      turns: { run: { busy: true, waiting: false, busySince: iso(0), permissionMode: null }, ends: [] },
    }));
    p.push(records(lines));
    let s = p.snapshot();
    assert.equal(s.runs[0]!.status, "running");
    assert.equal(s.runs[0]!.completedAt, null);
    assert.deepEqual([s.runtime?.status, s.runtime?.activeRunId], ["running", run(1)]);

    const ev = p.setTurns({ run: { busy: false, waiting: false, busySince: null, permissionMode: null }, ends: [{ at: iso(9), userMessageUuids: [U(1)] }] });
    const up = ev.find((e) => e.t === "run.upserted");
    assert.ok(up !== undefined && up.t === "run.upserted");
    assert.deepEqual([up.run.status, up.run.completedAt], ["completed", iso(9)]);
    const rt = ev.find((e) => e.t === "runtime.updated");
    assert.ok(rt !== undefined && rt.t === "runtime.updated");
    assert.deepEqual([rt.runtime?.status, rt.runtime?.activeRunId], ["idle", null]);
    s = p.snapshot();
    assert.deepEqual([s.runs[0]!.status, s.runs[0]!.completedAt, s.runtime?.status], ["completed", iso(9), "idle"]);
    const reg = p.setLiveStatus("idle");
    assert.ok(!reg.some((e) => e.t === "runtime.updated"), "the registry no longer decides");
    assert.ok(reg.every((e) => e.t !== "run.upserted" || (e.run.status === "completed" && e.run.completedAt === iso(9))));
  });

  test("an interrupted run with background tasks left is over once the result came", () => {
    const p = createClaudeProjector(ctx({
      readonly: false, live: "busy",
      turns: { run: { busy: false, waiting: false, busySince: null, permissionMode: null }, ends: [{ at: iso(5), userMessageUuids: [U(1)] }] },
    }));
    p.push(records([
      prompt(1, null, "go"),
      { parentUuid: U(1), type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, uuid: U(2), timestamp: ts() },
    ]));
    const s = p.snapshot();
    assert.deepEqual([s.runs[0]!.status, s.runs[0]!.completedAt], ["interrupted", iso(5)]);
    assert.deepEqual([s.runtime?.status, s.runtime?.activeRunId], ["idle", null]);
  });

  test("a busy process whose latest run ended works on a turn not read yet; its opener then starts the active run", () => {
    const p = createClaudeProjector(ctx({
      readonly: false, live: "busy",
      turns: { run: { busy: true, waiting: false, busySince: iso(20), permissionMode: null }, ends: [{ at: iso(10), userMessageUuids: [U(1)] }] },
    }));
    const all = records([prompt(1, null, "one"), text(2, 1, "m1", "done"), prompt(3, 2, "two")]);
    p.push(all.slice(0, 2));
    let s = p.snapshot();
    assert.deepEqual([s.runs[0]!.status, s.runs[0]!.completedAt], ["completed", iso(10)], "the sent message does not reopen the last run");
    assert.deepEqual([s.runtime?.status, s.runtime?.activeRunId, s.runtime?.activityStartedAt], ["running", null, iso(20)]);
    const ev = p.push(all.slice(2));
    const rt = ev.find((e) => e.t === "runtime.updated");
    assert.ok(rt !== undefined && rt.t === "runtime.updated" && rt.runtime?.activeRunId === run(3));
    s = p.snapshot();
    assert.deepEqual(s.runs.map((r) => r.status), ["completed", "running"]);
  });

  test("a message from another agent keeps its sender and bare body (the CLI's origin), not the wrapper", () => {
    const wrapped = 'Another Claude session sent a message:\n<agent-message from="a0ec">\nstatus: halfway\n</agent-message>';
    const fromOrigin = prompt(2, 1, wrapped, { isMeta: true, origin: { kind: "peer", from: "a0ec", name: "general-purpose", body: "status: halfway" } });
    const wrapperOnly = prompt(3, 2, wrapped, { isMeta: true, origin: { kind: "peer" } });
    const p = createClaudeProjector(ctx());
    p.push(records([prompt(1, null, "go"), fromOrigin, wrapperOnly]));
    const peers = p.snapshot().visibleTurnItems.filter((i) => i.x?.origin?.kind === "peer");
    assert.equal(peers.length, 2);
    for (const i of peers) {
      assert.equal(i.item.type, "user_message");
      assert.equal(i.item.type === "user_message" && i.item.createdBy, "agent");
      assert.equal(i.item.type === "user_message" && i.item.text, "status: halfway");
      assert.equal(i.x?.origin?.from, "a0ec");
    }
    assert.equal(peers[0]!.x?.origin?.name, "general-purpose");
    assert.equal(peers[1]!.x?.origin?.name, undefined, "the wrapper alone has no name");
  });

  test("a turn the CLI started (a task notification) ends at a result without names in its window", () => {
    const notify = prompt(3, 2, "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>", { isMeta: true, origin: { kind: "task-notification" } });
    const lines = [prompt(1, null, "launch"), text(2, 1, "m1", "launched"), notify, text(4, 3, "m2", "the agent finished")];
    const later = "2099-01-01T00:00:00.000Z";
    const p = createClaudeProjector(ctx({
      readonly: false, live: "busy",
      turns: { run: { busy: false, waiting: false, busySince: null, permissionMode: null }, ends: [{ at: iso(30), userMessageUuids: [U(1)] }, { at: later, userMessageUuids: [] }] },
    }));
    p.push(records(lines));
    const runs = p.snapshot().runs;
    assert.deepEqual(runs.map((r) => r.runId), [run(1), run(3)]);
    assert.deepEqual(runs.map((r) => r.completedAt), [iso(30), later]);
  });

  test("the permission mode the process reports is the thread's, and a change goes out as a patch", () => {
    const idle = { busy: false, waiting: false, busySince: null };
    const p = createClaudeProjector(ctx({ readonly: false, live: "idle", turns: { run: { ...idle, permissionMode: "plan" }, ends: [] } }));
    p.push(records([{ type: "permission-mode", permissionMode: "default", sessionId: "S1" }, prompt(1, null, "hi")]));
    assert.equal(p.snapshot().state.permissionMode, "plan", "over the transcript's older line");
    const ev = p.setTurns({ run: { ...idle, permissionMode: "acceptEdits" }, ends: [] });
    assert.ok(ev.some((e) => e.t === "thread.patched" && e.state?.permissionMode === "acceptEdits"));
    const gone = p.setTurns({ run: null, ends: [] });
    assert.ok(gone.some((e) => e.t === "thread.patched" && e.state?.permissionMode === "default"), "the transcript's value once the process is not this server's");
  });
});
