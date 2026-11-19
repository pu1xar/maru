import { test } from "node:test";
import assert from "node:assert/strict";
import type { ShellInfo } from "@maru/shared";
import { ShellConnection, shellSocketUrl, type ShellConnectionState, type ShellSocketLike } from "./shellConnection.ts";

class FakeSocket implements ShellSocketLike {
  readyState = 0;
  binaryType = "blob";
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: (string | Uint8Array)[] = [];
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  frame(f: object) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const shell: ShellInfo = { id: "sh-aaaaaaaaaaaa", cwd: "/", createdAt: 0, command: "zsh", path: "/", clients: 1 };

function rig() {
  const sockets: FakeSocket[] = [];
  const timers: (() => void)[] = [];
  const log: string[] = [];
  const states: ShellConnectionState[] = [];
  const delays: number[] = [];
  let clock = 0;
  let grid = { cols: 80, rows: 24 };
  const conn = new ShellConnection({
    id: shell.id,
    origin: { protocol: "https:", host: "maru.example" },
    grid: () => grid,
    open: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onAttached: () => log.push("attached"),
    onOutput: (d) => log.push(`out:${new TextDecoder().decode(d)}`),
    onEnded: (f) => log.push(`ended:${f.reason}`),
    onState: (s) => states.push(s),
    setTimer: (fn, ms) => {
      delays.push(ms);
      timers.push(fn);
    },
    clearTimer: () => {},
    now: () => clock,
  });
  return { conn, sockets, timers, delays, log, states, setGrid: (g: typeof grid) => (grid = g), tick: (ms: number) => (clock += ms) };
}

test("the url carries the id and the grid; wss on an https page", () => {
  assert.equal(shellSocketUrl("sh-a", 80, 24, { protocol: "https:", host: "maru.example" }), "wss://maru.example/shell?id=sh-a&cols=80&rows=24");
  assert.equal(shellSocketUrl("sh-a", 1, 2, { protocol: "http:", host: "127.0.0.1:8024" }), "ws://127.0.0.1:8024/shell?id=sh-a&cols=1&rows=2");
});

test("a dropped socket reattaches with the grid of the moment; input waits for `attached`", () => {
  const r = rig();
  const s1 = r.sockets[0]!;
  s1.open();
  r.conn.input("early");
  assert.equal(s1.sent.length, 0, "nothing goes before the shell is attached");
  s1.frame({ type: "attached", shell });
  s1.onmessage?.({ data: new TextEncoder().encode("hi").buffer });
  r.conn.input("ls\r");
  assert.deepEqual(new TextDecoder().decode(s1.sent[0] as Uint8Array), "ls\r");
  r.conn.resize(100, 30);
  assert.equal(s1.sent[1], JSON.stringify({ type: "resize", cols: 100, rows: 30 }));

  r.setGrid({ cols: 120, rows: 40 });
  s1.drop();
  assert.equal(r.conn.getState(), "reconnecting");
  r.conn.input("lost");
  assert.equal(r.timers.length, 1);
  r.timers[0]!();
  const s2 = r.sockets[1]!;
  assert.match(s2.url, /cols=120&rows=40$/);
  s2.open();
  s2.frame({ type: "attached", shell });
  assert.deepEqual(r.log, ["attached", "out:hi", "attached"]);
  assert.deepEqual(r.states, ["live", "reconnecting", "live"]);
});

test("`ended` stops it for good; dispose stops a pending reconnect", () => {
  const r = rig();
  r.sockets[0]!.open();
  r.sockets[0]!.frame({ type: "ended", reason: "exited" });
  r.sockets[0]!.drop();
  assert.equal(r.timers.length, 0);
  assert.deepEqual(r.log, ["ended:exited"]);

  const q = rig();
  q.sockets[0]!.drop();
  q.conn.dispose();
  q.timers[0]!();
  assert.equal(q.sockets.length, 1, "no socket after dispose");
});

test("a socket that drops soon after attaching keeps the backoff growing; a stable one starts it over", () => {
  const r = rig();
  for (let i = 0; i < 3; i++) {
    const s = r.sockets.at(-1)!;
    s.open();
    s.frame({ type: "attached", shell });
    r.tick(100);
    s.drop();
    r.timers.at(-1)!();
  }
  assert.deepEqual(r.delays, [500, 1000, 2000]);
  const s = r.sockets.at(-1)!;
  s.open();
  s.frame({ type: "attached", shell });
  r.tick(6000);
  s.drop();
  assert.equal(r.delays.at(-1), 500);
});
