// The rewind screen's facts from a Claude transcript (DESIGN.md 6o). Line shapes follow the
// throwaway transcript of 2026-11-16 (SDK 0.3.321, CLI 2.1.325, file checkpointing on).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  addLine, chainTo, editOf, emptyTranscript, forkCut, markerActive, markerActiveIn, newestNodeUuid, promptText, readRewindTranscript, rewindLeaf, rewindTargets,
  type RewindMarker, type RewindTranscript,
} from "./rewindScan.ts";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const user = (n: number, parent: number | null, content: unknown, extra: Record<string, unknown> = {}) => ({
  parentUuid: parent === null ? null : U(parent), type: "user", message: { role: "user", content }, uuid: U(n), timestamp: `2026-11-16T00:00:${String(n).padStart(2, "0")}Z`, ...extra,
});
const assistant = (n: number, parent: number) => ({ parentUuid: U(parent), type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, uuid: U(n) });
const result = (n: number, parent: number, toolUseResult: unknown) =>
  user(n, parent, [{ type: "tool_result", tool_use_id: `t${n}`, content: "done" }], { toolUseResult });
const snapshot = (n: number) => ({ type: "file-history-snapshot", messageId: U(n), snapshot: { messageId: U(n), trackedFileBackups: {} } });

/** Lines with offsets as a file of them would have. */
function scan(lines: unknown[]): { t: RewindTranscript; offsets: number[]; size: number } {
  const t = emptyTranscript();
  const offsets: number[] = [];
  let off = 0;
  for (const l of lines) {
    offsets.push(off);
    addLine(t, off, l);
    off += Buffer.byteLength(JSON.stringify(l)) + 1;
  }
  return { t, offsets, size: off };
}

const conversation = () => [
  { type: "queue-operation", operation: "enqueue" },
  user(1, null, "Create a.txt"),
  snapshot(1),
  assistant(2, 1),
  result(3, 2, { type: "create", filePath: "/w/a.txt", content: "one\n", structuredPatch: [] }),
  assistant(4, 3),
  user(5, 4, "Edit a.txt"),
  snapshot(5),
  assistant(6, 5),
  result(7, 6, { filePath: "/w/a.txt", structuredPatch: [{ lines: [" keep", "-one", "+one two", "+three"] }] }),
  assistant(8, 7),
  // A task notification and a meta line are openers or user lines, not the user's messages.
  user(9, 8, "<task-notification>done</task-notification>", { isMeta: true, origin: { kind: "task-notification" } }),
  assistant(10, 9),
  user(11, 10, "<command-name>/model</command-name>\n<command-args>opus</command-args>"),
  assistant(12, 11),
];

test("targets are the person's messages of the chain, with checkpoints and the edits after each", () => {
  const { t } = scan(conversation());
  const targets = rewindTargets(t, null);
  assert.deepEqual(targets.map((x) => x.uuid), [U(1), U(5), U(11)]);
  assert.deepEqual(targets.map((x) => x.text), ["Create a.txt", "Edit a.txt", "/model opus"]);
  assert.deepEqual(targets.map((x) => x.checkpoint), [true, true, false]);
  assert.equal(targets[0]!.parentUuid, null, "the first message has no line to resume up to");
  assert.equal(targets[1]!.parentUuid, U(4));
  assert.deepEqual(targets[0]!.turnChanges, { files: ["/w/a.txt"], insertions: 1, deletions: 0 });
  assert.deepEqual(targets[1]!.turnChanges, { files: ["/w/a.txt"], insertions: 2, deletions: 1 });
  assert.deepEqual(targets[2]!.turnChanges, { files: [], insertions: 0, deletions: 0 });
  assert.deepEqual(targets[0]!.restore, { files: ["/w/a.txt"], insertions: 3, deletions: 1 });
});

test("a waiting marker ends the conversation at its kept line; an opener after its last line spends it", () => {
  const lines = conversation();
  const { t } = scan(lines);
  const marker: RewindMarker = { atUuid: U(5), keepUuid: U(4), lastUuid: U(12), createdAt: 1 };
  assert.equal(markerActive(t, marker), true);
  assert.equal(rewindLeaf(t, marker), U(4));
  assert.deepEqual(rewindTargets(t, marker).map((x) => x.uuid), [U(1)]);
  // Lines without an opener after the last line (an attachment) keep it waiting.
  const quiet = scan([...lines, { parentUuid: U(12), type: "attachment", attachment: { type: "hook_success" }, uuid: U(19) }]);
  assert.equal(markerActive(quiet.t, marker), true);
  // The next message, under the kept line.
  const more = scan([...lines, user(20, 4, "Edit a.txt differently"), assistant(21, 20)]);
  assert.equal(markerActive(more.t, marker), false);
  assert.deepEqual(rewindTargets(more.t, marker).map((x) => x.uuid), [U(1), U(20)]);
  // Edits on the line the rewind left still count for a code restore of an earlier message.
  assert.deepEqual(rewindTargets(more.t, marker)[0]!.restore, { files: ["/w/a.txt"], insertions: 3, deletions: 1 });
  // A transcript without the marker's last line (rewritten) spends it.
  assert.equal(markerActive(t, { ...marker, lastUuid: U(99) }), false);
});

