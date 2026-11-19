// The Claude session host process (DESIGN.md 2b), pm2 app `(sock)maru-host`:
//   node apps/server/src/host/main.ts
// It owns the Claude CLI processes the web UI starts, so restarting the web server leaves turns,
// questions and background tasks running. Restart the host itself with scripts/host-drain.ts,
// which waits for running work and lets the host exit 0; SIGINT or SIGTERM (pm2 restart or stop)
// close every run at once.
//
// An exception in a handler is logged and the host keeps serving: going down would end every
// Claude run it holds.
import { execFile } from "node:child_process";
import fs from "node:fs";
import type net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_SOCKET } from "./dataPaths.ts";
import { createSessionHost } from "./core.ts";
import { listenSocket, serveStream } from "./socket.ts";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const sockets = new Set<net.Socket>();
let server: net.Server | null = null;
/** inode of the socket file this process created; another host's file is never removed. */
let socketIno: number | null = null;
let exiting = false;

function exit(code: number): void {
  if (exiting) return;
  exiting = true;
  for (const s of sockets) s.destroy();
  server?.close();
  try {
    if (socketIno !== null && fs.statSync(HOST_SOCKET).ino === socketIno) fs.unlinkSync(HOST_SOCKET);
  } catch {
    // already gone
  }
  process.exit(code);
}

// Where this code runs from: release.sh compares the fingerprint of a new release with this one.
// Every path is found from this file, so the host runs the same from any release folder.
const entry = fs.realpathSync(fileURLToPath(import.meta.url));
const root = path.resolve(path.dirname(entry), "..", "..", "..", "..");
let fingerprint: string | null = null;
execFile(
  process.execPath,
  ["--experimental-vm-modules", "--no-warnings", path.join(path.dirname(entry), "fingerprintCli.ts"), root],
  (err, stdout, stderr) => {
    const value = String(stdout).trim().split("\n")[0] ?? "";
    // Exit 2 prints a value whose graph had imports it could not follow (fingerprintCli.ts).
    fingerprint = value.startsWith("v") ? value : `error: ${String(stderr).trim() || (err ? err.message : "no output")}`;
    if (err && value.startsWith("v")) fingerprint = `${value} (incomplete: ${String(stderr).trim()})`;
    log(`fingerprint ${fingerprint} root ${root}`);
  },
);

const host = createSessionHost({
  log,
  identity: () => ({ entry, root, fingerprint }),
  onDrained: () => {
    log("drained, exiting with 0 (pm2 stop_exit_codes keeps it stopped until it is started)");
    exit(0);
  },
});

try {
  server = await listenSocket(HOST_SOCKET, (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    serveStream(host, s, log);
  });
  socketIno = fs.statSync(HOST_SOCKET).ino;
} catch (err) {
  log(`cannot listen on ${HOST_SOCKET}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
log(`session host pid ${process.pid} listening on ${HOST_SOCKET}`);

let stopping = false;
function onSignal(sig: string): void {
  if (stopping) return;
  stopping = true;
  host.stopAll(sig).then(
    () => exit(0),
    () => exit(1),
  );
}
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("uncaughtException", (err) => log(`uncaught exception: ${err.stack ?? err.message}`));
process.on("unhandledRejection", (err) => log(`unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
