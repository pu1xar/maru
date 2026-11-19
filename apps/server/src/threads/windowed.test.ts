import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrchestrationV2ProjectedTurnItem, ThreadLiveEvent, ThreadOlder, ThreadSnapshot } from "@maru/shared";
import { fieldDigests, prependOlder, threadHave, windowStartIndex } from "@maru/shared";
import { createClaudeProjector } from "../claude/projection/projector.ts";
import type { RawRecord } from "../transcript/claudeTranscript.ts";
import { ThreadListeners, heldRows, openWindow, publishTo, resumeRows, resumeWindow, windowEvents, type ListenerMessage } from "./windowed.ts";

const types: Record<string, string> = { u: "user_message", a: "assistant_message", t: "command_execution" };
function row(id: string, type: string, position: number): OrchestrationV2ProjectedTurnItem {
  return { position, visibility: "local", sourceThreadId: "th", sourceItemId: id, item: { id, type: types[type] } as OrchestrationV2ProjectedTurnItem["item"], x: { raw: [], sourceKey: "test" } };
}
/** "u1 a2 t3" -> rows with those ids, positions from `first`. */
function list(spec: string, first = 0): OrchestrationV2ProjectedTurnItem[] {
  return spec.split(" ").filter(Boolean).map((s, i) => row(s, s[0]!, first + i));
}
function snap(items: OrchestrationV2ProjectedTurnItem[]): ThreadSnapshot {
  return {
    threadId: "th", lineage: {} as ThreadSnapshot["lineage"], providerInstanceId: "p", title: "t", state: {} as ThreadSnapshot["state"],
    runtime: null, runs: [], visibleTurnItems: items, branches: { lanes: [] }, subagents: [], tokenUsage: null, hasMoreBefore: false,
  };
}
const ids = (rows: readonly OrchestrationV2ProjectedTurnItem[]) => rows.map((r) => r.item.id);

test("openWindow: the newest rows and whether older ones exist", () => {
  const full = snap(list("u1 a2 t3 t4 a5 u6 a7"));
  const w = openWindow(full, 3, false);
  // Rows: u1, a2, (t3 t4), a5, u6, a7 -> the newest 3 are a5, u6, a7.
  assert.deepEqual(ids(w.snapshot.visibleTurnItems), ["a5", "u6", "a7"]);
  assert.equal(w.snapshot.hasMoreBefore, true);
  assert.deepEqual(w.state.ids, ["a5", "u6", "a7"]);
  assert.equal(w.state.firstPosition, 4);
  // Fewer rows than asked at the start of the thread: everything, nothing before.
  const all = openWindow(snap(list("u1 a2")), 30, false);
  assert.deepEqual(ids(all.snapshot.visibleTurnItems), ["u1", "a2"]);
  assert.equal(all.snapshot.hasMoreBefore, false);
  // Unread lines before: hasMoreBefore stays true even when the window takes every row read.
  assert.equal(openWindow(snap(list("u1 a2")), 30, true).snapshot.hasMoreBefore, true);
});

test("live events: rows before the window are left out, new rows join it, a replacement is cut to it", () => {
  const full = snap(list("u1 a2 u3 a4 u5 a6"));
  const { state } = openWindow(full, 2, false); // u5 a6
  const ev: ThreadLiveEvent[] = [
    { t: "turnItem.upserted", threadId: "th", row: row("a2", "a", 1) }, // before the window
    { t: "turnItem.upserted", threadId: "th", row: row("a6", "a", 5) }, // held: an update
    { t: "turnItem.textAppended", threadId: "th", itemId: "a6", field: "text", value: "x" },
    { t: "turnItem.textAppended", threadId: "th", itemId: "a4", field: "text", value: "y" },
    { t: "turnItem.upserted", threadId: "th", row: row("t7", "t", 6) }, // new: the running turn's tool call
    { t: "run.upserted", threadId: "th", run: { runId: "r" } as never },
  ];
  const out = windowEvents(state, ev, true);
  assert.deepEqual(out.map((e) => e.t === "turnItem.upserted" ? `up:${e.row.item.id}` : e.t === "turnItem.textAppended" ? `txt:${e.itemId}` : e.t), ["up:a6", "txt:a6", "up:t7", "run.upserted"]);
  assert.deepEqual(state.ids, ["u5", "a6", "t7"]);

  // A replacement whose held rows are still the tail: cut at the held first row.
  const replaced: ThreadLiveEvent = { t: "turnItems.replaced", threadId: "th", reason: "resync", visibleTurnItems: list("u1 a2 u3 a4 u5 a6 t7"), branches: { lanes: [] } };
  const [r] = windowEvents(state, [replaced], false);
  assert.ok(r?.t === "turnItems.replaced");
  assert.deepEqual(ids(r.visibleTurnItems), ["u5", "a6", "t7"]);
  assert.equal(r.hasMoreBefore, true);
  // A rewind took the held first row away (a branch): the newest `rows` rows of the new list.
  const branch: ThreadLiveEvent = { t: "turnItems.replaced", threadId: "th", reason: "branch", visibleTurnItems: list("u1 a2 n9 u8 a9"), branches: { lanes: [] } };
  const [b] = windowEvents(state, [branch], false);
  assert.ok(b?.t === "turnItems.replaced");
  assert.deepEqual(ids(b.visibleTurnItems), ["u8", "a9"]);
  assert.deepEqual(state.ids, ["u8", "a9"]);
});

