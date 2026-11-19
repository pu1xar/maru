import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parentPidOf, scanChildRegistration, waitForChildRegistration } from "./driver-pid.ts";

let root: string;
let child: ChildProcess;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-driver-pid-"));
  child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
});

after(async () => {
  child.kill();
  await fs.rm(root, { recursive: true, force: true });
});

const write = (dir: string, pid: number, body: unknown) =>
  fs.writeFile(path.join(dir, `${pid}.json`), typeof body === "string" ? body : JSON.stringify(body));

test("parentPidOf", async () => {
  assert.equal(await parentPidOf(child.pid!), process.pid);
  assert.equal(await parentPidOf(process.pid), process.ppid);
  const gone = spawn(process.execPath, ["-e", ""]);
  await once(gone, "exit");
  assert.equal(await parentPidOf(gone.pid!), null);
});

test("scanChildRegistration picks the live child holding the session", async () => {
  const dir = path.join(root, "scan");
  assert.equal(await scanChildRegistration(dir, "s", process.pid), null, "missing dir");
  await fs.mkdir(dir);
  const dead = spawn(process.execPath, ["-e", ""]);
  await once(dead, "exit");
  // Not our child, a dead pid, another session, a broken file, a non-registration file.
  await write(dir, process.pid, { pid: process.pid, sessionId: "s" });
  await write(dir, dead.pid!, { pid: dead.pid, sessionId: "s" });
  await write(dir, 999999, "{broken");
  await fs.writeFile(path.join(dir, "abc.key"), "");
  assert.equal(await scanChildRegistration(dir, "s", process.pid), null);
  await write(dir, child.pid!, { pid: child.pid, sessionId: "other" });
  assert.equal(await scanChildRegistration(dir, "s", process.pid), null);
  await write(dir, child.pid!, { pid: child.pid, sessionId: "s", status: "idle" });
  assert.equal(await scanChildRegistration(dir, "s", process.pid), child.pid);
});

test("waitForChildRegistration finds a file written later and stops on abort", { timeout: 10_000 }, async () => {
  const dir = path.join(root, "wait");
  await fs.mkdir(dir);
  let sid: string | null = null;
  const ac = new AbortController();
  const found = waitForChildRegistration({ sessionsDir: dir, sessionId: () => sid, signal: ac.signal, intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 30));
  sid = "late";
  await write(dir, child.pid!, { pid: child.pid, sessionId: "late" });
  assert.equal(await found, child.pid);

  const stop = new AbortController();
  const never = waitForChildRegistration({ sessionsDir: dir, sessionId: () => "nobody", signal: stop.signal, intervalMs: 10 });
  stop.abort();
  assert.equal(await never, null);
});
