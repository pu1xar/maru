import { after, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PendingSend } from "@maru/shared";
import {
  ENDED_BEFORE_TAKEN, LOST_IN_RESTART, NOT_DELIVERED, PendingSends, applyPendingEvent, claudeMessageEvents, readSendsInTranscript, reconcilePending, recallOf, renameSend,
  settleEndedRun, deliveredIdsOfLine, scanDelivered, settleDelivered, settleFromTranscript,
  type StoredSend, type TranscriptReader,
} from "./pendingSends.ts";
import { readTail } from "../transcript/claudeTranscript.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pending-sends-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const CK = "claude:acct:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const XK = "codex:cx:11111111-2222-4333-8444-555555555555";
const s = (id: string, state: StoredSend["state"], error: string | null = null): StoredSend => ({ id, text: `text ${id}`, attachments: [], sentAt: 1, state, error });
const states = (list: readonly StoredSend[]) => list.map((x) => `${x.id}:${x.state}`);
/** A TranscriptReader that finds `present` (each at offset 0, or the offset given) and counts its calls. */
const reader = (present: Record<string, number> | string[], calls: string[] = []): TranscriptReader => async (key, ids) => {
  calls.push(key);
  const at = Array.isArray(present) ? Object.fromEntries(present.map((id) => [id, 0])) : present;
  return new Map([...ids].filter((id) => id in at).map((id) => [id, at[id]!]));
};

describe("applyPendingEvent", () => {
  test("sent, queued, taken, done: the row goes once its turn is over", () => {
    let list = [s("a", "sending")];
    list = applyPendingEvent(list, { kind: "queued", id: "a" });
    assert.deepEqual(states(list), ["a:queued"]);
    list = applyPendingEvent(list, { kind: "taken", id: "a" });
    assert.deepEqual(states(list), ["a:taken"]);
    // A late "queued" (the send's answer after the CLI's started) does not move it back.
    list = applyPendingEvent(list, { kind: "queued", id: "a" });
    assert.deepEqual(states(list), ["a:taken"]);
    list = applyPendingEvent(list, { kind: "done", id: "a" });
    assert.deepEqual(list, []);
  });

  test("taken straight from sending (an idle session takes it at once), and from failed (a lifecycle after a restart)", () => {
    assert.deepEqual(states(applyPendingEvent([s("a", "sending")], { kind: "taken", id: "a" })), ["a:taken"]);
    const fromFailed = applyPendingEvent([s("a", "failed", LOST_IN_RESTART)], { kind: "taken", id: "a" });
    assert.deepEqual([fromFailed[0]!.state, fromFailed[0]!.error], ["taken", null]);
  });

  test("failed only before the model took it", () => {
    const list = [s("a", "sending"), s("b", "queued"), s("c", "taken")];
    const out = ["a", "b", "c"].reduce((l, id) => applyPendingEvent(l, { kind: "failed", id, error: "boom" }), list);
    assert.deepEqual(states(out), ["a:failed", "b:failed", "c:taken"]);
    assert.equal(out[0]!.error, "boom");
  });


  test("turnEnded (a Codex turn ended or the thread was let go) drops what the daemon took", () => {
    const out = applyPendingEvent([s("a", "taken"), s("b", "queued"), s("c", "sending"), s("d", "failed", "x")], { kind: "turnEnded" });
    assert.deepEqual(states(out), ["c:sending", "d:failed"]);
  });

  test("an unknown id changes nothing", () => {
    const list = [s("a", "queued")];
    assert.deepEqual(applyPendingEvent(list, { kind: "taken", id: "zzz" }), list);
  });
});

describe("recallOf", () => {
  test("a queued Claude message and any failed one come back; the rest say why not", () => {
    assert.deepEqual(recallOf("claude", s("a", "queued")), { enabled: true, reason: null });
    assert.deepEqual(recallOf("codex", s("a", "failed", "x")), { enabled: true, reason: null });
    assert.equal(recallOf("claude", s("a", "sending")).enabled, false);
    assert.equal(recallOf("claude", s("a", "taken")).enabled, false);
    const codex = recallOf("codex", s("a", "queued"));
    assert.equal(codex.enabled, false);
    assert.match(codex.reason ?? "", /Codex/);
  });
});