test("publishTo: older rows read keep the held rows (older + shift); a held row that changed comes as an upsert", () => {
  const before = snap(list("u1 a2 u3 a4", 0));
  const { state } = openWindow(before, 2, true); // u3 a4 at positions 2, 3
  // 3 older rows were read: the server renumbers from the new first row.
  const after = snap(list("u0 a0 u9 u1 a2 u3 a4"));
  const notAsked = publishTo({ ...state, ids: [...state.ids], held: new Set(state.held) }, before, after, false, false);
  assert.equal(notAsked.length, 1, "nothing changed in the held rows");
  const o = notAsked[0]!.older!;
  assert.deepEqual({ rows: ids(o.visibleTurnItems), shift: o.positionShift, more: o.hasMoreBefore }, { rows: [], shift: 3, more: true });
  // Asked for 4 rows: u1, a2 come in front.
  state.rows = 4;
  const asked = publishTo(state, before, after, false, true);
  assert.deepEqual(ids(asked[0]!.older!.visibleTurnItems), ["u1", "a2"]);
  assert.deepEqual(state.ids, ["u1", "a2", "u3", "a4"]);
  assert.equal(state.firstPosition, 3);
  // The refold gave a held row its run (its opener was in the page): an upsert after the older rows.
  const s2 = openWindow(before, 2, true).state;
  const withRun = snap(list("u0 a0 u9 u1 a2 u3 a4").map((r) => (r.item.id === "a4" ? { ...r, item: { ...r.item, runId: "run-1" } } : r)));
  const msgs = publishTo(s2, before, withRun, false, false);
  assert.equal(msgs.length, 2);
  const up = msgs[1]!.events!;
  assert.deepEqual(up.map((e) => e.t === "turnItem.upserted" && e.row.item.id), ["a4"]);
});

test("publishTo: a held row gone from the list sends the window again", () => {
  const before = snap(list("u1 a2 u3 a4"));
  const { state } = openWindow(before, 2, false);
  // An orphan result (a4) joined its call in an older page: it is gone, the window is sent again.
  const m = publishTo(state, before, snap(list("u0 u1 a2 u3")), false, false);
  assert.equal(m.length, 1);
  assert.ok(m[0]!.snapshot);
  assert.deepEqual(ids(m[0]!.snapshot.visibleTurnItems), ["u3"]);
  assert.deepEqual(state.ids, ["u3"]);
});

/** The client side: what a windowed client holds after each message (the web reducer's merge). */
class Client {
  snapshot: ThreadSnapshot | null = null;
  apply(m: ListenerMessage): void {
    if (m.snapshot) this.snapshot = m.snapshot;
    if (m.older && this.snapshot) this.snapshot = prependOlder(this.snapshot, m.older as ThreadOlder);
    if (m.events && this.snapshot) {
      let items = [...this.snapshot.visibleTurnItems];
      for (const e of m.events) {
        if (e.t === "turnItem.upserted") {
          const i = items.findIndex((x) => x.item.id === e.row.item.id);
          if (i >= 0) items[i] = e.row;
          else items.push(e.row);
        } else if (e.t === "turnItems.replaced") {
          items = [...e.visibleTurnItems];
          if (e.hasMoreBefore !== undefined) this.snapshot = { ...this.snapshot, hasMoreBefore: e.hasMoreBefore };
        }
      }
      this.snapshot = { ...this.snapshot, visibleTurnItems: items };
    }
  }
}

