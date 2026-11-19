import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { socketHostLink } from "../claude/hostLink.ts";
import { createSessionHost } from "./core.ts";
import { listenSocket, serveStream } from "./socket.ts";

// A unix socket path must stay under 104 bytes; the system temp dir keeps it short.
let dir: string;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cch-"));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function serve(sock: string) {
  const host = createSessionHost({ childPids: async () => [] });
  const conns = new Set<net.Socket>();
  const server = await listenSocket(sock, (s) => {
    conns.add(s);
    serveStream(host, s);
  });
  return {
    server,
    async stop() {
      for (const c of conns) c.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

test("listen: user-only socket; a dead socket file is replaced; a live one and a non-socket are refused", async () => {
  const sock = path.join(dir, "a.sock");
  // A socket file nobody listens on, as a killed host leaves it.
  const dead = net.createServer();
  await new Promise<void>((r) => dead.listen(sock, () => r()));
  const staleIno = fs.statSync(sock).ino;
  // Node removes its socket file on close; moved aside meanwhile, the file outlives the listener.
  fs.renameSync(sock, `${sock}.keep`);
  await new Promise<void>((r) => dead.close(() => r()));
  fs.renameSync(`${sock}.keep`, sock);
  assert.equal(fs.statSync(sock).ino, staleIno);
  assert.ok(fs.lstatSync(sock).isSocket());

  const live = await serve(sock);
  assert.notEqual(fs.statSync(sock).ino, staleIno, "the stale file was replaced");
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
  await assert.rejects(listenSocket(sock, () => {}), /another session host listens/);
  await live.stop();

  const plain = path.join(dir, "plain");
  fs.writeFileSync(plain, "x");
  await assert.rejects(listenSocket(plain, () => {}), /not a socket/);
  assert.equal(fs.readFileSync(plain, "utf8"), "x", "left alone");
});

test("the web server's link reports down, connects when the host comes, and reconnects after it restarts", async () => {
  const sock = path.join(dir, "b.sock");
  const link = socketHostLink(sock, { retryMs: 20 });
  try {
    await link.ready();
    assert.equal(link.connected(), false);
    assert.match(link.error() ?? "", /ENOENT/);

    let host = await serve(sock);
    while (!link.connected()) await sleep(10);
    const pid1 = link.host()!.pid;
    assert.equal(pid1, process.pid);
    assert.deepEqual(await link.request({ op: "host.status" }).then((s) => (s as { runs: unknown[] }).runs), []);

    await host.stop();
    while (link.connected()) await sleep(10);
    await assert.rejects(link.request({ op: "host.status" }), /is down/);
    host = await serve(sock);
    while (!link.connected()) await sleep(10);
    await host.stop();
  } finally {
    link.close();
  }
});