test("the file readers: newest node and the marker read from the end", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewind-tail-"));
  const file = path.join(dir, "s.jsonl");
  const lines = [...conversation(), { type: "last-prompt", lastPrompt: "x" }];
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  try {
    assert.equal(await newestNodeUuid(file), U(12), "a line without a uuid is no node");
    const marker: RewindMarker = { atUuid: U(5), keepUuid: U(4), lastUuid: U(12), createdAt: 1 };
    assert.equal(await markerActiveIn(file, marker), true);
    fs.appendFileSync(file, `${JSON.stringify(user(20, 4, "again"))}\n`);
    assert.equal(await markerActiveIn(file, marker), false);
    assert.equal(await markerActiveIn(file, { ...marker, lastUuid: U(99) }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a compaction starts a new root: the messages before it are not targets", () => {
  const { t } = scan([
    user(1, null, "old"),
    assistant(2, 1),
    { parentUuid: null, logicalParentUuid: U(2), type: "system", subtype: "compact_boundary", uuid: U(3) },
    user(4, 3, "This session is being continued...", { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    user(5, 4, "after"),
    assistant(6, 5),
  ]);
  assert.deepEqual(chainTo(t, rewindLeaf(t, null)), [U(3), U(4), U(5), U(6)]);
  assert.deepEqual(rewindTargets(t, null).map((x) => [x.uuid, x.parentUuid]), [[U(5), U(4)]]);
});

test("the leaf is the newest line under the newest opener, not a later line of an older branch", () => {
  const { t } = scan([user(1, null, "a"), assistant(2, 1), user(3, 2, "b"), user(4, 2, "c"), assistant(5, 4), assistant(6, 3)]);
  assert.equal(rewindLeaf(t, null), U(5));
  assert.deepEqual(rewindTargets(t, null).map((x) => x.uuid), [U(1), U(4)]);
});

test("only the CLI's newest 100 checkpoints count", () => {
  const lines: unknown[] = [];
  let prev: number | null = null;
  for (let i = 1; i <= 101; i++) {
    lines.push(user(i * 2, prev, `m${i}`), snapshot(i * 2), assistant(i * 2 + 1, i * 2));
    prev = i * 2 + 1;
  }
  const { t } = scan(lines);
  const targets = rewindTargets(t, null);
  assert.equal(targets.length, 101);
  assert.equal(targets[0]!.checkpoint, false, "the oldest one is past the CLI's 100");
  assert.equal(targets[1]!.checkpoint, true);
  assert.equal(targets.at(-1)!.checkpoint, true);
});

test("prompt text and tracked edits as the CLI reads them", () => {
  assert.equal(promptText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(promptText("<bash-input>ls</bash-input>"), "!ls");
  assert.equal(promptText("<command-name>clear</command-name><command-args></command-args>"), "/clear");
  assert.equal(editOf({ filePath: "/f", structuredPatch: [], type: "update" }), null, "an update without hunks changed nothing");
  assert.equal(editOf({ filePath: "/f", structuredPatch: [{ lines: ["+a"] }], staged: true }), null);
  assert.deepEqual(editOf({ type: "create", filePath: "/f", content: "", structuredPatch: [] }), { file: "/f", insertions: 0, deletions: 0 });
  assert.equal(editOf({ stdout: "x" }), null);
});

test("readRewindTranscript reads a file in chunks with the offsets of its lines", async () => {
  const lines = conversation();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewind-scan-"));
  const file = path.join(dir, "s.jsonl");
  // A line longer than one read chunk, and a broken line at the end (a write in progress).
  const big = user(30, 12, "x".repeat(5 * 1024 * 1024));
  fs.writeFileSync(file, `${[...lines, big].map((l) => JSON.stringify(l)).join("\n")}\n{"type":"user","uui`);
  try {
    const read = await readRewindTranscript(file);
    const direct = scan([...lines, big]);
    assert.deepEqual(read.nodes, direct.t.nodes);
    assert.deepEqual([...read.snapshots], [...direct.t.snapshots]);
    assert.deepEqual(rewindTargets(read, null).map((x) => x.uuid), [U(1), U(5), U(11), U(30)]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("forkCut: a message's stretch ends at the line before the next message, the last one at the conversation's end", () => {
  const { t } = scan(conversation());
  // Message 1's stretch ends at line 4, the reply before message 5 (the tool result 3 is a user line, not a message).
  assert.deepEqual(forkCut(t, null, U(1)), { cut: U(4), last: false });
  assert.deepEqual(forkCut(t, null, U(5)), { cut: U(10), last: false });
  assert.deepEqual(forkCut(t, null, U(11)), { cut: U(12), last: true });
  assert.equal(forkCut(t, null, U(2)), null, "an assistant line is no message");
  assert.equal(forkCut(t, null, U(99)), null);
});

test("forkCut: a waiting rewind ends the conversation at its kept line, and a system line is no cut", () => {
  const lines = conversation();
  const { t } = scan(lines);
  const marker: RewindMarker = { atUuid: U(11), keepUuid: U(10), lastUuid: U(12), createdAt: 1 };
  assert.deepEqual(forkCut(t, marker, U(5)), { cut: U(10), last: true });
  assert.equal(forkCut(t, marker, U(11)), null, "the rewound message is not on the conversation");
  // A trailing system line (turn duration) is skipped for the line before it.
  const withSystem = [...lines, { parentUuid: U(12), type: "system", subtype: "turn_duration", uuid: U(13) }];
  assert.deepEqual(forkCut(scan(withSystem).t, null, U(11)), { cut: U(12), last: true });
});
