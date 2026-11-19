// JSON-RPC client for one codex app-server daemon (one CODEX_HOME).
//
// The daemon listens on `<home>/app-server-control/app-server-control.sock`, a Unix socket
// that speaks WebSocket: an HTTP upgrade, then one JSON-RPC message per text frame. Every
// connection starts with the `initialize` request followed by the `initialized` notification.
// After that the daemon broadcasts thread lifecycle notifications to every connection, and it
// may send requests of its own (approvals, user input). Those carry an id and the daemon waits
// for the answer. A request goes to every connection subscribed to its thread (thread/start,
// thread/resume), the first answer wins, and `serverRequest/resolved` tells every subscriber; a
// request still pending is sent again to a connection that resumes the thread later
// (measured 2026-11-15, codex-cli 0.169.0). A request without a handler is left unanswered by
// default (unhandledRequests).
//
// The client keeps a connection up. When a connection drops or cannot be made it retries with
// exponential backoff, and every new connection runs `initialize` again. Ping frames from the
// daemon are answered by `ws` itself (its autoPong option, on by default).

import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import type { RawData } from "ws";
import type { ClientInfo } from "./protocol/ClientInfo.ts";
import type { ClientRequest } from "./protocol/ClientRequest.ts";
import type { InitializeParams } from "./protocol/InitializeParams.ts";
import type { InitializeResponse } from "./protocol/InitializeResponse.ts";
import type { RequestId } from "./protocol/RequestId.ts";
import type { ServerNotification } from "./protocol/ServerNotification.ts";
import type { ServerRequest } from "./protocol/ServerRequest.ts";
import type { ThreadListResponse } from "./protocol/v2/ThreadListResponse.ts";
import type { ThreadLoadedListResponse } from "./protocol/v2/ThreadLoadedListResponse.ts";
import type { ThreadReadResponse } from "./protocol/v2/ThreadReadResponse.ts";
import type { ExperimentalRequests } from "./experimental.ts";

export type ClientMethod = ClientRequest["method"] | keyof ExperimentalRequests;
export type ParamsOf<M extends ClientMethod> = M extends keyof ExperimentalRequests
  ? ExperimentalRequests[M]["params"]
  : Extract<ClientRequest, { method: M }>["params"];

/** Result types of the methods this server calls. Other methods resolve to `unknown`. */
interface KnownResults {
  initialize: InitializeResponse;
  "thread/list": ThreadListResponse;
  "thread/read": ThreadReadResponse;
  "thread/loaded/list": ThreadLoadedListResponse;
}
export type ResultOf<M extends ClientMethod> = M extends keyof ExperimentalRequests
  ? ExperimentalRequests[M]["result"]
  : M extends keyof KnownResults
    ? KnownResults[M]
    : unknown;

export type NotificationMethod = ServerNotification["method"];
export type NotificationParams<M extends NotificationMethod> = Extract<ServerNotification, { method: M }>["params"];
export type ServerRequestMethod = ServerRequest["method"];
export type ServerRequestParams<M extends ServerRequestMethod> = Extract<ServerRequest, { method: M }>["params"];

/** JSON-RPC error codes this client sends back to the daemon. */
export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;

/**
 * A request handler returns (or resolves to) this to send no answer at all: the request belongs
 * to another client, or another client answered it first. Counted as serverRequestsIgnored.
 */
export const NO_ANSWER: unique symbol = Symbol("codex-rpc-no-answer");

/** What a request handler learns besides the params: the JSON-RPC id the daemon gave the request. */
export interface ServerRequestContext {
  /** The same value `serverRequest/resolved` reports as `requestId`. */
  id: RequestId;
}

export function controlSocketPath(home: string): string {
  return path.join(home, "app-server-control", "app-server-control.sock");
}

/** True when the control socket path resolves to a file (a dangling symlink counts as absent). */
export function controlSocketExists(socketPath: string): boolean {
  return fs.existsSync(socketPath);
}

/** An error response from the daemon. */
export class RpcError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data: unknown;
  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`${method}: ${message} (code ${code})`);
    this.name = "RpcError";
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

