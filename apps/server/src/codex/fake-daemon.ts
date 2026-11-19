// In-process stand-in for a codex app-server daemon, for the tests in this folder.
//
// It is reached the way the real daemon is: `<home>/app-server-control/app-server-control.sock`
// is a symlink to a Unix socket elsewhere, and the socket serves WebSocket with one JSON-RPC
// message per text frame. Its thread/list leaves out threads with a parentThreadId, as the
// real daemon does. thread/name/set renames a thread it holds in `threads` and broadcasts
// thread/name/updated; a thread outside `threads` is not found (an archived one, for the real
// daemon). macOS limits Unix socket paths to 103 bytes, so the temp home sits under a short
// directory.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { Thread } from "./protocol/v2/Thread.ts";
import { controlSocketPath } from "./rpc.ts";

export interface Received {
  /** Connection number, from 1 in the order clients connected. */
  conn: number;
  /** null for a reply to a server request. */
  method: string | null;
  id: unknown;
  params: Record<string, unknown>;
  msg: Record<string, unknown>;
}

/** Thrown by a handler to answer with a JSON-RPC error. */
export class DaemonError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export type DaemonHandler = (params: Record<string, unknown>, conn: number) => unknown;

const SOCKET_PATH_MAX = 103;

function shortTmpBase(): string {
  const base = os.tmpdir();
  const probe = controlSocketPath(path.join(base, "cxhXXXXXX"));
  return probe.length <= SOCKET_PATH_MAX ? base : "/tmp";
}

export class FakeDaemon {
  readonly home: string;
  /** The path clients connect to: the symlink in the home. */
  readonly socketPath: string;
  private readonly realSocket: string;
  private readonly tmpDirs: string[];

  /** What thread/list and thread/read answer from. */
  threads = new Map<string, Thread>();
  /** Largest page thread/list returns. */
  pageSize = 100;
  /** Every message received, in order. */
  readonly received: Received[] = [];
  /** Per-method replacement of the built-in answers. */
  readonly handlers = new Map<string, DaemonHandler>();

  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly conns = new Map<number, WebSocket>();
  private connCount = 0;
  private serverRequestId = 0;
  private readonly waiting = new Map<string, (msg: Record<string, unknown>) => void>();

  private constructor(home: string, realSocket: string, tmpDirs: string[]) {
    this.home = home;
    this.socketPath = controlSocketPath(home);
    this.realSocket = realSocket;
    this.tmpDirs = tmpDirs;
  }

  /** A daemon for a fresh temp home. It does not listen until listen(). */
  static create(): FakeDaemon {
    const base = shortTmpBase();
    const home = fs.mkdtempSync(path.join(base, "cxh"));
    const sockDir = fs.mkdtempSync(path.join(base, "cxs"));
    return new FakeDaemon(home, path.join(sockDir, "d.sock"), [home, sockDir]);
  }

  get connections(): number {
    return this.connCount;
  }