// Claude transcript lines for the projector (the shapes projector.test.ts uses).
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let clock = 0;
const ts = () => new Date(Date.UTC(2026, 10, 16, 0, 0, clock++)).toISOString();
const prompt = (n: number, parent: number | null, text: string) => ({ parentUuid: parent === null ? null : U(parent), type: "user", message: { role: "user", content: text }, uuid: U(n), timestamp: ts(), promptId: `p${n}`, origin: { kind: "human" } });
const assistant = (n: number, parent: number, msgId: string, block: Record<string, unknown>) => ({
  parentUuid: U(parent), type: "assistant", uuid: U(n), timestamp: ts(),
  message: { model: "claude-opus-5-5", id: msgId, type: "message", role: "assistant", content: [block], usage: { input_tokens: 1, output_tokens: 1 } },
});
const toolResult = (n: number, parent: number, toolUseId: string, content: string) => ({
  parentUuid: U(parent), type: "user", uuid: U(n), timestamp: ts(), sourceToolAssistantUUID: U(parent),
  message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content, is_error: false }] },
});
function records(values: unknown[]): RawRecord[] {
  let offset = 0;
  return values.map((value) => {
    const length = Buffer.byteLength(JSON.stringify(value)) + 1;
    const r: RawRecord = { offset, length, line: null, value };
    offset += length;
    return r;
  });
}

/** A transcript with turns of tool calls, and a branch (two prompts under one parent) in the middle. */
function transcript(): unknown[] {
  const out: unknown[] = [];
  let n = 1;
  let parent: number | null = null;
  for (let turn = 0; turn < 12; turn++) {
    const p = n++;
    out.push(prompt(p, parent, `q${turn}`));
    parent = p;
    if (turn === 6) {
      // A rewound attempt under the same parent: the later prompt is main.
      const alt = n++;
      out.push(assistant(alt, p, `alt${turn}`, { type: "text", text: "abandoned" }));
      const again = n++;
      out.push(prompt(again, p - 1 >= 1 ? p - 1 : p, `q${turn} again`));
      parent = again;
    }
    for (let k = 0; k < 2; k++) {
      const call = n++;
      out.push(assistant(call, parent, `m${turn}-${k}`, { type: "tool_use", id: `tu${turn}-${k}`, name: "Bash", input: { command: `echo ${k}`, description: "d" } }));
      const res = n++;
      out.push(toolResult(res, call, `tu${turn}-${k}`, `${k}`));
      parent = res;
    }
    const ans = n++;
    out.push(assistant(ans, parent, `a${turn}`, { type: "text", text: `answer ${turn}` }));
    parent = ans;
  }
  return out;
}

/**
 * A windowed client follows a projector read in pages of `page` lines from the end, asking for
 * `step` rows at a time; at the end it must hold exactly the rows of the whole transcript read in
 * one piece, with the same positions.
 */
function followToStart(lines: RawRecord[], page: number, first: number, step: number, liveAt: number | null = null): { client: Client; whole: ThreadSnapshot; messages: { snapshots: number; older: number; events: number } } {
  const whole = (() => {
    const p = createClaudeProjector({ threadId: "th", account: "a", sessionId: "S", path: "/x/S.jsonl", readonly: true });
    p.push(lines);
    return p.snapshot();
  })();
  let end = liveAt ?? lines.length;
  let start = Math.max(0, end - page);
  const p = createClaudeProjector({ threadId: "th", account: "a", sessionId: "S", path: "/x/S.jsonl", readonly: true });
  p.push(lines.slice(start, end));
  const more = () => start > 0;
  const full = () => ({ ...p.snapshot(), hasMoreBefore: more() });
  const client = new Client();
  const listeners = new ThreadListeners();
  /** The rest of the lines arrive live, one at a time (as the transcript hub hands them over). */
  const liveLine = () => {
    if (end >= lines.length) return;
    listeners.events(p.push(lines.slice(end, end + 1)), more());
    end++;
  };
  // The threads' ensureRows: older pages until the newest `rows` rows are whole; live lines come
  // between the pages too (the reads are awaited).
  const ensure = (rows: number) => {
    let read = false;
    while (more() && !windowStartIndex(p.snapshot().visibleTurnItems, rows, true).complete) {
      listeners.beginPaging(full);
      const s = Math.max(0, start - page);
      p.prepend(lines.slice(s, start));
      start = s;
      read = true;
      if (liveAt !== null) liveLine();
    }
    return read;
  };
  const messages = { snapshots: 0, older: 0, events: 0 };
  const listener = (m: ListenerMessage) => {
    if (m.snapshot) messages.snapshots++;
    if (m.older) messages.older++;
    if (m.events) messages.events++;
    client.apply(m);
  };
  ensure(first);
  listeners.add(listener, full(), more(), first);
  let guard = 0;
  while (client.snapshot!.hasMoreBefore) {
    if (guard++ > 500) throw new Error("no end");
    // Live lines between requests.
    if (liveAt !== null) liveLine();
    const w = listeners.window(listener)!;
    w.rows = heldRows(w, p.snapshot().visibleTurnItems) + step;
    const read = ensure(w.rows);
    listeners.publish(full, more(), read ? { requester: listener } : { requester: listener, only: listener });
  }
  while (end < lines.length) liveLine();
  return { client, whole, messages };
}

