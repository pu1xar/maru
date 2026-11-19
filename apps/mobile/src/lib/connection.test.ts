// The connection's socket lifecycle with a fake WebSocket and a fake fetch: one socket at a time
// through drops, background and foreground, and a retry that resumes late (the review's race).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Connection } from "./connection.ts";

class FakeWS {
  static OPEN = 1;
  static all: FakeWS[] = [];
  readyState = 0;
  closed = false;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    FakeWS.all.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.());
  }
  /** The server accepted the upgrade. */
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** The network dropped the socket. */
  lose() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
}

/** Each fetch waits until the test settles it, as React Native's fetch can wait without a timeout. */
let pending: Array<(status: number) => void> = [];
function fakeFetch(): Promise<Response> {
  return new Promise((resolve) => {
    pending.push((status) => resolve(new Response(status === 200 ? "{}" : JSON.stringify({ error: "no" }), { status })));
  });
}

const g = globalThis as unknown as Record<string, unknown>;
g.WebSocket = FakeWS;
g.fetch = fakeFetch;
const pairing = { server: "https://maru.example", token: "maru_d_x", device: { id: "d", name: "p", createdAt: 0, lastUsedAt: null } };
const live = () => FakeWS.all.filter((s) => !s.closed);
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  FakeWS.all = [];
  pending = [];
});

test("a retry that resumes after background and foreground opens no second socket", async () => {
  const c = new Connection(pairing);
  c.start();
  FakeWS.all[0]!.accept();
  FakeWS.all[0]!.lose(); // the retry now waits on /api/device/me
  assert.equal(pending.length, 1);
  c.suspend(); // to the background
  c.resume(); // back: a fresh socket
  FakeWS.all[1]!.accept();
  assert.equal(c.state, "open");
  pending.shift()!(200); // the old check finally answers
  await new Promise((r) => setTimeout(r, 1100)); // past the first retry pause
  assert.equal(FakeWS.all.length, 2, "no socket opened by the old retry");
  assert.equal(live().length, 1);
  c.suspend();
  await tick();
  assert.equal(live().length, 0, "the background leaves no socket open");
});

test("open closes the socket before it; a stale socket's events do nothing", async () => {
  const c = new Connection(pairing);
  const got: string[] = [];
  c.onMessage((m) => got.push(m.type));
  c.start();
  const first = FakeWS.all[0]!;
  c.resume(); // still connecting: reopen
  assert.equal(first.closed, true);
  assert.equal(live().length, 1);
  first.onmessage?.({ data: JSON.stringify({ type: "hello", sessions: [], projects: [] }) });
  FakeWS.all[1]!.accept();
  FakeWS.all[1]!.onmessage?.({ data: JSON.stringify({ type: "projects", projects: [] }) });
  assert.deepEqual(got, ["projects"]);
  assert.equal(c.send({ type: "thread.unsubscribe", threadId: "t" }), true);
  assert.equal(FakeWS.all[1]!.sent.length, 1);
});

test("a 401 on the check revokes; a 401 from an older generation does not", async () => {
  const c = new Connection(pairing);
  c.start();
  FakeWS.all[0]!.lose();
  c.suspend();
  c.resume();
  pending.shift()!(401); // answers the dropped generation's check
  await tick();
  assert.notEqual(c.state, "revoked");
  FakeWS.all[1]!.lose();
  pending.shift()!(401);
  await tick();
  assert.equal(c.state, "revoked");
  c.resume();
  assert.equal(FakeWS.all.length, 2, "a revoked connection stays closed");
});
