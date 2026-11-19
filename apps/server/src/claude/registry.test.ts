import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  isPidAlive, isRegistrationLive, mapStatus, parseRegistration, processStartOf, resolveHold, tmuxPaneOf,
} from "./registry.ts";
import type { Registration } from "./registry.ts";

test("tmuxPaneOf takes the %N pane id", () => {
  assert.equal(tmuxPaneOf("per:@4.%4"), "%4");
  assert.equal(tmuxPaneOf("my.sess:name:@12.%123"), "%123");
  assert.equal(tmuxPaneOf(null), null);
  assert.equal(tmuxPaneOf(undefined), null);
  assert.equal(tmuxPaneOf(""), null);
  assert.equal(tmuxPaneOf("per:@4"), null);
});

test("mapStatus", () => {
  assert.deepEqual(mapStatus("busy"), { status: "running", known: true });
  assert.deepEqual(mapStatus("shell"), { status: "running", known: true });
  assert.deepEqual(mapStatus("waiting"), { status: "waiting-input", known: true });
  assert.deepEqual(mapStatus("idle"), { status: "open-idle", known: true });
  assert.deepEqual(mapStatus(null), { status: "open-idle", known: true });
  assert.deepEqual(mapStatus("compacting"), { status: "open-idle", known: false });
});

test("isPidAlive: own pid, an exited child, and EPERM", async () => {
  assert.equal(isPidAlive(process.pid), true);
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  assert.ok(child.pid);
  assert.equal(isPidAlive(child.pid), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  if (process.getuid?.() !== 0) {
    // pid 1 (launchd/init) belongs to root: signal 0 fails with EPERM, yet it is alive.
    assert.equal(isPidAlive(1), true);
  }
});

test("parseRegistration", () => {
  const r = parseRegistration(
    JSON.stringify({
      pid: 51877, sessionId: "s1", status: "waiting", entrypoint: "cli", tmux: "per:@4.%4", statusUpdatedAt: 5,
      procStart: "Sun Nov 15 10:02:08 2026",
    }),
    1,
  );
  assert.deepEqual(r, {
    pid: 51877,
    sessionId: "s1",
    status: "waiting",
    entrypoint: "cli",
    tmux: "per:@4.%4",
    cwd: null,
    updatedAt: 5,
    procStart: "Sun Nov 15 10:02:08 2026",
  });
  assert.equal(parseRegistration("{broken", 1), null);
  assert.equal(parseRegistration("[1]", 1), null);
  assert.equal(parseRegistration(JSON.stringify({ sessionId: "s" }), 42)?.pid, 42);
});

const reg = (pid: number, status: string | null, extra: Partial<Registration> = {}): Registration => ({
  pid,
  sessionId: "s",
  status,
  entrypoint: "cli",
  tmux: null,
  cwd: null,
  updatedAt: null,
  procStart: null,
  ...extra,
});

test("resolveHold: closed, priorities, owner and representative", () => {
  assert.deepEqual(resolveHold([], new Set()), { status: "closed", owner: "none", pid: null, tmuxPane: null });
  assert.deepEqual(resolveHold([reg(10, null, { tmux: "a:@1.%3" })], new Set()), {
    status: "open-idle",
    owner: "terminal",
    pid: 10,
    tmuxPane: "%3",
  });
  // waiting beats idle; the waiting holder is the representative
  assert.deepEqual(
    resolveHold([reg(10, "idle", { tmux: "a:@1.%3" }), reg(11, "waiting", { tmux: "a:@1.%4" })], new Set()),
    { status: "waiting-input", owner: "terminal", pid: 11, tmuxPane: "%4" },
  );
  // running beats waiting
  assert.equal(resolveHold([reg(10, "waiting"), reg(11, "busy"), reg(12, "idle")], new Set()).status, "running");
  // a UI holder makes the owner ui and is the representative, while status is the most active
  assert.deepEqual(resolveHold([reg(10, "busy", { tmux: "a:@1.%3" }), reg(20, "idle")], new Set([20])), {
    status: "running",
    owner: "ui",
    pid: 20,
    tmuxPane: null,
  });
  // equal status: the most recently updated holder represents
  assert.equal(resolveHold([reg(10, "idle", { updatedAt: 1 }), reg(11, "idle", { updatedAt: 9 })], new Set()).pid, 11);
});

test("processStartOf reports the real start time in UTC, the zone Claude Code records", () => {
  const out = processStartOf(process.pid);
  assert.ok(out);
  const reported = Date.parse(`${out} UTC`);
  const actual = Date.now() - process.uptime() * 1000;
  // A local-time answer would be off by the zone offset (hours), not seconds.
  assert.ok(Math.abs(reported - actual) < 5000, `ps said ${out}`);
});

test("isRegistrationLive: a reused pid with another start time is not live", () => {
  const base = parseRegistration(JSON.stringify({ pid: process.pid, sessionId: "s" }), process.pid)!;
  const own = processStartOf(process.pid);
  assert.ok(own, "ps reports this process start time");
  // Same pid, matching start time (spacing differs as ps pads single-digit days).
  assert.equal(isRegistrationLive({ ...base, procStart: own!.replace(/ /g, "  ") }), true);
  // Same pid, but the file was written by an earlier process that held this pid.
  assert.equal(isRegistrationLive({ ...base, procStart: "Mon Jan  1 00:00:00 2001" }), false);
  // No recorded start time, or ps cannot tell: the pid check decides.
  assert.equal(isRegistrationLive({ ...base, procStart: null }), true);
  assert.equal(isRegistrationLive({ ...base, procStart: "x" }, () => null), true);
  // Dead pid.
  assert.equal(isRegistrationLive({ ...base, pid: 2 ** 22 + 12345, procStart: null }), false);
});
