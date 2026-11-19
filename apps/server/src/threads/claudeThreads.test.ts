import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionSummary, ThreadLiveEvent, ThreadOlder, ThreadResumed, ThreadSnapshot } from "@maru/shared";
import { applyResumed, fieldDigests, prependOlder, threadHave } from "@maru/shared";
import { SessionIndex } from "../index/store.ts";
import { createTranscriptHub } from "../transcript/transcriptHub.ts";
import type { ClaudeTurnInfo } from "../claude/projection/projector.ts";
import { ClaudeThreads, liveStatusOf, type ClaudeTurnSource } from "./claudeThreads.ts";
import { PendingSends, settleDelivered, settleFromTranscript } from "../drive/pendingSends.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const ENC = "-Users-test-proj";
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let clock = 0;
const ts = () => new Date(Date.UTC(2026, 10, 15, 0, 0, clock++)).toISOString();

function prompt(n: number, parent: number | null, text: string) {
  return { parentUuid: parent === null ? null : U(parent), type: "user", message: { role: "user", content: text }, uuid: U(n), timestamp: ts(), promptId: `p${n}`, sessionId: SID, cwd: "/w" };
}
function answer(n: number, parent: number, text: string) {
  return {
    parentUuid: U(parent), type: "assistant", uuid: U(n), timestamp: ts(), sessionId: SID,
    message: { model: "claude-opus-5-5", id: `msg${n}`, type: "message", role: "assistant", content: [{ type: "text", text }] },
  };
}
const lines = (rows: unknown[]) => rows.map((r) => JSON.stringify(r) + "\n").join("");

function setup(turns?: ClaudeTurnSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maru-threads-"));
  const a = path.join(root, ".claude");
  const b = path.join(root, ".claude-other");
  fs.mkdirSync(path.join(a, "projects", ENC), { recursive: true });
  fs.mkdirSync(path.join(b, "projects", ENC, SID, "subagents"), { recursive: true });
  const file = path.join(a, "projects", ENC, `${SID}.jsonl`);
  const rows: unknown[] = [];
  for (let i = 0; i < 10; i++) rows.push(prompt(i * 2 + 1, i === 0 ? null : i * 2, `q${i}`), answer(i * 2 + 2, i * 2 + 1, `a${i}`));
  fs.writeFileSync(file, lines(rows));
  // A subagent transcript that lives under the other account (the session was resumed there).
  fs.writeFileSync(path.join(b, "projects", ENC, SID, "subagents", "agent-abc123.jsonl"), lines([prompt(900, null, "child task")]));
  const index = new SessionIndex();
  const hub = createTranscriptHub({ debounceMs: 10, pollMs: 50 });
  const threads = new ClaudeThreads({
    accounts: [{ id: "acct-a", dir: a }, { id: "acct-b", dir: b }],
    index, hub, transcriptWaitMs: 0, ...(turns ? { turns } : {}),
  });
  return { root, file, index, hub, threads };
}