describe("claudeMessageEvents", () => {
  test("command_lifecycle states (CLI 2.1.325)", () => {
    const lc = (state: string) => ({ type: "command_lifecycle", command_uuid: "u1", state, uuid: "x", session_id: "s" });
    assert.deepEqual(claudeMessageEvents(lc("queued")), [{ kind: "queued", id: "u1" }]);
    assert.deepEqual(claudeMessageEvents(lc("started")), [{ kind: "taken", id: "u1" }]);
    assert.deepEqual(claudeMessageEvents(lc("completed")), [{ kind: "done", id: "u1" }]);
    assert.deepEqual(claudeMessageEvents(lc("cancelled")), [{ kind: "cancelled", id: "u1" }]);
    assert.deepEqual(claudeMessageEvents(lc("weird")), []);
  });

  test("a result ends every message its turn consumed, the folded ones too", () => {
    assert.deepEqual(claudeMessageEvents({ type: "result", user_message_uuid: "u1", user_message_uuids: ["u1", "u2"] }), [
      { kind: "done", id: "u1" }, { kind: "done", id: "u2" },
    ]);
    assert.deepEqual(claudeMessageEvents({ type: "result", user_message_uuid: "u9" }), [{ kind: "done", id: "u9" }]);
    assert.deepEqual(claudeMessageEvents({ type: "assistant" }), []);
  });
});

