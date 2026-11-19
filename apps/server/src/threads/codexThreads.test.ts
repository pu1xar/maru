import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionChosen, ThreadLiveEvent, ThreadOlder, ThreadResumed, ThreadSnapshot } from "@maru/shared";
import { applyResumed, prependOlder, threadHave } from "@maru/shared";
import { SessionIndex } from "../index/store.ts";
import { FakeDaemon, makeThread, waitFor } from "../codex/fake-daemon.ts";
import { codexItemRowId } from "../codex/projection/mapItems.ts";
import { CodexThreads } from "./codexThreads.ts";

const TID = "th1";
const KEY = `codex:cx:${TID}`;

test("a Codex thread's snapshot carries this server's state.chosen, and a change reaches its subscribers as a patch", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  d.threads.set(TID, makeThread(TID, { status: { type: "idle" } }));
  d.handlers.set("thread/turns/list", () => ({ data: [], nextCursor: null, backwardsCursor: null }));
  d.handlers.set("thread/resume", (p) => {
    const th = d.threads.get(String(p.threadId))!;
    return { thread: th, model: "m", modelProvider: "openai", cwd: th.cwd, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
  });
  d.handlers.set("thread/unsubscribe", () => ({ status: "unsubscribed" }));
  await d.listen();

  let value: SessionChosen | null = { model: "gpt-small", effort: "low", pending: true };
  const listeners = new Set<(key: string) => void>();
  const threads = new CodexThreads({
    accounts: [{ id: "cx", home: d.home }],
    index: new SessionIndex(),
    chosen: { chosenOf: () => value, onChosen: (l) => (listeners.add(l), () => listeners.delete(l)) },
  });
  t.after(() => threads.closeAll());
  const got: Array<{ snapshot?: ThreadSnapshot; events?: ThreadLiveEvent[] }> = [];
  const off = await threads.subscribe(KEY, (m) => got.push(m));
  assert.deepEqual(got[0]?.snapshot?.state.chosen, { model: "gpt-small", effort: "low", pending: true });

  value = null;
  for (const l of listeners) l(KEY);
  await waitFor(() => got.some((m) => m.events?.some((e) => e.t === "thread.patched")), "patched");
  assert.deepEqual(got.at(-1)?.events, [{ t: "thread.patched", threadId: KEY, state: { chosen: null } }], "null clears it");
  const count = got.length;
  for (const l of listeners) l("codex:cx:other");
  assert.equal(got.length, count, "a thread nobody here watches gets nothing");
  off();
});