async function until(pred: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function userTexts(s: ThreadSnapshot): string[] {
  return s.visibleTurnItems.flatMap((r) => (r.item.type === "user_message" ? [r.item.text] : []));
}

test("snapshot of the tail page, live appends, older pages, and a shared projector", async () => {
  const { root, file, index, hub, threads } = setup();
  try {
    const snaps: ThreadSnapshot[] = [];
    const events: ThreadLiveEvent[] = [];
    const threadId = `claude:acct-a:${SID}`;
    const off = await threads.subscribe(threadId, (m) => {
      if (m.snapshot) snaps.push(m.snapshot);
      if (m.events) events.push(...m.events);
    }, { pageSize: 6 });
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0]!.hasMoreBefore, true);
    assert.deepEqual(userTexts(snaps[0]!), ["q7", "q8", "q9"]);

    fs.appendFileSync(file, lines([prompt(21, 20, "q10"), answer(22, 21, "a10")]));
    await until(() => events.some((e) => e.t === "turnItem.upserted" && e.row.item.type === "user_message" && e.row.item.text === "q10"), "live append");

    await threads.loadOlder(threadId);
    assert.equal(snaps.length, 2);
    assert.deepEqual(userTexts(snaps[1]!), ["q4", "q5", "q6", "q7", "q8", "q9", "q10"]);
    while (snaps.at(-1)!.hasMoreBefore) await threads.loadOlder(threadId);
    assert.equal(userTexts(snaps.at(-1)!).length, 11);

    // A second subscriber shares the open thread and gets its current state at once.
    const second: ThreadSnapshot[] = [];
    const off2 = await threads.subscribe(threadId, (m) => m.snapshot && second.push(m.snapshot));
    assert.equal(userTexts(second[0]!).length, 11);
    off2();
    off();
    assert.equal(hub.subscriberCount(file), 0, "the last unsubscribe stops following");
  } finally {
    threads.closeAll();
    hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a windowed subscriber: the newest rows, live appends, older rows to the start, beside a plain subscriber", async () => {
  const { root, file, hub, threads } = setup();
  try {
    const threadId = `claude:acct-a:${SID}`;
    // A plain subscriber reads pages of 4 lines; its last snapshot is the whole thread.
    const plain: ThreadSnapshot[] = [];
    const offPlain = await threads.subscribe(threadId, (m) => m.snapshot && plain.push(m.snapshot), { pageSize: 4 });
    let held: ThreadSnapshot | null = null;
    const kinds: string[] = [];
    const listener = (m: { snapshot?: ThreadSnapshot; older?: ThreadOlder; events?: ThreadLiveEvent[] }) => {
      if (m.snapshot) {
        held = m.snapshot;
        kinds.push("snapshot");
      }
      if (m.older && held) {
        held = prependOlder(held, m.older);
        kinds.push(m.older.requested ? "older" : "moved");
      }
      if (m.events && held) {
        // The web reducer's row rules (threadState.ts applyThreadEvents) for the events a window gets.
        const h: ThreadSnapshot = held;
        let items = [...h.visibleTurnItems];
        for (const e of m.events) {
          if (e.t === "turnItem.upserted") {
            const i = items.findIndex((x) => x.item.id === e.row.item.id);
            if (i >= 0) items[i] = e.row;
            else items.push(e.row);
          } else if (e.t === "turnItems.replaced") {
            items = [...e.visibleTurnItems];
          }
        }
        held = { ...h, visibleTurnItems: items };
        kinds.push("events");
      }
    };
    const current = (): ThreadSnapshot => held as unknown as ThreadSnapshot;
    const off = await threads.subscribe(threadId, listener, { rows: 3 });
    // The newest 3 rows: a8, q9, a9.
    assert.deepEqual(userTexts(current()), ["q9"]);
    assert.equal(current().visibleTurnItems.length, 3);
    assert.equal(current().hasMoreBefore, true);

    fs.appendFileSync(file, lines([prompt(21, 20, "q10"), answer(22, 21, "a10")]));
    await until(() => userTexts(current()).includes("q10"), "live append joins the window");
    // The plain subscriber's own older page moves the windowed one's positions without rows.
    await threads.loadOlder(threadId);
    assert.equal(kinds.at(-1), "moved");
    while (current().hasMoreBefore) await threads.loadOlder(threadId, listener, 4);
    while (plain.at(-1)!.hasMoreBefore) await threads.loadOlder(threadId);
    const whole = plain.at(-1)!;
    assert.deepEqual(userTexts(current()), userTexts(whole));
    assert.equal(userTexts(current()).length, 11);
    assert.deepEqual(current().visibleTurnItems, whole.visibleTurnItems, "the same rows, positions and content");
    assert.ok(kinds.filter((k) => k === "snapshot").length === 1, `one snapshot, then changes: ${kinds.join(" ")}`);
    off();
    offPlain();
    assert.equal(hub.subscriberCount(file), 0);
  } finally {
    threads.closeAll();
    hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a subagent transcript is found under another account, and unknown ids fail", async () => {
  const { root, hub, threads } = setup();
  try {
    const snaps: ThreadSnapshot[] = [];
    const off = await threads.subscribe(`claude:acct-a:${SID}:agent-abc123`, (m) => m.snapshot && snaps.push(m.snapshot));
    assert.deepEqual(userTexts(snaps[0]!), ["child task"]);
    off();
    await assert.rejects(threads.subscribe(`claude:acct-a:${SID}:agent-missing`, () => {}), /not found/);
    await assert.rejects(threads.subscribe(`claude:nope:${SID}`, () => {}), /unknown account/);
    assert.equal(threads.handles("codex:acct:01a1"), false);
  } finally {
    threads.closeAll();
    hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a transcript moved to another project folder (a rehome) is followed there", async () => {
  const { root, file, hub, threads } = setup();
  try {
    const snaps: ThreadSnapshot[] = [];
    const events: ThreadLiveEvent[] = [];
    const errors: string[] = [];
    const off = await threads.subscribe(`claude:acct-a:${SID}`, (m) => {
      if (m.snapshot) snaps.push(m.snapshot);
      if (m.events) events.push(...m.events);
      if (m.error) errors.push(m.error);
    });
    const moved = path.join(path.dirname(path.dirname(file)), "-Users-test-other", `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(file, moved);
    await until(() => snaps.length >= 2, "snapshot from the new place");
    assert.deepEqual(errors, []);
    assert.deepEqual(userTexts(snaps.at(-1)!).slice(-1), ["q9"]);
    fs.appendFileSync(moved, lines([prompt(21, 20, "q10"), answer(22, 21, "a10")]));
    await until(() => events.some((e) => e.t === "turnItem.upserted" && e.row.item.type === "user_message" && e.row.item.text === "q10"), "live append in the new place");
    off();
  } finally {
    threads.closeAll();
    hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a goal set far above the first page is found by the scan, and goal lines that come live move state.goal", async () => {
  const { root, file, hub, threads } = setup();
  try {
    const goalLine = (n: number, parent: number, attachment: Record<string, unknown>) =>
      ({ parentUuid: U(parent), type: "attachment", attachment: { type: "goal_status", ...attachment }, uuid: U(n), timestamp: ts(), sessionId: SID });
    // 20 lines (10 turns) are in the file; the goal is set before them and checked once after the 10th turn.
    const old = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, lines([goalLine(901, 1, { met: false, sentinel: true, condition: "ship it" })]) + old + lines([goalLine(902, 20, { met: false, condition: "ship it", reason: "Not yet." })]));
    const threadId = `claude:acct-a:${SID}`;
    const goals: unknown[] = [];
    const off = await threads.subscribe(threadId, (m) => {
      if (m.snapshot) goals.push(m.snapshot.state.goal);
      for (const e of m.events ?? []) if (e.t === "thread.patched" && e.state && "goal" in e.state) goals.push(e.state.goal);
    }, { pageSize: 4 });
    // The page of 4 lines holds only the last turn: the check, but not the set.
    const claude = (g: unknown) => (g as { claude?: unknown } | null | undefined)?.claude;
    await until(() => JSON.stringify(claude(goals.at(-1))) === JSON.stringify({ checks: 1, setAt: Date.parse(goalSetAt(file)), lastReason: "Not yet." }), "the scan completes the goal");
    assert.equal((goals.at(-1) as { objective: string }).objective, "ship it");

    fs.appendFileSync(file, lines([goalLine(903, 902, { met: true, condition: "ship it", reason: "done", iterations: 2 })]));
    await until(() => goals.at(-1) === null, "a met line clears it");
    off();
  } finally {
    threads.closeAll();
    hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** The timestamp of the first goal_status line of a transcript. */
function goalSetAt(file: string): string {
  for (const l of fs.readFileSync(file, "utf8").split("\n")) if (l.includes("goal_status")) return (JSON.parse(l) as { timestamp: string }).timestamp;
  throw new Error("no goal line");
}

test("registry status maps to the projector's live status", () => {
  const s = (status: SessionSummary["status"]) => ({ status }) as SessionSummary;
  assert.deepEqual(
    [liveStatusOf(s("running")), liveStatusOf(s("waiting-input")), liveStatusOf(s("open-idle")), liveStatusOf(s("closed")), liveStatusOf(undefined)],
    ["busy", "waiting", "idle", null, null],
  );
});

test("the turns of a process this server runs reach the thread: a result ends its latest run", async () => {
  let info: ClaudeTurnInfo = { run: { busy: true, waiting: false, busySince: null, permissionMode: "bypassPermissions" }, ends: [] };
  const listeners = new Set<(key: string) => void>();
  const turns: ClaudeTurnSource = {
    turnInfo: () => info,
    onTurns: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const { root, hub, threads } = setup(turns);
  try {
    const threadId = `claude:acct-a:${SID}`;
    const snaps: ThreadSnapshot[] = [];
    const events: ThreadLiveEvent[] = [];
    const off = await threads.subscribe(threadId, (m) => {
      if (m.snapshot) snaps.push(m.snapshot);
      if (m.events) events.push(...m.events);
    });
    const last = snaps[0]!.runs.at(-1)!;
    assert.deepEqual([last.status, last.completedAt], ["running", null]);
    assert.equal(snaps[0]!.state.permissionMode, "bypassPermissions");

    info = { run: { busy: false, waiting: false, busySince: null, permissionMode: "plan" }, ends: [{ at: "2026-11-16T00:00:00.000Z", userMessageUuids: [U(19)] }] };
    for (const l of [...listeners]) l(`claude:acct-b:${SID}`);
    assert.equal(events.length, 0, "another session's turns are not this thread's");
    for (const l of [...listeners]) l(threadId);
    const up = events.find((e) => e.t === "run.upserted");
    assert.ok(up !== undefined && up.t === "run.upserted");
    assert.deepEqual([up.run.runId, up.run.status, up.run.completedAt], [last.runId, "completed", "2026-11-16T00:00:00.000Z"]);
    assert.ok(events.some((e) => e.t === "thread.patched" && e.state?.permissionMode === "plan"));
    off();
    assert.equal(listeners.size, 0, "closing the thread stops listening");
  } finally {
    threads.closeAll();
    hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A windowed client's view of the messages it gets (the web reducer's merge, with `thread.resumed`). */
function windowedClient() {
  let held: ThreadSnapshot | null = null;
  const kinds: string[] = [];
  const resumedRows: number[] = [];
  const listener = (m: { snapshot?: ThreadSnapshot; older?: ThreadOlder; resumed?: ThreadResumed; events?: ThreadLiveEvent[] }) => {
    if (m.snapshot) {
      held = m.snapshot;
      kinds.push("snapshot");
    }
    if (m.resumed) {
      held = applyResumed(held, m.resumed);
      kinds.push("resumed");
      resumedRows.push(m.resumed.rows.length);
    }
    if (m.older && held) {
      held = prependOlder(held, m.older);
      kinds.push("older");
    }
    if (m.events && held) {
      const h: ThreadSnapshot = held;
      const items = [...h.visibleTurnItems];
      for (const e of m.events) {
        if (e.t === "turnItem.upserted") {
          const i = items.findIndex((x) => x.item.id === e.row.item.id);
          if (i >= 0) items[i] = e.row;
          else items.push(e.row);
        }
      }
      held = { ...h, visibleTurnItems: items };
      kinds.push("events");
    }
  };
  return { listener, kinds, resumedRows, get snapshot(): ThreadSnapshot { return held as unknown as ThreadSnapshot; }, set snapshot(s: ThreadSnapshot) { held = s; } };
}

test("a client that left and comes back with its rows gets the window from its first row minus the rows it holds", async () => {
  const { root, file, hub, threads } = setup();
  try {
    const threadId = `claude:acct-a:${SID}`;
    // First visit: the newest rows, then older ones twice, then the client leaves (the thread closes).
    const first = windowedClient();
    const off = await threads.subscribe(threadId, first.listener, { rows: 4, pageSize: 4 });
    await threads.loadOlder(threadId, first.listener, 4);
    await threads.loadOlder(threadId, first.listener, 4);
    const left = first.snapshot;
    assert.ok(left.hasMoreBefore && left.visibleTurnItems.length > 4);
    off();
    assert.equal(hub.subscriberCount(file), 0);

    // Back with nothing changed: every row is held, the answer is only ids and positions.
    const second = windowedClient();
    second.snapshot = left;
    const secondFields: string[][] = [];
    const off2 = await threads.subscribe(threadId, (m) => {
      if (m.resumed) secondFields.push(Object.keys(m.resumed.snapshot));
      second.listener(m);
    }, { rows: 4, pageSize: 4, have: threadHave(left.visibleTurnItems, fieldDigests(left)) });
    assert.deepEqual(second.kinds, ["resumed"]);
    assert.deepEqual(second.resumedRows, [0]);
    assert.deepEqual(secondFields, [["hasMoreBefore"]], "the other fields are as the client holds them");
    assert.deepEqual(second.snapshot.visibleTurnItems.map((r) => r.item.id), left.visibleTurnItems.map((r) => r.item.id));
    assert.equal(second.snapshot.hasMoreBefore, true);
    off2();

    // Lines came while away: the new rows are sent, the held ones are not.
    fs.appendFileSync(file, lines([prompt(21, 20, "q10"), answer(22, 21, "a10")]));
    const third = windowedClient();
    third.snapshot = left;
    const off3 = await threads.subscribe(threadId, third.listener, { rows: 4, pageSize: 4, have: threadHave(left.visibleTurnItems) });
    assert.deepEqual(third.kinds, ["resumed"]);
    assert.ok(third.resumedRows[0]! >= 2 && third.resumedRows[0]! < left.visibleTurnItems.length, `rows sent: ${third.resumedRows[0]}`);
    assert.deepEqual(userTexts(third.snapshot).slice(-2), ["q9", "q10"]);
    // The subscription goes on as a window: live lines and older rows follow it, and it ends up equal to a plain read.
    fs.appendFileSync(file, lines([prompt(23, 22, "q11"), answer(24, 23, "a11")]));
    await until(() => userTexts(third.snapshot).includes("q11"), "live append after a resume");
    while (third.snapshot.hasMoreBefore) await threads.loadOlder(threadId, third.listener, 4);
    const plain: ThreadSnapshot[] = [];
    const offPlain = await threads.subscribe(threadId, (m) => m.snapshot && plain.push(m.snapshot), { pageSize: 4 });
    while (plain.at(-1)!.hasMoreBefore) await threads.loadOlder(threadId);
    assert.deepEqual(third.snapshot.visibleTurnItems, plain.at(-1)!.visibleTurnItems, "the same rows, positions and content");
    offPlain();
    off3();

    // The transcript was rewritten while away and the client's first row is gone: the usual window.
    const rewritten: unknown[] = [];
    for (let i = 8; i < 12; i++) rewritten.push(prompt(i * 2 + 1, i === 8 ? null : i * 2, `r${i}`), answer(i * 2 + 2, i * 2 + 1, `b${i}`));
    fs.writeFileSync(file, lines(rewritten));
    const fourth = windowedClient();
    fourth.snapshot = left;
    const off4 = await threads.subscribe(threadId, fourth.listener, { rows: 3, pageSize: 4, have: threadHave(left.visibleTurnItems) });
    assert.deepEqual(fourth.kinds, ["snapshot"]);
    assert.equal(fourth.snapshot.visibleTurnItems.length, 3);
    assert.deepEqual(userTexts(fourth.snapshot), ["r11"]);
    off4();
  } finally {
    threads.closeAll();
    hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("find: every matching item of the whole transcript, live lines, and a step to an item the window lacks", async () => {
  const { root, file, hub, threads } = setup();
  try {
    const threadId = `claude:acct-a:${SID}`;
    // The whole transcript read at once, to compare ids and order with.
    const full: ThreadSnapshot[] = [];
    const reader = new ClaudeThreads({ accounts: [{ id: "acct-a", dir: path.dirname(path.dirname(path.dirname(file))) }], index: new SessionIndex(), hub, transcriptWaitMs: 0 });
    const offFull = await reader.subscribe(threadId, (m) => m.snapshot && full.push(m.snapshot), { pageSize: 10_000 });
    const idOfText = new Map(full[0]!.visibleTurnItems.flatMap((r) => (r.item.type === "user_message" || r.item.type === "assistant_message" ? [[r.item.text, r.item.id] as const] : [])));
    offFull();
    reader.closeAll();

    let held: ThreadSnapshot | null = null;
    const answers: ThreadOlder[] = [];
    const listener = (m: { snapshot?: ThreadSnapshot; older?: ThreadOlder; events?: ThreadLiveEvent[] }) => {
      if (m.snapshot) held = m.snapshot;
      if (m.older && held) {
        held = prependOlder(held, m.older);
        if (m.older.requested) answers.push(m.older);
      }
      if (m.events && held) {
        for (const e of m.events) {
          if (e.t === "turnItem.upserted") {
            const h: ThreadSnapshot = held;
            const i = h.visibleTurnItems.findIndex((r) => r.item.id === e.row.item.id);
            held = { ...h, visibleTurnItems: i < 0 ? [...h.visibleTurnItems, e.row] : h.visibleTurnItems.map((r, k) => (k === i ? e.row : r)) };
          }
        }
      }
    };
    const off = await threads.subscribe(threadId, listener, { rows: 2, pageSize: 4 });
    const heldIds = () => new Set(held!.visibleTurnItems.map((r) => r.item.id));
    assert.ok(!heldIds().has(idOfText.get("q0")!), "the window starts without the first prompt");

    const first = await threads.search(threadId, "Q", "r1");
    assert.equal(first.reqId, "r1");
    assert.equal(first.total, 10);
    assert.equal(first.searched, 20, "every user and assistant text was looked into");
    assert.deepEqual(first.matches.map((m) => first.idPrefix + m.id), Array.from({ length: 10 }, (_, i) => idOfText.get(`q${i}`)));
    assert.ok(first.matches.every((m) => m.role === "user" && m.count === 1));
    assert.ok(!heldIds().has(idOfText.get("q0")!), "a find leaves the window as it is");

    // A live line is found from the thread's own rows.
    fs.appendFileSync(file, lines([prompt(21, 20, "q10 and Q again"), answer(22, 21, "a10")]));
    await until(() => held!.visibleTurnItems.some((r) => r.item.type === "user_message" && r.item.text.startsWith("q10")), "live append");
    const second = await threads.search(threadId, "q", "r2");
    assert.equal(second.total, 12);
    assert.equal(second.matches.at(-1)!.count, 2);
    const korean = await threads.search(threadId, "없는 말", "r3");
    assert.deepEqual([korean.total, korean.matches.length], [0, 0]);

    // A step to the first prompt: the window grows to its row, and only the asker gets the rows.
    await threads.loadOlder(threadId, listener, 2, idOfText.get("q0")!);
    assert.equal(answers.length, 1);
    assert.ok(heldIds().has(idOfText.get("q0")!), "the window reaches the item");
    assert.equal(held!.visibleTurnItems[0]!.item.id, idOfText.get("q0"));
    assert.equal(held!.hasMoreBefore, false);
    // An item the thread does not have: an answer, and the window as it was.
    const before = held!.visibleTurnItems.length;
    await threads.loadOlder(threadId, listener, 2, `${threadId}:uuid:nope`);
    assert.equal(answers.length, 2);
    assert.equal(answers[1]!.visibleTurnItems.length, 0);
    assert.equal(held!.visibleTurnItems.length, before);
    off();
  } finally {
    threads.closeAll();
    hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// DESIGN.md 4.4: a waiting message settles by the id of the row the thread shows, in the order the
// subscriber's socket sees (row first, list change after).
function queuedCommand(n: number, parent: number, text: string, sourceUuid: string) {
  return {
    parentUuid: U(parent), isSidechain: false, type: "attachment", uuid: U(n), timestamp: ts(), sessionId: SID,
    attachment: { type: "queued_command", prompt: text, source_uuid: sourceUuid, commandMode: "prompt", origin: { kind: "human" } },
  };
}

test("pending sends settle from live rows after the rows went out, also rows far above a client's window", async () => {
  const { root, file, hub, threads: unused } = setup();
  unused.closeAll();
  const log: string[] = [];
  const store = new PendingSends({ file: ":memory:", publish: () => {} });
  const key = `claude:acct-a:${SID}`;
  const ID_USER = "aaaaaaaa-0000-4000-8000-000000000001";
  const ID_STEER = "aaaaaaaa-0000-4000-8000-000000000002";
  const ID_WAIT = "aaaaaaaa-0000-4000-8000-000000000003";
  for (const id of [ID_USER, ID_STEER, ID_WAIT]) {
    store.sent(key, id, `text ${id}`);
    store.apply(key, { kind: "taken", id });
  }
  const threads = new ClaudeThreads({
    accounts: [{ id: "acct-a", dir: path.dirname(path.dirname(path.dirname(file))) }],
    index: new SessionIndex(), hub, transcriptWaitMs: 0,
    delivery: {
      delivered: (k, ids) => {
        log.push(`delivered:${[...ids].sort().join(",")}`);
        settleDelivered(store, k, ids);
      },
    },
  });
  try {
    // A windowed client of 3 rows.
    const off = await threads.subscribe(key, (m) => {
      if (m.snapshot) log.push("snapshot");
      for (const ev of m.events ?? []) if (ev.t === "turnItem.upserted" && ev.row.item.type === "user_message") log.push(`row:${ev.row.item.text}`);
    }, { rows: 3 });
    assert.deepEqual(store.stored(key).map((s) => s.state), ["taken", "taken", "taken"]);
    log.length = 0;

    // A prompt line written with the id it was sent with.
    fs.appendFileSync(file, lines([{ ...prompt(30, 20, "sent while idle"), uuid: ID_USER }]));
    await until(() => !store.stored(key).some((s) => s.id === ID_USER), "user line settles");
    assert.deepEqual(log, ["row:sent while idle", `delivered:${ID_USER}`], "the row goes out before the list changes");

    // A message folded in between tool rounds (queued_command source_uuid), then many rows after it
    // push it far above a window of 3 rows: the server has settled it by then.
    log.length = 0;
    fs.appendFileSync(file, lines([queuedCommand(40, 30, "steer text", ID_STEER)]));
    await until(() => !store.stored(key).some((s) => s.id === ID_STEER), "queued_command settles");
    assert.deepEqual(log, ["row:steer text", `delivered:${ID_STEER}`]);
    const burst: unknown[] = [];
    for (let i = 0; i < 40; i++) burst.push(answer(100 + i, 40, `tail ${i}`));
    fs.appendFileSync(file, lines(burst));
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(store.stored(key).map((s) => s.id), [ID_WAIT], "an unrelated waiting message stays");

    fs.appendFileSync(file, lines([{ ...prompt(500, 139, "late"), uuid: ID_WAIT }]));
    await until(() => store.stored(key).length === 0, "late row settles");
    off();
  } finally {
    threads.closeAll();
    hub.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a subscribe reports the ids of the rows it holds and tells the server a subscriber joined", async () => {
  const { root, file, hub, threads: unused } = setup();
  unused.closeAll();
  const ID = "bbbbbbbb-0000-4000-8000-000000000001";
  fs.appendFileSync(file, lines([{ ...prompt(50, 20, "already there"), uuid: ID }]));
  const calls: string[] = [];
  const threads = new ClaudeThreads({
    accounts: [{ id: "acct-a", dir: path.dirname(path.dirname(path.dirname(file))) }],
    index: new SessionIndex(), hub, transcriptWaitMs: 0,
    delivery: {
      delivered: (k, ids) => calls.push(`delivered:${k}:${[...ids].join(",")}`),
      subscribed: (k) => calls.push(`subscribed:${k}`),
    },
  });
  try {
    const off = await threads.subscribe(`claude:acct-a:${SID}`, () => {}, { rows: 5 });
    assert.equal(calls.length, 2);
    assert.ok(calls[0]!.startsWith(`delivered:claude:acct-a:${SID}:`) && calls[0]!.split(":").at(-1)!.split(",").includes(ID), "the held rows' ids, the new one among them");
    assert.equal(calls[1], `subscribed:claude:acct-a:${SID}`, "the transcript scan is asked for after the held rows");
    off();
  } finally {
    threads.closeAll();
    hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a transcript scan does not settle a line the thread has not sent as a row yet; the delivery hook does, after the row", async () => {
  const { root, file, hub, threads: unused } = setup();
  unused.closeAll();
  const key = `claude:acct-a:${SID}`;
  const ID = "cccccccc-0000-4000-8000-000000000001";
  const log: string[] = [];
  const store = new PendingSends({ file: ":memory:", publish: () => log.push(`list:${store.stored(key).length}`) });
  store.sent(key, ID, "text");
  store.apply(key, { kind: "taken", id: ID });
  log.length = 0;
  const threads = new ClaudeThreads({
    accounts: [{ id: "acct-a", dir: path.dirname(path.dirname(path.dirname(file))) }],
    index: new SessionIndex(), hub, transcriptWaitMs: 0,
    delivery: { delivered: (k, ids) => { log.push("hook"); settleDelivered(store, k, ids); } },
  });
  // The limit as it stood the moment the line was written (the follower may hand it over while the scan reads).
  const scan = (limit: number) => settleFromTranscript(store, key, file, { limit: () => limit });
  try {
    assert.equal(threads.sentEnd(key), Infinity, "no thread holds the session: nobody shows its rows");
    const opening = threads.subscribe(key, (m) => {
      for (const ev of m.events ?? []) if (ev.t === "turnItem.upserted" && ev.row.item.type === "user_message") log.push(`row:${ev.row.item.text}`);
    }, { rows: 3 });
    assert.equal(threads.sentEnd(key), 0, "while the thread opens nothing counts as sent");
    const off = await opening;
    log.length = 0;
    assert.equal(threads.sentEnd(key), fs.statSync(file).size, "the snapshot covers the file as read");

    // The line is written and a scan runs before the follower hands it to the projector.
    fs.appendFileSync(file, lines([{ ...prompt(60, 20, "just written"), uuid: ID }]));
    const at = threads.sentEnd(key);
    assert.ok(at < fs.statSync(file).size);
    await scan(at);
    await until(() => store.stored(key).length === 0, "the hook settles it");
    // A scan that settled it would have put "list:0" first, without the hook.
    assert.deepEqual(log, ["row:just written", "hook", "list:0"], "the row goes out, then the hook settles, then the list changes");
    assert.equal(threads.sentEnd(key), fs.statSync(file).size);

    off();
    assert.equal(threads.sentEnd(key), Infinity, "closed again");
  } finally {
    threads.closeAll();
    hub.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