describe("PendingSends", () => {
  const open = (file = ":memory:") => {
    const published: Array<{ key: string; sends: PendingSend[] }> = [];
    const store = new PendingSends({ file, publish: (key, sends) => published.push({ key, sends }), now: () => 42 });
    return { store, published };
  };

  test("publishes the whole list on each change and keeps it in the state file", () => {
    const file = path.join(root, "state.sqlite");
    const a = open(file);
    a.store.sent(CK, "u1", "first");
    a.store.sent(CK, "u2", "second");
    a.store.apply(CK, { kind: "queued", id: "u1" });
    assert.deepEqual(a.published.at(-1)!.sends.map((x) => [x.id, x.state, x.recall.enabled]), [["u1", "queued", true], ["u2", "sending", false]]);
    a.store.apply(CK, { kind: "queued", id: "u1" });
    assert.equal(a.published.length, 3, "no change, no publish");
    a.store.close();
    // A restart of this server reads it back in the order sent.
    const b = open(file);
    assert.deepEqual(b.store.list(CK).map((x) => [x.id, x.text, x.state, x.sentAt]), [["u1", "first", "queued", 42], ["u2", "second", "sending", 42]]);
    b.store.apply(CK, { kind: "done", id: "u1" });
    b.store.apply(CK, { kind: "done", id: "u2" });
    assert.deepEqual(b.published.at(-1), { key: CK, sends: [] });
    b.store.close();
    const c = open(file);
    assert.deepEqual(c.store.all(), []);
    c.store.close();
  });

  test("recall: oldest first, a queued Claude message only when the CLI took it out", async () => {
    const { store } = open();
    store.sent(CK, "u1", "one");
    store.sent(CK, "u2", "two");
    store.sent(CK, "u3", "three");
    store.apply(CK, { kind: "queued", id: "u1" });
    store.apply(CK, { kind: "queued", id: "u2" });
    store.apply(CK, { kind: "taken", id: "u3" });
    const asked: string[] = [];
    const res = await store.recall(CK, ["u3", "u2", "u1", "gone"], async (id) => {
      asked.push(id);
      return id === "u1";
    });
    assert.deepEqual(asked, ["u1", "u2"]);
    assert.deepEqual(res.messages.map((m) => [m.id, m.text]), [["u1", "one"]]);
    assert.equal(res.errors.length, 3);
    assert.deepEqual(states(store.stored(CK)), ["u2:queued", "u3:taken"]);
  });

  test("recall: a failed message comes back without asking the provider; a Codex steer does not come back", async () => {
    const { store } = open();
    store.sent(XK, "c1", "steer");
    store.apply(XK, { kind: "queued", id: "c1" });
    store.sent(XK, "c2", "lost");
    store.apply(XK, { kind: "failed", id: "c2", error: "daemon down" });
    const res = await store.recall(XK, ["c1", "c2"], async () => assert.fail("no cancel for Codex"));
    assert.deepEqual(res.messages.map((m) => m.text), ["lost"]);
    assert.equal(res.errors.length, 1);
    assert.deepEqual(states(store.stored(XK)), ["c1:queued"]);
  });

  test("recall: a failed Claude message is taken out of the CLI too, unless the model got it meanwhile", async () => {
    const { store } = open();
    store.sent(CK, "u1", "one");
    store.apply(CK, { kind: "failed", id: "u1", error: ENDED_BEFORE_TAKEN });
    store.sent(CK, "u2", "two");
    store.apply(CK, { kind: "failed", id: "u2", error: LOST_IN_RESTART });
    const asked: string[] = [];
    const res = await store.recall(CK, ["u1", "u2"], async (id) => {
      asked.push(id);
      // While u2's cancel is on its way the CLI reports that the model took it.
      if (id === "u2") store.apply(CK, { kind: "taken", id: "u2" });
      if (id === "u1") throw new Error("no run");
      return false;
    });
    assert.deepEqual(asked, ["u1", "u2"]);
    assert.deepEqual(res.messages.map((m) => m.text), ["one"]);
    assert.match(res.errors[0]!, /received it in the meantime/);
    assert.deepEqual(states(store.stored(CK)), ["u2:taken"]);
  });

  test("recall: the reason follows the state after a refused cancel", async () => {
    const { store } = open();
    for (const id of ["u1", "u2"]) {
      store.sent(CK, id, id);
      store.apply(CK, { kind: "queued", id });
    }
    const res = await store.recall(CK, ["u1", "u2"], async (id) => {
      // u1: another tab took it back first; u2: still between the host and the CLI.
      if (id === "u1") store.apply(CK, { kind: "done", id });
      return false;
    });
    assert.match(res.errors[0]!, /Already taken back elsewhere/);
    assert.match(res.errors[1]!, /has not reached the CLI yet/);
  });

  test("attachments are kept with the message, in the state file too, and come back with it", async () => {
    const file = path.join(root, "attach.sqlite");
    const pic = { id: "20261116-a", kind: "image" as const, name: "a.png", mimeType: "image/png", sizeBytes: 3, path: "/x/a.png" };
    const a = open(file);
    a.store.sent(CK, "u1", "", [pic]);
    a.store.apply(CK, { kind: "queued", id: "u1" });
    assert.deepEqual(a.published.at(-1)!.sends[0]!.attachments, [pic]);
    a.store.close();
    const b = open(file);
    assert.deepEqual(b.store.list(CK)[0]!.attachments, [pic]);
    const res = await b.store.recall(CK, ["u1"], async () => true);
    assert.deepEqual(res.messages, [{ id: "u1", text: "", attachments: [pic] }]);
    b.store.close();
  });

  test("recall: a cancel that throws (old host) keeps the message", async () => {
    const { store } = open();
    store.sent(CK, "u1", "one");
    store.apply(CK, { kind: "queued", id: "u1" });
    const res = await store.recall(CK, ["u1"], async () => {
      throw new Error("host is old");
    });
    assert.deepEqual(res.messages, []);
    assert.match(res.errors[0]!, /host is old/);
    assert.deepEqual(states(store.stored(CK)), ["u1:queued"]);
  });

  describe("Send now replaces a message under a new id (replacing, replaced, kept)", () => {
    const rows = (store: PendingSends) => store.list(CK).map((x) => `${x.id}:${x.state}`);
    const three = () => {
      const o = open();
      for (const id of ["u1", "u2", "u3"]) {
        o.store.sent(CK, id, `text ${id}`);
        o.store.apply(CK, { kind: "queued", id });
      }
      return o;
    };

    test("the CLI's cancelled message comes first: the row is renamed in place, never removed, and the take-out's answer changes nothing more", () => {
      const { store, published } = three();
      store.replacing(CK, "u2", "n2");
      const before = published.length;
      store.apply(CK, { kind: "cancelled", id: "u2" });
      assert.deepEqual(rows(store), ["u1:queued", "n2:sending", "u3:queued"], "same place, a message the provider is being handed");
      assert.equal(published.length, before + 1, "one list change, so no UI sees the row go and come back");
      assert.ok(published.slice(before).every((p) => p.sends.length === 3), "the list never lacks the row");
      store.replaced(CK, "u2", "n2");
      assert.equal(published.length, before + 1);
      assert.equal(store.stored(CK)[1]!.text, "text u2", "the text and attachments stay");
    });

    test("the take-out's answer comes first: replaced renames the row, the cancelled message that follows changes nothing", () => {
      const { store } = three();
      store.replacing(CK, "u2", "n2");
      store.replaced(CK, "u2", "n2");
      assert.deepEqual(rows(store), ["u1:queued", "n2:sending", "u3:queued"]);
      store.apply(CK, { kind: "cancelled", id: "u2" });
      assert.deepEqual(rows(store), ["u1:queued", "n2:sending", "u3:queued"]);
      // The new id goes on from there: queued, taken, done.
      store.apply(CK, { kind: "queued", id: "n2" });
      store.apply(CK, { kind: "taken", id: "n2" });
      store.apply(CK, { kind: "done", id: "n2" });
      assert.deepEqual(rows(store), ["u1:queued", "u3:queued"]);
    });

    test("kept: the model had the message, so the id stays and a later cancelled message removes it as a take-back does", () => {
      const { store } = three();
      store.replacing(CK, "u2", "n2");
      store.kept(CK, "u2");
      store.apply(CK, { kind: "taken", id: "u2" });
      assert.deepEqual(rows(store), ["u1:queued", "u2:taken", "u3:queued"]);
      store.apply(CK, { kind: "cancelled", id: "u3" });
      assert.deepEqual(rows(store), ["u1:queued", "u2:taken"], "a cancelled message with no replacement is a take-back: the row goes");
    });

    test("a send that fails after the take-out leaves a failed row that can be taken back, not a lost message", async () => {
      const { store } = three();
      store.replacing(CK, "u1", "n1");
      store.replaced(CK, "u1", "n1");
      store.apply(CK, { kind: "failed", id: "n1", error: "Not sent again: host connection lost" });
      assert.deepEqual(store.list(CK).map((x) => [x.id, x.state, x.error, x.recall.enabled]), [
        ["n1", "failed", "Not sent again: host connection lost", true], ["u2", "queued", null, true], ["u3", "queued", null, true],
      ]);
      const res = await store.recall(CK, ["n1"], async () => false);
      assert.deepEqual(res.messages.map((m) => [m.id, m.text]), [["n1", "text u1"]]);
      assert.deepEqual(rows(store), ["u2:queued", "u3:queued"]);
    });

    test("the new id is what the state file keeps, and a replacement is in place for the other sessions untouched", () => {
      const file = path.join(root, "rename.sqlite");
      const a = open(file);
      a.store.sent(CK, "u1", "one");
      a.store.sent(XK, "x1", "other session");
      a.store.apply(CK, { kind: "queued", id: "u1" });
      a.store.replacing(CK, "u1", "n1");
      a.store.apply(CK, { kind: "cancelled", id: "u1" });
      a.store.close();
      const b = open(file);
      assert.deepEqual(b.store.list(CK).map((x) => [x.id, x.state, x.text]), [["n1", "sending", "one"]]);
      assert.deepEqual(b.store.list(XK).map((x) => x.id), ["x1"]);
      b.store.close();
    });

    test("a row that is gone is not brought back, and a replacement for another session does not apply", () => {
      const { store } = three();
      store.apply(CK, { kind: "done", id: "u2" });
      store.replaced(CK, "u2", "n2");
      assert.deepEqual(rows(store), ["u1:queued", "u3:queued"]);
      store.replacing(XK, "u1", "nx");
      store.apply(CK, { kind: "cancelled", id: "u1" });
      assert.deepEqual(rows(store), ["u3:queued"], "the replacement was registered for another session");
    });
  });
});