test("a windowed subscriber of a Codex thread gets the newest rows, then older rows in pages until the start, as a plain read holds them", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  const W = "th2";
  const KEY2 = `codex:cx:${W}`;
  d.threads.set(W, makeThread(W, { status: { type: "notLoaded" } }));
  // 9 turns of a user message, a commentary, a command and an answer: 4 conversation rows each.
  const turns = Array.from({ length: 9 }, (_, n) => ({
    id: `t${n}`, rootTurnId: `t${n}`, itemsView: "full", status: "completed", error: null,
    startedAt: 1_794_000_000 + n * 10, completedAt: 1_794_000_005 + n * 10, durationMs: 5000,
    items: [
      { type: "userMessage", id: `u${n}`, clientId: null, content: [{ type: "text", text: `q${n}`, text_elements: [] }] },
      { type: "agentMessage", id: `c${n}`, text: `looking ${n}`, phase: "commentary", moderation: null, memoryCitation: null, delivery: null, questions: null },
      { type: "commandExecution", id: `x${n}`, command: `echo ${n}`, cwd: "/w", processId: null, status: "completed", commandActions: [], aggregatedOutput: `${n}\n`, exitCode: 0, durationMs: 3 },
      { type: "agentMessage", id: `a${n}`, text: `r${n}`, phase: "final_answer", moderation: null, memoryCitation: null, delivery: null, questions: null },
    ],
  }));
  d.handlers.set("thread/turns/list", (p) => {
    const desc = [...turns].reverse();
    const start = typeof p.cursor === "string" ? Number(p.cursor) : 0;
    const size = typeof p.limit === "number" ? p.limit : 25;
    const data = desc.slice(start, start + size);
    const end = start + data.length;
    return { data, nextCursor: end < desc.length ? String(end) : null, backwardsCursor: null };
  });
  d.handlers.set("thread/unsubscribe", () => ({ status: "unsubscribed" }));
  await d.listen();

  // The whole thread as a plain subscriber gets it: every page, each answered with a full snapshot.
  // A view of its own, reading the same pages (x.raw seq counts in reading order).
  const plainThreads = new CodexThreads({ accounts: [{ id: "cx", home: d.home }], index: new SessionIndex() });
  t.after(() => plainThreads.closeAll());
  const plain: ThreadSnapshot[] = [];
  const offPlain = await plainThreads.subscribe(KEY2, (m) => m.snapshot && plain.push(m.snapshot), { pageSize: 2 });
  while (plain.at(-1)!.hasMoreBefore) await plainThreads.loadOlder(KEY2);
  const whole = plain.at(-1)!;
  offPlain();
  assert.equal(whole.visibleTurnItems.length, 36);

  const threads = new CodexThreads({ accounts: [{ id: "cx", home: d.home }], index: new SessionIndex() });
  t.after(() => threads.closeAll());

  let held: ThreadSnapshot | null = null;
  const got: string[] = [];
  const listener = (m: { snapshot?: ThreadSnapshot; older?: ThreadOlder; events?: ThreadLiveEvent[] }) => {
    if (m.snapshot) {
      held = m.snapshot;
      got.push(`snapshot:${m.snapshot.visibleTurnItems.length}`);
    }
    if (m.older && held) {
      held = prependOlder(held, m.older);
      got.push(`older:${m.older.visibleTurnItems.length}`);
    }
  };
  const current = (): ThreadSnapshot => held as unknown as ThreadSnapshot;
  const off = await threads.subscribe(KEY2, listener, { pageSize: 2, rows: 5 });
  // 5 rows: the newest turn's 4 and the answer before it.
  assert.deepEqual(current().visibleTurnItems.map((r) => r.item.id.split(":").at(-1)), ["a7", "u8", "c8", "x8", "a8"]);
  assert.equal(current().hasMoreBefore, true);
  for (let guard = 0; current().hasMoreBefore; guard++) {
    assert.ok(guard < 50, "reaches the start");
    await threads.loadOlder(KEY2, listener, 6);
  }
  assert.deepEqual(current().visibleTurnItems.map((r) => r.item.id), whole.visibleTurnItems.map((r) => r.item.id));
  assert.deepEqual(current().visibleTurnItems, whole.visibleTurnItems, "positions and ordinals too");
  assert.deepEqual(current().runs.map((r) => r.runId), whole.runs.map((r) => r.runId));
  assert.ok(got.slice(1).every((g) => g.startsWith("older:")), `older pages, no full snapshots: ${got.join(" ")}`);
  off();

  // A client that left with some older rows comes back with them (DESIGN.md 6r): the thread closed
  // and opens again, reads pages until the client's first row is whole, and answers with ids and
  // positions only. Following the thread on to its start ends exactly like the plain read.
  const first = await threads.subscribe(KEY2, listener, { pageSize: 2, rows: 5 });
  await threads.loadOlder(KEY2, listener, 6);
  const left = current();
  assert.ok(left.hasMoreBefore && left.visibleTurnItems.length > 5);
  first();
  let back: ThreadSnapshot = left;
  const kinds: string[] = [];
  const rowsSent: number[] = [];
  const again = (m: { snapshot?: ThreadSnapshot; older?: ThreadOlder; resumed?: ThreadResumed }) => {
    if (m.resumed) {
      back = applyResumed(back, m.resumed)!;
      kinds.push("resumed");
      rowsSent.push(m.resumed.rows.length);
    }
    if (m.snapshot) {
      back = m.snapshot;
      kinds.push("snapshot");
    }
    if (m.older) back = prependOlder(back, m.older);
  };
  const off2 = await threads.subscribe(KEY2, again, { pageSize: 2, rows: 5, have: threadHave(left.visibleTurnItems) });
  assert.deepEqual(kinds, ["resumed"]);
  assert.deepEqual(rowsSent, [0]);
  assert.deepEqual(back.visibleTurnItems.map((r) => r.item.id), left.visibleTurnItems.map((r) => r.item.id));
  for (let guard = 0; back.hasMoreBefore; guard++) {
    assert.ok(guard < 50, "reaches the start");
    await threads.loadOlder(KEY2, again, 6);
  }
  assert.deepEqual(back.visibleTurnItems, whole.visibleTurnItems, "positions and ordinals too");
  off2();
});

