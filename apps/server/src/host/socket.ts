// Unix socket transport of the session host (DESIGN.md 2b). The socket lives in maru's
// data folder (config.ts HOST_SOCKET), so the host takes no TCP port.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { SessionHost } from "./core.ts";
import { encodeFrame, frameDecoder } from "./protocol.ts";

/** Serves one client stream (a socket, or one end of an in-process pair). */
export function serveStream(host: SessionHost, stream: Duplex, log?: (line: string) => void): void {
  const session = host.connect({
    send(frame) {
      if (stream.destroyed || !stream.writable) return;
      let line: string;
      try {
        line = encodeFrame(frame);
      } catch (err) {
        // A frame that cannot be JSON is dropped; the run goes on.
        log?.(`frame not sent: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      stream.write(line);
    },
  });
  stream.on("data", frameDecoder((f) => session.receive(f), (line) => log?.(`bad frame from a client: ${line.slice(0, 200)}`)));
  // close follows an error
  stream.on("error", () => stream.destroy());
  stream.on("close", () => session.close());
}

/** True when something accepts a connection on the socket path. */
export function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(socketPath);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

/**
 * Listens on `socketPath`, readable and writable by this user only (the socket starts Claude with
 * every permission bypassed). A socket file nobody answers on was left by a host that died and is
 * removed; a live one means another host runs, and anything that is not a socket is not ours: both
 * are refused.
 */
export async function listenSocket(socketPath: string, onConnection: (s: net.Socket) => void): Promise<net.Server> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (st) {
    if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
    if (await probeSocket(socketPath)) throw new Error(`another session host listens on ${socketPath}`);
    fs.unlinkSync(socketPath);
  }
  const server = net.createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  fs.chmodSync(socketPath, 0o600);
  return server;
}

/** Connects to the host's socket; rejects with the connect error (ENOENT, ECONNREFUSED, ...). */
export function connectSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(socketPath);
    s.once("connect", () => {
      s.off("error", reject);
      resolve(s);
    });
    s.once("error", reject);
  });
}