describe("renameSend", () => {
  test("the id changes in the same place and the message is a sending one again; others are untouched", () => {
    const list = [s("a", "queued"), s("b", "queued", "x"), s("c", "taken")];
    const out = renameSend(list, "b", "n");
    assert.deepEqual(states(out), ["a:queued", "n:sending", "c:taken"]);
    assert.equal(out[1]!.error, null);
    assert.equal(out[0], list[0], "an untouched message is the same object");
    assert.deepEqual(states(renameSend(list, "zzz", "n")), states(list));
  });
});

describe("settleEndedRun", () => {
  test("a Claude run ended: the transcript decides; taken goes; a message on its way stays for the next run", async () => {
    const store = new PendingSends({ file: ":memory:", publish: () => {} });
    store.sent(CK, "onway", "x");
    for (const id of ["dropped", "written", "took"]) {
      store.sent(CK, id, "x");
      store.apply(CK, { kind: "queued", id });
    }
    store.apply(CK, { kind: "taken", id: "took" });
    store.sent(CK, "old", "x");
    store.apply(CK, { kind: "failed", id: "old", error: "x" });
    // 닫기: the queued message opened the next turn and was written as its prompt before the exit.
    const calls: string[] = [];
    await settleEndedRun(store, CK, reader(["written"], calls));
    assert.deepEqual(states(store.stored(CK)), ["onway:sending", "dropped:failed", "old:failed"]);
    assert.equal(store.stored(CK)[1]!.error, ENDED_BEFORE_TAKEN);
    assert.equal(calls.length, 1, "the transcript is read once for the two queued messages");
  });

  test("a transcript that cannot be read leaves the queued messages; a line whose row is not out yet is left to the thread", async () => {
    const store = new PendingSends({ file: ":memory:", publish: () => {} });
    for (const id of ["a", "b"]) {
      store.sent(CK, id, "x");
      store.apply(CK, { kind: "queued", id });
    }
    await settleEndedRun(store, CK, async () => null);
    assert.deepEqual(states(store.stored(CK)), ["a:queued", "b:queued"]);
    // a is below the thread's sent offset, b is beyond it.
    await settleEndedRun(store, CK, reader({ a: 100, b: 900 }), () => 500);
    assert.deepEqual(states(store.stored(CK)), ["b:queued"]);
  });
});

