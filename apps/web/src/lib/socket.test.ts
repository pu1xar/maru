import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerMessage } from "@maru/shared";
import { SocketHub, type SocketLike } from "./socket.ts";

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: unknown[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  receive(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: Array<() => void> = [];
  const hub = new SocketHub({
    open: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    backoffMs: () => 0,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
  });
  const runTimers = () => {
    for (const fn of timers.splice(0)) fn();
  };
  return { hub, sockets, runTimers };
}

test("retainThread shares one server subscription and unsubscribes on the last release", () => {
  const { hub, sockets } = harness();
  const releaseA = hub.retainThread("t1", { rows: 30 });
  const releaseB = hub.retainThread("t1", { pageSize: 5 });
  sockets[0]!.open();
  // The first holder's options make the one subscription.
  assert.deepEqual(sockets[0]!.sent, [{ type: "thread.subscribe", threadId: "t1", rows: 30 }]);
  releaseA();
  releaseA(); // a second call of the same release is a no-op
  assert.equal(sockets[0]!.sent.length, 1);
  releaseB();
  assert.deepEqual(sockets[0]!.sent.at(-1), { type: "thread.unsubscribe", threadId: "t1" });
  assert.deepEqual(hub.retainedThreads(), []);
});

test("a reconnect subscribes every held thread again", () => {
  const { hub, sockets, runTimers } = harness();
  const seen: string[] = [];
  hub.onMessage((m) => seen.push(m.type));
  hub.retainThread("t1");
  hub.retainThread("t2");
  sockets[0]!.open();
  assert.equal(hub.getConnection(), "open");
  sockets[0]!.drop();
  assert.equal(hub.getConnection(), "closed");
  runTimers();
  assert.equal(sockets.length, 2);
  assert.equal(hub.getConnection(), "connecting");
  sockets[1]!.open();
  assert.deepEqual(sockets[1]!.sent, [
    { type: "thread.subscribe", threadId: "t1" },
    { type: "thread.subscribe", threadId: "t2" },
  ]);
  sockets[1]!.receive({ type: "projects", projects: [] });
  assert.deepEqual(seen, ["projects"]);
});

test("send reports false while the socket is not open", () => {
  const { hub, sockets } = harness();
  hub.retainThread("t1");
  assert.equal(hub.send({ type: "thread.loadOlder", threadId: "t1" }), false);
  sockets[0]!.open();
  assert.equal(hub.send({ type: "thread.loadOlder", threadId: "t1" }), true);
});

test("messages from a replaced socket are ignored", () => {
  const { hub, sockets, runTimers } = harness();
  const seen: string[] = [];
  hub.onMessage((m) => seen.push(m.type));
  sockets[0]!.open();
  const stale = sockets[0]!;
  stale.drop();
  runTimers();
  stale.receive({ type: "projects", projects: [] });
  assert.deepEqual(seen, []);
});

test("a subscription given as a function is asked each time the subscribe goes out, and only while the socket is open", () => {
  const { hub, sockets, runTimers } = harness();
  let asked = 0;
  hub.retainThread("t1", () => {
    asked++;
    return { rows: 30, have: { first: "a", last: "a", digests: ["x"], rows: 1 } };
  });
  assert.equal(asked, 0, "not asked while the socket is connecting");
  sockets[0]!.open();
  assert.equal(asked, 1);
  assert.deepEqual(sockets[0]!.sent, [{ type: "thread.subscribe", threadId: "t1", rows: 30, have: { first: "a", last: "a", digests: ["x"], rows: 1 } }]);
  sockets[0]!.drop();
  runTimers();
  sockets[1]!.open();
  assert.equal(asked, 2, "a reconnect asks again");
  assert.equal((sockets[1]!.sent[0] as { have?: unknown }).have !== undefined, true);
});

test("resubscribe sends the unsubscribe and then a subscribe with the given options, for a held thread only", () => {
  const { hub, sockets } = harness();
  assert.equal(hub.resubscribe("t1", { rows: 30 }), false, "not held");
  hub.retainThread("t1", () => ({ rows: 30, have: { first: "a", last: "a", digests: ["x"], rows: 1 } }));
  assert.equal(hub.resubscribe("t1", { rows: 30 }), false, "socket not open");
  sockets[0]!.open();
  sockets[0]!.sent.length = 0;
  assert.equal(hub.resubscribe("t1", { rows: 30 }), true);
  assert.deepEqual(sockets[0]!.sent, [
    { type: "thread.unsubscribe", threadId: "t1" },
    { type: "thread.subscribe", threadId: "t1", rows: 30 },
  ]);
});