/** A request that never reached the daemon or whose answer never came back. */
export class RpcTransportError extends Error {
  readonly method: string;
  readonly kind: "not-connected" | "closed" | "timeout";
  constructor(method: string, kind: "not-connected" | "closed" | "timeout", detail?: string) {
    super(`${method}: ${kind}${detail ? ` (${detail})` : ""}`);
    this.name = "RpcTransportError";
    this.method = method;
    this.kind = kind;
  }
}

export interface CodexRpcOptions {
  /** Defaults to controlSocketPath(home). */
  socketPath?: string;
  /** Sent in `initialize`. Default {name: "maru", title: null, version: "0.0.0"}. */
  clientInfo?: ClientInfo;
  /**
   * Declare the `experimentalApi` capability in `initialize`: the daemon then answers experimental
   * requests (experimental.ts) and adds experimental fields to its answers and notifications for
   * this connection. Default false (`capabilities: null`).
   */
  experimentalApi?: boolean;
  /**
   * Upper bound for the WebSocket upgrade and the `initialize` answer, ms. Without it a daemon
   * that accepts the socket and never answers would hold the connect loop forever. Default 30000.
   */
  connectTimeoutMs?: number;
  /** Retry delay: starts at initialMs, doubles per failed attempt, capped at maxMs. Default 500 and 30000. */
  backoff?: { initialMs?: number; maxMs?: number };
  /**
   * A server request (approval, question) with no handler registered.
   * ignore (default): send nothing. Several clients share the daemon, and the TUI or another
   *   client that drives the thread must be the one to answer; an error from a watcher would
   *   win the race and refuse the request for everyone.
   * reject: answer METHOD_NOT_FOUND at once (a connection that is the only client).
   */
  unhandledRequests?: "ignore" | "reject";
}

export interface RequestOptions {
  /** Reject with RpcTransportError("timeout") after this many ms. Default: wait for the answer or the connection to close. */
  timeoutMs?: number;
}

export interface CodexRpcStats {
  socketPath: string;
  connected: boolean;
  /** Connections that completed `initialize`. */
  connects: number;
  /** Attempts that failed before `initialize` completed (no socket, refused, upgrade or initialize error). */
  failedAttempts: number;
  /** Connections the owner gave up on with fail(). */
  failedConnections: number;
  disconnects: number;
  requests: number;
  errorResponses: number;
  timeouts: number;
  /** Requests rejected because the connection closed before the answer. */
  orphanedRequests: number;
  /** Every notification received, by method, whether or not a handler is registered. */
  notifications: Record<string, number>;
  /** Server requests by method, and how many were answered with METHOD_NOT_FOUND. */
  serverRequests: Record<string, number>;
  serverRequestsRejected: number;
  /** Server requests left for another client to answer (unhandledRequests "ignore", or a handler's NO_ANSWER). */
  serverRequestsIgnored: number;
  /** Frames that were not JSON, or JSON that is no request, response or notification. */
  unparsable: number;
  unrecognized: number;
  /** Responses whose id matches no pending request (late answers after a timeout). */
  strayResponses: number;
  handlerErrors: number;
  lastError: string | null;
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

interface Attempt {
  ok: boolean;
  /** Resolves when this attempt's socket has closed. */
  closed: Promise<void>;
}

type Handler = (params: unknown) => void;
type RequestHandler = (params: unknown, ctx: ServerRequestContext) => unknown;

export class CodexRpc {
  readonly home: string;
  readonly socketPath: string;
  private readonly clientInfo: ClientInfo;
  private readonly experimentalApi: boolean;
  private readonly connectTimeoutMs: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly unhandledRequests: "ignore" | "reject";