describe("reconcilePending", () => {
  test("after a restart: transcript, live run and provider decide", async () => {
    const published: string[] = [];
    const store = new PendingSends({ file: ":memory:", publish: (key) => published.push(key) });
    const C2 = "claude:acct:22222222-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    store.sent(CK, "seen-busy", "x");
    store.sent(CK, "waiting", "x");
    store.apply(CK, { kind: "queued", id: "waiting" });
    store.sent(CK, "inflight", "x");
    store.sent(C2, "seen-idle", "x");
    store.apply(C2, { kind: "queued", id: "seen-idle" });
    store.sent(C2, "dropped", "x");
    store.apply(C2, { kind: "queued", id: "dropped" });
    store.sent(XK, "accepted", "x");
    store.apply(XK, { kind: "queued", id: "accepted" });
    store.sent(XK, "unsure", "x");
    store.sent(C2, "failed-but-written", "x");
    store.apply(C2, { kind: "failed", id: "failed-but-written", error: ENDED_BEFORE_TAKEN });
    store.sent(C2, "failed-really", "x");
    store.apply(C2, { kind: "failed", id: "failed-really", error: ENDED_BEFORE_TAKEN });
    const calls: string[] = [];
    await reconcilePending(store, {
      claudeRun: (key) => (key === CK ? { busy: true } : null),
      claudeTranscript: reader(["seen-busy", "seen-idle", "failed-but-written"], calls),
    });
    // C: one read per session, however many messages it has (CK has 3, C2 has 4).
    assert.deepEqual(calls.sort(), [C2, CK].sort());
    assert.deepEqual(states(store.stored(CK)), ["seen-busy:taken", "waiting:queued", "inflight:failed"]);
    assert.equal(store.stored(CK)[2]!.error, LOST_IN_RESTART);
    assert.deepEqual(states(store.stored(C2)), ["dropped:failed", "failed-really:failed"]);
    assert.equal(store.stored(C2)[0]!.error, ENDED_BEFORE_TAKEN);
    assert.deepEqual(states(store.stored(XK)), ["unsure:failed"]);
  });

  test("an idle run holds no queue; only the providers asked for are checked; a message that moved on is left", async () => {
    const store = new PendingSends({ file: ":memory:", publish: () => {} });
    store.sent(CK, "idle-q", "x");
    store.apply(CK, { kind: "queued", id: "idle-q" });
    store.sent(CK, "idle-taken", "x");
    store.apply(CK, { kind: "taken", id: "idle-taken" });
    store.sent(CK, "moves", "x");
    store.apply(CK, { kind: "queued", id: "moves" });
    store.sent(XK, "codex", "x");
    store.apply(XK, { kind: "queued", id: "codex" });
    await reconcilePending(store, {
      claudeRun: () => ({ busy: false }),
      claudeTranscript: async () => {
        // The lifecycle message for "moves" arrives while its transcript is read.
        store.apply(CK, { kind: "taken", id: "moves" });
        return new Map();
      },
    }, ["claude"]);
    assert.deepEqual(states(store.stored(CK)), ["idle-q:failed", "moves:taken"]);
    assert.equal(store.stored(CK)[0]!.error, NOT_DELIVERED);
    assert.deepEqual(states(store.stored(XK)), ["codex:queued"], "Codex was not asked for");
  });
});

describe("reconcilePending reads a session's transcript once and by the delivered-id definition", () => {
  test("a transcript that cannot be read through leaves the session's messages as they are", async () => {
    const store = new PendingSends({ file: ":memory:", publish: () => {} });
    store.sent(CK, "q", "x");
    store.apply(CK, { kind: "queued", id: "q" });
    store.sent(CK, "f", "x");
    store.apply(CK, { kind: "failed", id: "f", error: "x" });
    await reconcilePending(store, { claudeRun: () => null, claudeTranscript: async () => null }, ["claude"]);
    assert.deepEqual(states(store.stored(CK)), ["q:queued", "f:failed"]);
  });

  test("a line whose row is not out yet (at or beyond the thread's sent offset) does not remove; a busy run still marks it taken", async () => {
    const store = new PendingSends({ file: ":memory:", publish: () => {} });
    const C2 = "claude:acct:22222222-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    for (const [k, id] of [[CK, "in"], [CK, "late"], [C2, "late-busy"]] as const) {
      store.sent(k, id, "x");
      store.apply(k, { kind: "queued", id });
    }
    await reconcilePending(store, {
      claudeRun: (key) => (key === C2 ? { busy: true } : { busy: false }),
      claudeTranscript: reader({ in: 10, late: 800, "late-busy": 800 }),
      settleLimit: () => 500,
    }, ["claude"]);
    assert.deepEqual(states(store.stored(CK)), ["late:queued"]);
    assert.deepEqual(states(store.stored(C2)), ["late-busy:taken"]);
  });

  test("readSendsInTranscript: ids by deliveredIdsOfLine (not by text), a missing file shows none", async () => {
    const file = path.join(root, "t.jsonl");
    const id = "aaaaaaaa-1111-4222-8333-444444444444";
    const other = "cccccccc-1111-4222-8333-444444444444";
    fs.writeFileSync(file, [
      JSON.stringify({ type: "assistant", uuid: "x", message: { content: [{ type: "text", text: `the id ${other} in prose` }] } }),
      JSON.stringify({ type: "queue-operation", operation: "remove", content: id }),
      JSON.stringify({ type: "user", uuid: id, message: { content: "hi" } }),
    ].join("\n") + "\n");
    const found = await readSendsInTranscript(file, new Set([id, other, "bbbbbbbb-1111-4222-8333-444444444444"]), 0);
    assert.deepEqual([...found!.keys()], [id]);
    assert.equal(found!.get(id)! > 0, true, "offset of the user line");
    assert.deepEqual([...(await readSendsInTranscript(path.join(root, "missing"), new Set([id]), 0))!], []);
    assert.deepEqual([...(await readSendsInTranscript(null, new Set([id]), 0))!], []);
  });
});