test("a windowed client that scrolls to the start holds every row of the transcript, positions included", () => {
  const lines = records(transcript());
  let replaced = 0;
  for (const [page, first, step] of [[4, 3, 2], [7, 30, 30], [5, 1, 1], [1000, 30, 30], [3, 5, 4], [1, 1, 1], [2, 2, 1]] as const) {
    const { client, whole, messages } = followToStart(lines, page, first, step);
    replaced += messages.snapshots - 1;
    assert.equal(whole.branches.lanes.length, 1, "the transcript has a rewound attempt");
    assert.deepEqual(ids(client.snapshot!.visibleTurnItems), ids(whole.visibleTurnItems), `page ${page}, first ${first}, step ${step}`);
    assert.deepEqual(client.snapshot!.visibleTurnItems.map((r) => r.position), whole.visibleTurnItems.map((r) => r.position));
    assert.deepEqual(client.snapshot!.visibleTurnItems, whole.visibleTurnItems, "row content too");
    assert.deepEqual(client.snapshot!.branches, whole.branches, "the rewound attempt is a branch lane");
    assert.equal(client.snapshot!.hasMoreBefore, false);
  }
  // Some page cuts split a tool call from its result or the branch from its fork point: the refold
  // changed held rows and the window was sent again, and the client still ended exact.
  assert.ok(replaced > 0, `replacements: ${replaced}`);
  // A turn still running while the reader scrolls up: its lines come live between requests and
  // between the pages of one request, and join the window at its end.
  for (const [page, first, step, live] of [[4, 3, 2, 12], [2, 2, 1, 20], [7, 30, 30, 9]] as const) {
    const { client, whole } = followToStart(lines, page, first, step, lines.length - live);
    assert.deepEqual(ids(client.snapshot!.visibleTurnItems), ids(whole.visibleTurnItems), `live: page ${page}, first ${first}, step ${step}`);
    assert.deepEqual(client.snapshot!.visibleTurnItems, whole.visibleTurnItems, "row content too");
  }
});

test("publish: another reader's older page moves positions only; a plain subscriber gets the full snapshot", () => {
  const listeners = new ThreadListeners();
  const got: { w: ListenerMessage[]; p: ListenerMessage[] } = { w: [], p: [] };
  const windowed = (m: ListenerMessage) => got.w.push(m);
  const plain = (m: ListenerMessage) => got.p.push(m);
  listeners.add(windowed, snap(list("u3 a4 u5 a6", 0)), true, 2);
  listeners.add(plain, snap(list("u3 a4 u5 a6", 0)), true);
  assert.deepEqual(ids(got.w[0]!.snapshot!.visibleTurnItems), ["u5", "a6"]);
  assert.equal(got.p[0]!.snapshot!.visibleTurnItems.length, 4);
  // The plain subscriber read an older page (two rows).
  const after = snap(list("u1 a2 u3 a4 u5 a6", 0));
  listeners.publish(() => after, false);
  const o = got.w.at(-1)!.older!;
  assert.deepEqual({ rows: o.visibleTurnItems.length, shift: o.positionShift, requested: o.requested, more: o.hasMoreBefore }, { rows: 0, shift: 2, requested: false, more: true });
  assert.equal(got.p.at(-1)!.snapshot!.visibleTurnItems.length, 6);
  // The windowed one asks: it grows by its rows, positions already moved.
  listeners.window(windowed)!.rows = 4;
  listeners.publish(() => after, false, { requester: windowed, only: windowed });
  const o2 = got.w.at(-1)!.older!;
  assert.deepEqual({ rows: ids(o2.visibleTurnItems), shift: o2.positionShift, requested: o2.requested, more: o2.hasMoreBefore }, { rows: ["u3", "a4"], shift: 0, requested: true, more: true });
  assert.equal(got.p.length, 2, "a request that read nothing reaches only the requester");
  // At the start: the answer still comes, with nothing before.
  listeners.window(windowed)!.rows = 10;
  listeners.publish(() => after, false, { requester: windowed, only: windowed });
  const o3 = got.w.at(-1)!.older!;
  assert.deepEqual({ rows: ids(o3.visibleTurnItems), more: o3.hasMoreBefore }, { rows: ["u1", "a2"], more: false });
});