  async listen(): Promise<void> {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws) => this.onConnection(ws));
    fs.rmSync(this.realSocket, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.realSocket, () => resolve());
    });
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    fs.rmSync(this.socketPath, { force: true });
    fs.symlinkSync(this.realSocket, this.socketPath);
    this.server = server;
    this.wss = wss;
  }

  /** Close every client connection but keep listening (a daemon that dropped its clients). */
  dropConnections(): void {
    for (const ws of this.conns.values()) ws.terminate();
  }

  /** Stop listening and remove the socket and the symlink (a daemon that went away). */
  async stopListening(): Promise<void> {
    this.dropConnections();
    const wss = this.wss;
    const server = this.server;
    this.wss = null;
    this.server = null;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(this.socketPath, { force: true });
    fs.rmSync(this.realSocket, { force: true });
  }

  async cleanup(): Promise<void> {
    await this.stopListening();
    for (const d of this.tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  }

  /** Broadcast a notification to every connection. */
  notify(method: string, params: unknown): void {
    for (const ws of this.conns.values()) ws.send(JSON.stringify({ method, params }));
  }

  /** Send a server request on the newest connection and resolve with the client's reply. */
  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const ws = this.newest();
    const id = `srv-${++this.serverRequestId}`;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Send a server request on connection `conn` (default: the newest). `reply` resolves with the
   * client's answer; it stays pending while the client sends none.
   */
  serverRequest(method: string, params: unknown, conn?: number): { id: string; reply: Promise<Record<string, unknown>> } {
    const ws = conn === undefined ? this.newest() : this.conns.get(conn);
    if (!ws) throw new Error(`no connection ${conn}`);
    const id = `srv-${++this.serverRequestId}`;
    const reply = new Promise<Record<string, unknown>>((resolve) => this.waiting.set(id, resolve));
    ws.send(JSON.stringify({ id, method, params }));
    return { id, reply };
  }

  /** Replies a client sent to server request `id` (none while it has not answered). */
  repliesTo(id: string): Received[] {
    return this.received.filter((r) => r.method === null && r.id === id);
  }

  /** Ping the newest connection; resolves on its pong. */
  ping(): Promise<void> {
    const ws = this.newest();
    return new Promise((resolve) => {
      ws.once("pong", () => resolve());
      ws.ping();
    });
  }

  /** Requests received for one method, in order. */
  calls(method: string): Received[] {
    return this.received.filter((r) => r.method === method && r.id !== null);
  }

  /** Methods received on one connection, in order (null for replies). */
  methodsOf(conn: number): (string | null)[] {
    return this.received.filter((r) => r.conn === conn).map((r) => r.method);
  }

  private newest(): WebSocket {
    const last = [...this.conns.values()].at(-1);
    if (!last) throw new Error("no client connected");
    return last;
  }

  private onConnection(ws: WebSocket): void {
    const conn = ++this.connCount;
    this.conns.set(conn, ws);
    ws.on("close", () => this.conns.delete(conn));
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      void this.onMessage(conn, ws, msg);
    });
  }

  private async onMessage(conn: number, ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const method = typeof msg.method === "string" ? msg.method : null;
    const id = msg.id ?? null;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    this.received.push({ conn, method, id, params, msg });
    if (method === null) {
      const done = this.waiting.get(String(id));
      this.waiting.delete(String(id));
      done?.(msg);
      return;
    }
    if (id === null) return;
    let reply: Record<string, unknown>;
    try {
      reply = { id, result: await this.answer(method, params, conn) };
    } catch (err) {
      const code = err instanceof DaemonError ? err.code : -32603;
      reply = { id, error: { code, message: err instanceof Error ? err.message : String(err) } };
    }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply));
  }

  private answer(method: string, params: Record<string, unknown>, conn: number): unknown {
    const custom = this.handlers.get(method);
    if (custom) return custom(params, conn);
    switch (method) {
      case "initialize":
        return { userAgent: "fake-daemon/0", codexHome: this.home, platformFamily: "unix", platformOs: "macos" };
      case "thread/list": {
        const listed = [...this.threads.values()]
          .filter((t) => t.parentThreadId === null)
          .sort((a, b) => b.createdAt - a.createdAt);
        const start = typeof params.cursor === "string" ? Number(params.cursor) : 0;
        const size = Math.min(typeof params.limit === "number" ? params.limit : this.pageSize, this.pageSize);
        const data = listed.slice(start, start + size);
        const end = start + data.length;
        return { data, nextCursor: end < listed.length ? String(end) : null, backwardsCursor: null };
      }
      case "thread/read": {
        const t = this.threads.get(String(params.threadId));
        if (!t) throw new DaemonError(-32600, `thread not loaded: ${String(params.threadId)}`);
        return { thread: t };
      }
      case "thread/loaded/list":
        return {
          data: [...this.threads.values()].filter((t) => t.status.type !== "notLoaded").map((t) => t.id),
          nextCursor: null,
        };
      case "thread/name/set": {
        const id = String(params.threadId);
        const t = this.threads.get(id);
        if (!t) throw new DaemonError(-32600, `no rollout found for thread id ${id}`);
        t.name = String(params.name);
        this.notify("thread/name/updated", { threadId: id, threadName: t.name });
        return {};
      }
      default:
        throw new DaemonError(-32601, `unknown method ${method}`);
    }
  }
}

/** A complete Thread record with test defaults (times in seconds, as the daemon sends them). */
export function makeThread(id: string, over: Partial<Thread> = {}): Thread {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: `preview ${id}`,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "openai",
    model: null,
    reasoningEffort: null,
    createdAt: 1_794_000_000,
    updatedAt: 1_794_000_100,
    recencyAt: null,
    status: { type: "notLoaded" },
    path: null,
    cwd: `/work/${id}`,
    cliVersion: "0.169.0",
    originator: "codex-tui",
    source: "cli",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...over,
  };
}

/** Poll until pred() holds. */
export async function waitFor(pred: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