  private ws: WebSocket | null = null;
  private isConnected = false;
  private isClosed = false;
  /** Set by fail(): the current connection counts as a failed attempt for the backoff. */
  private connectionFailed = false;
  private nextId = 1;
  private readonly pending = new Map<RequestId, Pending>();
  private readonly notificationHandlers = new Map<string, Set<Handler>>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly connectedHandlers = new Set<(init: InitializeResponse) => void>();
  private readonly disconnectedHandlers = new Set<() => void>();
  private readonly connectFailedHandlers = new Set<(reason: string) => void>();
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;
  private firstAttempt: Promise<boolean> | null = null;
  private initResult: InitializeResponse | null = null;
  private readonly counters: Omit<CodexRpcStats, "socketPath" | "connected"> = {
    connects: 0,
    failedAttempts: 0,
    failedConnections: 0,
    disconnects: 0,
    requests: 0,
    errorResponses: 0,
    timeouts: 0,
    orphanedRequests: 0,
    notifications: {},
    serverRequests: {},
    serverRequestsRejected: 0,
    serverRequestsIgnored: 0,
    unparsable: 0,
    unrecognized: 0,
    strayResponses: 0,
    handlerErrors: 0,
    lastError: null,
  };

  constructor(home: string, opts: CodexRpcOptions = {}) {
    this.home = home;
    this.socketPath = opts.socketPath ?? controlSocketPath(home);
    this.clientInfo = opts.clientInfo ?? { name: "maru", title: null, version: "0.0.0" };
    this.experimentalApi = opts.experimentalApi ?? false;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
    this.initialDelayMs = opts.backoff?.initialMs ?? 500;
    this.maxDelayMs = opts.backoff?.maxMs ?? 30_000;
    this.unhandledRequests = opts.unhandledRequests ?? "ignore";
  }

  get connected(): boolean {
    return this.isConnected;
  }

  /** The daemon's answer to the current connection's `initialize`. */
  get initializeResult(): InitializeResponse | null {
    return this.initResult;
  }

  /**
   * Start the connect loop. Resolves after the first attempt: true when it connected and
   * initialized, false otherwise. Either way the loop keeps (re)connecting until close().
   */
  start(): Promise<boolean> {
    if (this.firstAttempt) return this.firstAttempt;
    let settle!: (ok: boolean) => void;
    this.firstAttempt = new Promise<boolean>((resolve) => (settle = resolve));
    this.loop = this.run(settle);
    return this.firstAttempt;
  }

  /** Skip the current backoff wait and attempt to connect now. */
  retryNow(): void {
    this.wake?.();
  }

  /**
   * Give up on the current connection: close it and count it as a failed attempt, so the next
   * retry waits with a growing delay instead of reconnecting at once.
   */
  fail(reason: string): void {
    this.counters.lastError = reason;
    if (!this.ws) return;
    this.connectionFailed = true;
    this.counters.failedConnections++;
    this.ws.terminate();
  }

  async close(): Promise<void> {
    this.isClosed = true;
    this.wake?.();
    this.ws?.terminate();
    await this.loop;
  }

  request<M extends ClientMethod>(method: M, params: ParamsOf<M>, opts: RequestOptions = {}): Promise<ResultOf<M>> {
    if (!this.isConnected || !this.ws) {
      return Promise.reject(new RpcTransportError(method, "not-connected"));
    }
    return this.send(this.ws, method, params, opts) as Promise<ResultOf<M>>;
  }