test("resumeRows: rows the thread must hold whole for a client's rows, or null when none is there", () => {
  const held = list("u1 a2 u3 a4");
  const have = threadHave(held);
  // Two rows came after the client's last row: its own 4 rows plus the rows from the anchor on (3).
  assert.equal(resumeRows(list("u1 a2 u3 a4 u5 a6"), have), 3 + 4);
  // The client's newest row is gone: its first row anchors, with one row for the cut edge.
  assert.equal(resumeRows(list("u1 a2 u3 a9 u5"), have), 5 + 1);
  assert.equal(resumeRows(list("u7 a8"), have), null);
  // `have.rows` cannot ask for more rows than items the client sent.
  assert.equal(resumeRows(list("u1 a2 u3 a4"), { ...have, rows: 1_000_000 }), 1 + 4);
});

test("resumeWindow: from the client's first row, only the rows whose content differs, positions as now", () => {
  const held = list("u1 a2 t3 a4", 10);
  const have = threadHave(held);
  const a4 = row("a4", "a", 7);
  const changedA4 = { ...a4, item: { ...a4.item, text: "more" } } as OrchestrationV2ProjectedTurnItem;
  // The server read an older row (u0) and numbers the held rows from 5; a4 changed and u5 came.
  const now = snap([row("u0", "u", 4), row("u1", "u", 5), row("a2", "a", 6), row("t3", "t", 7), { ...changedA4, position: 8 }, row("u5", "u", 9)]);
  const r = resumeWindow(now, have, 4, true)!;
  // u1, a2, t3 are the client's own first three: only the ids after them are sent.
  assert.equal(r.resumed.keep, 3);
  assert.deepEqual(r.resumed.ids.map((id) => r.resumed.idPrefix + id), ["a4", "u5"]);
  assert.deepEqual(r.resumed.positions, [5, 6, 7, 8, 9]);
  assert.deepEqual(ids(r.resumed.rows), ["a4", "u5"]);
  assert.equal(r.resumed.snapshot.hasMoreBefore, true, "u0 is before the window");
  assert.deepEqual(r.state.ids, ["u1", "a2", "t3", "a4", "u5"]);
  assert.equal(r.state.firstPosition, 5);
  assert.equal(r.state.rows, 5, "the window holds more rows than the client asked for");
  // No row the client holds is there: the usual window.
  assert.equal(resumeWindow(snap(list("u7 a8")), have, 4, false), null);
  // A held row gone from the middle (a result joined its call): the others are still placed.
  const merged = resumeWindow(snap(list("u1 a2 a4 u5")), have, 4, false)!;
  assert.equal(merged.resumed.keep, 2);
  assert.deepEqual(merged.resumed.ids.map((id) => merged.resumed.idPrefix + id), ["a4", "u5"]);
  assert.deepEqual(merged.resumed.positions, [0, 1, 2, 3]);
  assert.equal(merged.resumed.snapshot.hasMoreBefore, false);
});

test("ThreadListeners.add with have answers resumed, or the window when the client's first row is gone", () => {
  const listeners = new ThreadListeners();
  const got: ListenerMessage[] = [];
  const held = list("u1 a2 u3 a4");
  listeners.add((m) => got.push(m), snap(list("u1 a2 u3 a4 u5")), false, 30, threadHave(held));
  assert.ok(got[0]!.resumed && !got[0]!.snapshot);
  assert.deepEqual(ids(got[0]!.resumed!.rows), ["u5"]);
  const fallback: ListenerMessage[] = [];
  listeners.add((m) => fallback.push(m), snap(list("u7 a8 u9")), false, 2, threadHave(held));
  assert.ok(fallback[0]!.snapshot && !fallback[0]!.resumed);
  assert.deepEqual(ids(fallback[0]!.snapshot!.visibleTurnItems), ["a8", "u9"]);
});

test("resumeWindow sends the snapshot fields the client does not hold as they are, and only those", () => {
  const held = list("u1 a2");
  const full = { ...snap(list("u1 a2 u3")), title: "new title", subagents: [{ id: "s1" } as never] };
  const known = fieldDigests({ ...full, title: "old title" });
  const r = resumeWindow(full, threadHave(held, known), 30, false)!;
  assert.deepEqual(Object.keys(r.resumed.snapshot).sort(), ["hasMoreBefore", "title"]);
  assert.equal(r.resumed.snapshot.title, "new title");
  // Without field hashes every field is sent.
  const all = resumeWindow(full, threadHave(held), 30, false)!;
  assert.deepEqual(Object.keys(all.resumed.snapshot).sort(), ["branches", "hasMoreBefore", "lineage", "providerInstanceId", "runs", "runtime", "state", "subagents", "title", "tokenUsage"]);
});