describe("settle by the conversation's rows (DESIGN.md 4.4)", () => {
  const store = (states: Array<[string, StoredSend["state"]]>) => {
    const p = new PendingSends({ file: ":memory:", publish: () => {} });
    for (const [id, state] of states) {
      p.sent(CK, id, `text ${id}`);
      if (state === "queued" || state === "taken") p.apply(CK, { kind: state, id });
      if (state === "failed") p.apply(CK, { kind: "failed", id, error: "x" });
    }
    return p;
  };

  test("settleDelivered clears every state the id names and leaves the others", () => {
    const p = store([["a", "sending"], ["b", "queued"], ["c", "taken"], ["d", "failed"], ["e", "taken"]]);
    settleDelivered(p, CK, new Set(["a", "b", "c", "d", "zzz"]));
    assert.deepEqual(states(p.stored(CK)), ["e:taken"]);
    p.close();
  });

  test("deliveredIdsOfLine reads a prompt line, its merged sends, and a queued_command source_uuid only", () => {
    assert.deepEqual(deliveredIdsOfLine({ type: "user", uuid: "u1", mergedSendUuids: ["m1", "m2", 3, ""] }), ["u1", "m1", "m2"]);
    assert.deepEqual(deliveredIdsOfLine({ type: "attachment", uuid: "x", attachment: { type: "queued_command", source_uuid: "s1" } }), ["s1"]);
    assert.deepEqual(deliveredIdsOfLine({ type: "attachment", uuid: "x", attachment: { type: "file", source_uuid: "s1" } }), []);
    // A queue-operation line carries the text, not the id.
    assert.deepEqual(deliveredIdsOfLine({ type: "queue-operation", operation: "remove", content: "s1" }), []);
    assert.deepEqual(deliveredIdsOfLine(null), []);
    assert.deepEqual(deliveredIdsOfLine({ __parseError: true, raw: "x" }), []);
  });

  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  const iso = (ms: number) => new Date(ms).toISOString();

  test("settleFromTranscript finds taken ids far above the end (user line and queued_command), across pages", async () => {
    const t0 = Date.UTC(2026, 10, 17, 7, 0, 0);
    const file = path.join(root, "long.jsonl");
    const rows: string[] = [line({ type: "user", uuid: "old-1", timestamp: iso(t0 - 3 * 3600_000), message: { content: "older" } })];
    rows.push(line({ type: "user", uuid: "cf239028", timestamp: iso(t0 + 1000), message: { content: "prompt" } }));
    rows.push(line({ type: "attachment", uuid: "q1", timestamp: iso(t0 + 2000), attachment: { type: "queued_command", prompt: "steer", source_uuid: "30f8a573" } }));
    // 4,500 lines of a long turn after them: more than two pages of 2,000.
    for (let i = 0; i < 4500; i++) rows.push(line({ type: "assistant", uuid: `a${i}`, timestamp: iso(t0 + 3000 + i * 1000), message: { content: [] } }));
    fs.writeFileSync(file, rows.join(""));
    const p = new PendingSends({ file: ":memory:", publish: () => {}, now: () => t0 });
    for (const id of ["cf239028", "30f8a573", "never-written"]) {
      p.sent(CK, id, `text ${id}`);
      p.apply(CK, { kind: "taken", id });
    }
    await settleFromTranscript(p, CK, file);
    assert.deepEqual(states(p.stored(CK)), ["never-written:taken"]);
    p.close();
  });

  test("the backward read stops at lines older than the oldest send (an id before it is not read for)", async () => {
    const t0 = Date.UTC(2026, 10, 17, 7, 0, 0);
    const file = path.join(root, "bound.jsonl");
    const rows = [line({ type: "user", uuid: "before-send", timestamp: iso(t0 - 5 * 3600_000), message: { content: "x" } })];
    for (let i = 0; i < 2000; i++) rows.push(line({ type: "assistant", uuid: `o${i}`, timestamp: iso(t0 - 4 * 3600_000 + i), message: { content: [] } }));
    for (let i = 0; i < 2500; i++) rows.push(line({ type: "assistant", uuid: `b${i}`, timestamp: iso(t0 + i * 1000), message: { content: [] } }));
    fs.writeFileSync(file, rows.join(""));
    const found = await scanDelivered(file, new Set(["before-send"]), t0);
    assert.equal(found.size, 0);
    // The same file read for a send an hour before the line finds it.
    assert.deepEqual([...(await scanDelivered(file, new Set(["before-send"]), t0 - 6 * 3600_000))], ["before-send"]);
  });

  test("a session read before finds a message the CLI folds in later, from the lines written since", async () => {
    const t0 = Date.UTC(2026, 10, 17, 8, 0, 0);
    const file = path.join(root, "incremental.jsonl");
    const filler = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => line({ type: "assistant", uuid: `f${from + i}`, timestamp: iso(t0 + (from + i) * 1000), message: { content: [] } })).join("");
    fs.writeFileSync(file, filler(3000, 0));
    const p = new PendingSends({ file: ":memory:", publish: () => {}, now: () => t0 });
    p.sent(CK, "q-steer-1", "steer");
    p.apply(CK, { kind: "queued", id: "q-steer-1" });
    await settleFromTranscript(p, CK, file);
    assert.deepEqual(states(p.stored(CK)), ["q-steer-1:queued"]);
    // A second read of the unchanged file changes nothing.
    await settleFromTranscript(p, CK, file);
    assert.deepEqual(states(p.stored(CK)), ["q-steer-1:queued"]);
    // The CLI folds it in later: the next read covers only the new lines and finds it.
    fs.appendFileSync(file, filler(10, 3000) + line({ type: "attachment", uuid: "qc", timestamp: iso(t0 + 3100 * 1000), attachment: { type: "queued_command", prompt: "steer", source_uuid: "q-steer-1" } }));
    await settleFromTranscript(p, CK, file);
    assert.deepEqual(states(p.stored(CK)), []);
    p.close();
  });

  test("a failed message is left to reconcilePending, not read for on every subscribe", async () => {
    const t0 = Date.UTC(2026, 10, 17, 9, 0, 0);
    const file = path.join(root, "failed.jsonl");
    fs.writeFileSync(file, line({ type: "user", uuid: "failed-but-in", timestamp: iso(t0 + 1000), message: { content: "x" } }));
    const p = new PendingSends({ file: ":memory:", publish: () => {}, now: () => t0 });
    p.sent(CK, "failed-but-in", "x");
    p.apply(CK, { kind: "failed", id: "failed-but-in", error: "끊김" });
    await settleFromTranscript(p, CK, file);
    assert.deepEqual(states(p.stored(CK)), ["failed-but-in:failed"]);
    p.close();
  });

  test("a line beyond the thread's sent offset is left to the delivery hook; once the offset passes it, a later read settles it", async () => {
    const t0 = Date.UTC(2026, 10, 17, 10, 0, 0);
    const file = path.join(root, "limit.jsonl");
    const first = line({ type: "user", uuid: "row-out", timestamp: iso(t0 + 1000), message: { content: "a" } });
    const second = line({ type: "user", uuid: "row-pending", timestamp: iso(t0 + 2000), message: { content: "b" } });
    fs.writeFileSync(file, first + second);
    const p = new PendingSends({ file: ":memory:", publish: () => {}, now: () => t0 });
    for (const id of ["row-out", "row-pending"]) {
      p.sent(CK, id, `text ${id}`);
      p.apply(CK, { kind: "taken", id });
    }
    // The thread's projector has consumed (and sent) the first line only.
    let limit = Buffer.byteLength(first);
    await settleFromTranscript(p, CK, file, { limit: () => limit });
    assert.deepEqual(states(p.stored(CK)), ["row-pending:taken"]);
    // Nothing new in the file and the limit unmoved: the unsettled line is read again, not skipped by the memo.
    await settleFromTranscript(p, CK, file, { limit: () => limit });
    assert.deepEqual(states(p.stored(CK)), ["row-pending:taken"]);
    // The delivery hook (the row went out) settles it; here the limit moving past it lets a scan do the same.
    limit = Buffer.byteLength(first + second);
    await settleFromTranscript(p, CK, file, { limit: () => limit });
    assert.deepEqual(states(p.stored(CK)), []);
    p.close();
  });

  test("no thread open (limit Infinity) settles to the end of the file at once", async () => {
    const t0 = Date.UTC(2026, 10, 17, 10, 30, 0);
    const file = path.join(root, "nolimit.jsonl");
    fs.writeFileSync(file, line({ type: "user", uuid: "w", timestamp: iso(t0 + 1000), message: { content: "a" } }));
    const p = new PendingSends({ file: ":memory:", publish: () => {}, now: () => t0 });
    p.sent(CK, "w", "x");
    p.apply(CK, { kind: "queued", id: "w" });
    await settleFromTranscript(p, CK, file, { limit: () => Infinity });
    assert.deepEqual(states(p.stored(CK)), []);
    p.close();
  });

  test("a page that fails to read is logged and not remembered as read: the next call reads it again", async () => {
    const t0 = Date.UTC(2026, 10, 17, 11, 0, 0);
    const file = path.join(root, "partial.jsonl");
    const rows = [line({ type: "user", uuid: "older-send", timestamp: iso(t0 + 500), message: { content: "x" } })];
    for (let i = 0; i < 4500; i++) rows.push(line({ type: "assistant", uuid: `a${i}`, timestamp: iso(t0 + 1000 + i * 1000), message: { content: [] } }));
    fs.writeFileSync(file, rows.join(""));
    const p = new PendingSends({ file: ":memory:", publish: () => {}, now: () => t0 });
    p.sent(CK, "older-send", "x");
    p.apply(CK, { kind: "taken", id: "older-send" });
    // The first page (the file's end) reads, the second fails.
    let reads = 0;
    const flaky: typeof readTail = async (f, o) => {
      if (++reads === 2) throw new Error("EIO");
      return readTail(f, o);
    };
    const logged: unknown[][] = [];
    const log = mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    try {
      await settleFromTranscript(p, CK, file, { readPage: flaky });
    } finally {
      log.mock.restore();
    }
    assert.equal(reads, 2);
    assert.equal(logged.length, 1, "one log line for the failed read");
    assert.deepEqual(states(p.stored(CK)), ["older-send:taken"]);
    // Had the memo said "read to the end", this call (same file size) would return without reading.
    await settleFromTranscript(p, CK, file);
    assert.deepEqual(states(p.stored(CK)), []);
    p.close();
  });

  test("a missing transcript settles nothing", async () => {
    const p = store([["a", "taken"]]);
    await settleFromTranscript(p, CK, path.join(root, "nope.jsonl"));
    await settleFromTranscript(p, CK, null);
    assert.deepEqual(states(p.stored(CK)), ["a:taken"]);
    p.close();
  });
});

