// The web server's connection to the Claude session host (DESIGN.md 2b). It connects, greets with
// `hello` (watch), hands the snapshot to its listeners, then streams events. When the host is not
// there or the connection drops, it tries again every `retryMs` for as long as the server runs.
import { duplexPair, type Duplex } from "node:stream";
import { openHostClient, type HostClient, type RequestBody } from "../host/client.ts";
import type { SessionHost } from "../host/core.ts";
import type { HostEvent, HostInfo, Snapshot } from "../host/protocol.ts";
import { connectSocket, serveStream } from "../host/socket.ts";

/** Wait between connect attempts while the host is away, ms. An interval: attempts never stop. */
export const HOST_RETRY_MS = 1000;

/** Shown to the UI when a Claude command needs the host and it is not connected. */
export class HostDownError extends Error {
  constructor() {
    super("Claude session host is down. You can send once it reconnects");
    this.name = "HostDownError";
  }
}

export interface HostLinkListener {
  /** Connected and greeted; every event after it comes after this snapshot. */
  onSnapshot?(s: Snapshot): void;
  onEvent?(e: HostEvent): void;
  /** The host could not be reached or the connection dropped. */
  onDown?(error: string | null): void;
}

export interface HostLink {
  connected(): boolean;
  /** The connected host, kept current by host.state events; null while disconnected. */
  host(): HostInfo | null;
  /** Why the last attempt failed or the connection dropped; null while connected. */
  error(): string | null;
  /** Rejects with HostDownError while disconnected. */
  request<T = unknown>(req: RequestBody): Promise<T>;
  /** Sends without waiting for the reply; false while disconnected. */
  post(req: RequestBody): boolean;
  listen(l: HostLinkListener): () => void;
  /** Resolves once the first attempt ended: greeted (listeners had the snapshot) or failed. */
  ready(): Promise<void>;
  close(): void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createHostLink(opts: { open: () => Promise<Duplex>; client: string; retryMs?: number; log?: (line: string) => void }): HostLink {
  const listeners = new Set<HostLinkListener>();
  let conn: HostClient | null = null;
  let hostInfo: HostInfo | null = null;
  let lastError: string | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let wasUp: boolean | null = null;
  let markReady!: () => void;
  const readyP = new Promise<void>((r) => (markReady = r));

  const each = (fn: (l: HostLinkListener) => void) => {
    for (const l of [...listeners]) {
      try {
        fn(l);
      } catch (err) {
        opts.log?.(`host link: listener threw: ${errorText(err)}`);
      }
    }
  };

  function down(error: string): void {
    lastError = error;
    hostInfo = null;
    if (wasUp !== false) {
      opts.log?.(`session host unreachable: ${error}`);
      wasUp = false;
      each((l) => l.onDown?.(error));
    }
  }

  function schedule(): void {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void attempt();
    }, opts.retryMs ?? HOST_RETRY_MS);
    timer.unref();
  }

  async function attempt(): Promise<void> {
    if (stopped) return;
    let stream: Duplex;
    try {
      stream = await opts.open();
    } catch (err) {
      down(errorText(err));
      schedule();
      markReady();
      return;
    }
    if (stopped) {
      stream.destroy();
      return;
    }
    // Events that arrive before the hello reply was handled belong after the snapshot.
    let greeted = false;
    const early: HostEvent[] = [];
    const c = openHostClient(stream, {
      onEvent(e) {
        if (!greeted) {
          early.push(e);
          return;
        }
        if (e.ev === "host.state") hostInfo = e.host;
        each((l) => l.onEvent?.(e));
      },
      onClose(err) {
        if (stopped || (conn !== c && greeted)) return;
        conn = null;
        down(err ? errorText(err) : "the connection closed");
        schedule();
      },
    });
    let snap: Snapshot;
    try {
      snap = await c.request<Snapshot>({ op: "hello", client: opts.client, watch: true });
    } catch {
      // onClose reports it and schedules the next attempt.
      c.close();
      markReady();
      return;
    }
    if (c.closed) {
      markReady();
      return;
    }
    conn = c;
    greeted = true;
    hostInfo = snap.host;
    lastError = null;
    if (wasUp !== true) opts.log?.(`session host connected: pid ${snap.host.pid}, ${snap.runs.length} run(s), ${snap.callbacks.length} callback(s)`);
    wasUp = true;
    each((l) => l.onSnapshot?.(snap));
    for (const e of early.splice(0)) {
      if (e.ev === "host.state") hostInfo = e.host;
      each((l) => l.onEvent?.(e));
    }
    markReady();
  }

  void attempt();

  return {
    connected: () => conn !== null,
    host: () => hostInfo,
    error: () => (conn ? null : lastError),
    request<T>(req: RequestBody): Promise<T> {
      if (!conn) return Promise.reject(new HostDownError());
      return conn.request<T>(req);
    },
    post(req: RequestBody): boolean {
      return conn ? conn.post(req) : false;
    },
    listen(l: HostLinkListener): () => void {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    ready: () => readyP,
    close(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const c = conn;
      conn = null;
      c?.close();
    },
  };
}

/** The production link: the host's unix socket. */
export function socketHostLink(socketPath: string, opts: { client?: string; retryMs?: number; log?: (line: string) => void } = {}): HostLink {
  return createHostLink({ ...opts, open: () => connectSocket(socketPath), client: opts.client ?? "web" });
}

/**
 * A host in this process, reached through an in-memory stream pair with the same frames as the
 * socket. Tests and driver-check.ts use it.
 */
export function localHostLink(host: SessionHost, opts: { client?: string; retryMs?: number; log?: (line: string) => void } = {}): HostLink {
  return createHostLink({
    ...opts,
    open: async () => {
      const [server, client] = duplexPair();
      serveStream(host, server, opts.log);
      return client;
    },
    client: opts.client ?? "local",
  });
}