  /** Subscribe to a notification. Returns an unsubscribe function. */
  on<M extends NotificationMethod>(method: M, handler: (params: NotificationParams<M>) => void): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) this.notificationHandlers.set(method, (set = new Set()));
    const h = handler as Handler;
    set.add(h);
    return () => set.delete(h);
  }

  /**
   * Answer a server request. The handler's return value (or resolved value) is the result; a
   * thrown RpcError is sent with its code, any other throw as INTERNAL_ERROR. NO_ANSWER sends
   * nothing, so a handler can leave a request to the client that owns it.
   */
  onRequest<M extends ServerRequestMethod>(
    method: M,
    handler: (params: ServerRequestParams<M>, ctx: ServerRequestContext) => unknown,
  ): () => void {
    const h = handler as RequestHandler;
    this.requestHandlers.set(method, h);
    return () => {
      if (this.requestHandlers.get(method) === h) this.requestHandlers.delete(method);
    };
  }

  /** Called after every connection completes `initialize` (the first one and each reconnect). */
  onConnected(handler: (init: InitializeResponse) => void): () => void {
    this.connectedHandlers.add(handler);
    return () => this.connectedHandlers.delete(handler);
  }

  /** Called when an initialized connection closes. */
  onDisconnected(handler: () => void): () => void {
    this.disconnectedHandlers.add(handler);
    return () => this.disconnectedHandlers.delete(handler);
  }

  /** Called when an attempt fails before `initialize` completes, or a connection was given up with fail(). */
  onConnectFailed(handler: (reason: string) => void): () => void {
    this.connectFailedHandlers.add(handler);
    return () => this.connectFailedHandlers.delete(handler);
  }

  stats(): CodexRpcStats {
    return {
      socketPath: this.socketPath,
      connected: this.isConnected,
      ...this.counters,
      notifications: { ...this.counters.notifications },
      serverRequests: { ...this.counters.serverRequests },
    };
  }

  // ---- connect loop ----

  private async run(settleFirst: (ok: boolean) => void): Promise<void> {
    let delay = this.initialDelayMs;
    let first = true;
    while (!this.isClosed) {
      const attempt = await this.attempt();
      if (first) {
        first = false;
        settleFirst(attempt.ok);
      }
      let failed = !attempt.ok;
      if (attempt.ok) {
        await attempt.closed;
        failed = this.connectionFailed;
        if (!failed) delay = this.initialDelayMs;
      } else {
        this.counters.failedAttempts++;
      }
      if (this.isClosed) break;
      if (failed) this.fire(this.connectFailedHandlers, this.counters.lastError ?? "connect failed");
      await this.sleep(delay);
      if (failed) delay = Math.min(delay * 2, this.maxDelayMs);
    }
    if (first) settleFirst(false);
  }

  private sleep(ms: number): Promise<void> {
    if (this.isClosed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        if (this.wake === done) this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private attempt(): Promise<Attempt> {
    return new Promise<Attempt>((resolveAttempt) => {
      let settled = false;
      let markClosed!: () => void;
      const closed = new Promise<void>((resolve) => (markClosed = resolve));
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolveAttempt({ ok, closed });
      };

      this.connectionFailed = false;
      const ws = new WebSocket(`ws+unix://${this.socketPath}:/`, {
        handshakeTimeout: this.connectTimeoutMs,
        perMessageDeflate: false,
      });
      this.ws = ws;

      ws.on("error", (err) => {
        this.counters.lastError = err.message;
      });
      ws.on("message", (data) => this.onMessage(ws, data));
      ws.on("close", () => {
        this.onClose(ws);
        markClosed();
        settle(false);
      });
      ws.on("open", () => {
        const params: InitializeParams = {
          clientInfo: this.clientInfo,
          capabilities: this.experimentalApi ? { experimentalApi: true, requestAttestation: false } : null,
        };
        this.send(ws, "initialize", params, { timeoutMs: this.connectTimeoutMs }).then(
          (result) => {
            if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
            const init = result as InitializeResponse;
            this.initResult = init;
            this.sendRaw(ws, { jsonrpc: "2.0", method: "initialized" });
            this.isConnected = true;
            this.counters.connects++;
            // Handlers run before the attempt settles, so they see the connection before any
            // further message is dispatched (messages arrive in later event-loop turns).
            this.fire(this.connectedHandlers, init);
            settle(true);
          },
          (err: Error) => {
            this.counters.lastError = `initialize: ${err.message}`;
            ws.terminate();
          },
        );
      });
    });
  }

  private onClose(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(id);
      this.counters.orphanedRequests++;
      p.reject(new RpcTransportError(p.method, "closed"));
    }
    if (this.isConnected) {
      this.isConnected = false;
      this.initResult = null;
      this.counters.disconnects++;
      this.fire(this.disconnectedHandlers, undefined);
    }
  }

  // ---- messages ----

  private send(ws: WebSocket, method: string, params: unknown, opts: RequestOptions): Promise<unknown> {
    const id = this.nextId++;
    this.counters.requests++;
    return new Promise((resolve, reject) => {
      const entry: Pending = { method, resolve, reject, timer: null };
      if (opts.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          this.counters.timeouts++;
          reject(new RpcTransportError(method, "timeout", `${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }
      this.pending.set(id, entry);
      this.sendRaw(ws, { jsonrpc: "2.0", id, method, params });
    });
  }

  private sendRaw(ws: WebSocket, msg: object): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  private onMessage(ws: WebSocket, data: RawData): void {
    if (this.ws !== ws) return;
    let msg: unknown;
    try {
      msg = JSON.parse(rawToString(data));
    } catch {
      this.counters.unparsable++;
      return;
    }
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      this.counters.unrecognized++;
      return;
    }
    const m = msg as { id?: RequestId | null; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    const hasId = m.id !== undefined && m.id !== null;
    if (typeof m.method === "string") {
      if (hasId) this.onServerRequest(ws, m.id as RequestId, m.method, m.params);
      else this.onNotification(m.method, m.params);
      return;
    }
    if (hasId) {
      this.onResponse(m.id as RequestId, m);
      return;
    }
    this.counters.unrecognized++;
  }

  private onResponse(id: RequestId, m: { result?: unknown; error?: unknown }): void {
    const p = this.pending.get(id);
    if (!p) {
      this.counters.strayResponses++;
      return;
    }
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    if (m.error !== undefined && m.error !== null) {
      this.counters.errorResponses++;
      const e = m.error as { code?: unknown; message?: unknown; data?: unknown };
      p.reject(
        new RpcError(
          p.method,
          typeof e.code === "number" ? e.code : INTERNAL_ERROR,
          typeof e.message === "string" ? e.message : JSON.stringify(m.error),
          e.data,
        ),
      );
      return;
    }
    p.resolve(m.result);
  }

  private onNotification(method: string, params: unknown): void {
    this.counters.notifications[method] = (this.counters.notifications[method] ?? 0) + 1;
    const set = this.notificationHandlers.get(method);
    if (!set) return;
    for (const h of [...set]) {
      try {
        h(params);
      } catch (err) {
        this.noteHandlerError(err);
      }
    }
  }

  private onServerRequest(ws: WebSocket, id: RequestId, method: string, params: unknown): void {
    this.counters.serverRequests[method] = (this.counters.serverRequests[method] ?? 0) + 1;
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      if (this.unhandledRequests === "ignore") {
        this.counters.serverRequestsIgnored++;
        return;
      }
      this.counters.serverRequestsRejected++;
      this.sendRaw(ws, {
        jsonrpc: "2.0",
        id,
        error: { code: METHOD_NOT_FOUND, message: `maru does not handle ${method}` },
      });
      return;
    }
    Promise.resolve()
      .then(() => handler(params, { id }))
      .then(
        (result) => {
          if (result === NO_ANSWER) {
            this.counters.serverRequestsIgnored++;
            return;
          }
          this.sendRaw(ws, { jsonrpc: "2.0", id, result: result ?? null });
        },
        (err: unknown) => {
          this.noteHandlerError(err);
          const code = err instanceof RpcError ? err.code : INTERNAL_ERROR;
          const message = err instanceof Error ? err.message : String(err);
          this.sendRaw(ws, { jsonrpc: "2.0", id, error: { code, message } });
        },
      );
  }

  private fire<A>(handlers: Set<(arg: A) => void>, arg: A): void {
    for (const h of [...handlers]) {
      try {
        h(arg);
      } catch (err) {
        this.noteHandlerError(err);
      }
    }
  }

  private noteHandlerError(err: unknown): void {
    this.counters.handlerErrors++;
    this.counters.lastError = err instanceof Error ? err.message : String(err);
  }
}

/** Connect to the daemon of `home` and initialize. Rejects when the first attempt fails. */
export async function connect(home: string, opts: CodexRpcOptions = {}): Promise<CodexRpc> {
  const rpc = new CodexRpc(home, opts);
  if (await rpc.start()) return rpc;
  const reason = rpc.stats().lastError ?? "connect failed";
  await rpc.close();
  throw new Error(`codex daemon at ${rpc.socketPath}: ${reason}`);
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