describe("every way a row leaves the list tells the UIs (the /goal bubble stayed up on a stale client)", () => {
  // One check per removal path: the list shrinks, and the shorter list is published (the UIs only
  // learn of a change from `session.queued`), with the same content as list().
  type Published = Array<{ key: string; sends: PendingSend[] }>;
  const setup = (key: string, state: "queued" | "taken") => {
    const published: Published = [];
    const store = new PendingSends({ file: ":memory:", publish: (k, sends) => published.push({ key: k, sends }), now: () => 1 });
    store.sent(key, "gone", "x");
    store.apply(key, { kind: "queued", id: "gone" });
    if (state === "taken") store.apply(key, { kind: "taken", id: "gone" });
    store.sent(key, "stays", "y");
    return { store, published };
  };
  const told = (store: PendingSends, published: Published, key: string, before: number) => {
    assert.equal(published.length, before + 1, "one publish for the removal");
    assert.deepEqual(published.at(-1)!.sends.map((x) => x.id), ["stays"]);
    assert.deepEqual(published.at(-1)!.sends, store.list(key));
    store.close();
  };

  for (const [name, run, state] of [
    ["done", (st: PendingSends) => st.apply(CK, { kind: "done", id: "gone" }), "taken"],
    ["cancelled", (st: PendingSends) => st.apply(CK, { kind: "cancelled", id: "gone" }), "queued"],
    ["settleDelivered", (st: PendingSends) => settleDelivered(st, CK, new Set(["gone"])), "taken"],
    ["recall", (st: PendingSends) => st.recall(CK, ["gone"], async () => true), "queued"],
    ["settleEndedRun", (st: PendingSends) => settleEndedRun(st, CK, reader([])), "taken"],
  ] as const) {
    test(name, async () => {
      const { store, published } = setup(CK, state);
      const before = published.length;
      await run(store);
      told(store, published, CK, before);
    });
  }

  test("reconcilePending (transcript has it, run idle): the last list published is the kept one", async () => {
    const { store, published } = setup(CK, "taken");
    await reconcilePending(store, { claudeRun: () => ({ busy: false }), claudeTranscript: reader(["gone"]) }, ["claude"]);
    // "stays" never reached the CLI, so reconcile fails it as well: a second change after the removal.
    assert.equal(published.some((p) => p.sends.every((x) => x.id !== "gone")), true);
    assert.deepEqual(published.at(-1)!.sends, store.list(CK));
    assert.deepEqual(store.list(CK).map((x) => [x.id, x.state]), [["stays", "failed"]]);
    store.close();
  });

  test("turnEnded drops what the Codex daemon took", () => {
    const { store, published } = setup(XK, "taken");
    const before = published.length;
    store.apply(XK, { kind: "turnEnded" });
    told(store, published, XK, before);
  });

  test("settleFromTranscript (a line the thread has already sent)", async () => {
    const file = path.join(root, "told.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ type: "user", uuid: "gone", timestamp: new Date(1).toISOString(), message: { content: "x" } })}\n`);
    const { store, published } = setup(CK, "taken");
    const before = published.length;
    await settleFromTranscript(store, CK, file);
    told(store, published, CK, before);
  });
});