test("find in a Codex thread: the view reads every turn page, a windowed subscriber only moves, and a step reaches the item", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  const F = "th3";
  const KEY3 = `codex:cx:${F}`;
  d.threads.set(F, makeThread(F, { status: { type: "notLoaded" } }));
  const turns = Array.from({ length: 9 }, (_, n) => ({
    id: `t${n}`, rootTurnId: `t${n}`, itemsView: "full", status: "completed", error: null,
    startedAt: 1_794_000_000 + n * 10, completedAt: 1_794_000_005 + n * 10, durationMs: 5000,
    items: [
      { type: "userMessage", id: `u${n}`, clientId: null, content: [{ type: "text", text: `질문 ${n}`, text_elements: [] }] },
      { type: "agentMessage", id: `a${n}`, text: `Answer ${n}${n === 4 ? " answer" : ""}`, phase: "final_answer", moderation: null, memoryCitation: null, delivery: null, questions: null },
    ],
  }));
  const limits: number[] = [];
  d.handlers.set("thread/turns/list", (p) => {
    const desc = [...turns].reverse();
    const start = typeof p.cursor === "string" ? Number(p.cursor) : 0;
    const size = typeof p.limit === "number" ? p.limit : 25;
    limits.push(size);
    const data = desc.slice(start, start + size);
    const end = start + data.length;
    return { data, nextCursor: end < desc.length ? String(end) : null, backwardsCursor: null };
  });
  d.handlers.set("thread/unsubscribe", () => ({ status: "unsubscribed" }));
  await d.listen();

  const threads = new CodexThreads({ accounts: [{ id: "cx", home: d.home }], index: new SessionIndex() });
  t.after(() => threads.closeAll());
  let held: ThreadSnapshot | null = null;
  const kinds: string[] = [];
  const listener = (m: { snapshot?: ThreadSnapshot; older?: ThreadOlder }) => {
    if (m.snapshot) held = m.snapshot;
    if (m.older && held) {
      held = prependOlder(held, m.older);
      kinds.push(m.older.requested ? `older:${m.older.visibleTurnItems.length}` : "moved");
    }
  };
  const current = (): ThreadSnapshot => held as unknown as ThreadSnapshot;
  const off = await threads.subscribe(KEY3, listener, { pageSize: 2, rows: 2 });
  const windowIds = current().visibleTurnItems.map((r) => r.item.id);

  const found = await threads.search(KEY3, "ANSWER", "c1");
  assert.equal(found.total, 10, "nine answers, one of them twice");
  assert.equal(found.searched, 18);
  assert.deepEqual(found.matches.map((m) => found.idPrefix + m.id), Array.from({ length: 9 }, (_, n) => codexItemRowId(KEY3, `a${n}`)));
  assert.deepEqual(limits.slice(1), [2, 4, 8], "growing pages after the first");
  assert.deepEqual(kinds, ["moved"], "the window only moves");
  assert.deepEqual(current().visibleTurnItems.map((r) => r.item.id), windowIds);
  const korean = await threads.search(KEY3, "질문 3", "c2");
  assert.deepEqual(korean.matches.map((m) => found.idPrefix + m.id), [codexItemRowId(KEY3, "u3")]);

  await threads.loadOlder(KEY3, listener, 2, codexItemRowId(KEY3, "u1"));
  assert.ok(current().visibleTurnItems.some((r) => r.item.id === codexItemRowId(KEY3, "u1")));
  assert.equal(current().visibleTurnItems[0]!.item.id, codexItemRowId(KEY3, "u1"));
  assert.equal(current().hasMoreBefore, true);
  off();
});

test("a Codex thread reports the client ids of the user rows it holds when a subscriber joins (DESIGN.md 4.4)", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  const W = "th3";
  d.threads.set(W, makeThread(W, { status: { type: "notLoaded" } }));
  const turn = {
    id: "t0", rootTurnId: "t0", itemsView: "full", status: "inProgress", error: null, startedAt: 1_794_000_000, completedAt: null, durationMs: null,
    items: [
      { type: "userMessage", id: "u0", clientId: "turn-start-id", content: [{ type: "text", text: "go", text_elements: [] }] },
      { type: "userMessage", id: "u1", clientId: "steer-id", content: [{ type: "text", text: "and also", text_elements: [] }] },
    ],
  };
  d.handlers.set("thread/turns/list", () => ({ data: [turn], nextCursor: null, backwardsCursor: null }));
  d.handlers.set("thread/resume", (p) => {
    const th = d.threads.get(String(p.threadId))!;
    return { thread: th, model: "m", modelProvider: "openai", cwd: th.cwd, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
  });
  d.handlers.set("thread/unsubscribe", () => ({ status: "unsubscribed" }));
  await d.listen();
  const reported: string[] = [];
  const threads = new CodexThreads({
    accounts: [{ id: "cx", home: d.home }],
    index: new SessionIndex(),
    delivery: { delivered: (key, ids) => reported.push(`${key}:${[...ids].sort().join(",")}`) },
  });
  t.after(() => threads.closeAll());
  const off = await threads.subscribe(`codex:cx:${W}`, () => {}, { rows: 5 });
  assert.deepEqual(reported, [`codex:cx:${W}:steer-id,turn-start-id`]);
  off();
});
