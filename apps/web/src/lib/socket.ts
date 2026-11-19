import type { ClientMessage, ServerMessage, ThreadHave } from "@maru/shared";

import { noteServerTime } from "./serverClock.ts";

export type Connection = "connecting" | "open" | "closed";

/** The part of the browser WebSocket the hub uses, so tests can pass a fake. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface SocketHubOptions {
  /** Opens a new socket to the server's /ws. */
  open: () => SocketLike;
  /** Delay before reconnect attempt n (0-based). */
  backoffMs?: (attempt: number) => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const OPEN = 1;

/** `thread.subscribe` options: `rows` asks for a windowed subscription, `pageSize` for the provider's page. */
export interface ThreadSubscription {
  pageSize?: number;
  rows?: number;
  /** The rows kept from an earlier visit (threadCache.ts, DESIGN.md 6r). */
  have?: ThreadHave;
}

/**
 * The one /ws connection of the page. It connects on first use, reconnects with backoff, fans
 * server messages out to listeners, and keeps a reference count per thread so every open view
 * shares one server subscription. After a reconnect the server has forgotten the socket's
 * subscriptions, so the hub subscribes each retained thread again and the server answers with a
 * fresh snapshot.
 */
export class SocketHub {
  private readonly options: Required<SocketHubOptions>;
  private socket: SocketLike | null = null;
  private connection: Connection = "closed";
  private started = false;
  private attempt = 0;
  private timer: unknown = undefined;
  private readonly messageListeners = new Set<(msg: ServerMessage) => void>();
  private readonly connectionListeners = new Set<() => void>();
  /**
   * threadId -> holders and the subscription options the first holder asked for. A function is
   * asked each time the subscribe goes out (the first send and every reconnect), so it can carry
   * what the page holds of the thread by then.
   */
  private readonly threads = new Map<string, { count: number; options: ThreadSubscription | (() => ThreadSubscription) }>();

  constructor(options: SocketHubOptions) {
    this.options = {
      backoffMs: (attempt) => Math.min(30_000, 500 * 2 ** attempt),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      ...options,
    };
  }

  getConnection = (): Connection => this.connection;

  /** For useSyncExternalStore: notified when the connection state changes. */
  subscribeConnection = (listener: () => void): (() => void) => {
    this.connectionListeners.add(listener);
    this.start();
    return () => {
      this.connectionListeners.delete(listener);
    };
  };

  onMessage(listener: (msg: ServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    this.start();
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  /** Sends when the socket is open; returns false otherwise (the message is not queued). */
  send(msg: ClientMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN || this.connection !== "open") return false;
    socket.send(JSON.stringify(msg));
    return true;
  }

  /**
   * Holds a thread subscription until the returned release is called. The first holder sends
   * `thread.subscribe` with its options (`rows`: a windowed subscription, DESIGN.md 6r), the last
   * release sends `thread.unsubscribe`.
   */
  retainThread(threadId: string, options: ThreadSubscription | (() => ThreadSubscription) = {}): () => void {
    this.start();
    const held = this.threads.get(threadId);
    if (held) {
      held.count++;
    } else {
      this.threads.set(threadId, { count: 1, options });
      this.sendSubscribe(threadId);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.threads.get(threadId);
      if (!current) return;
      current.count--;
      if (current.count > 0) return;
      this.threads.delete(threadId);
      this.send({ type: "thread.unsubscribe", threadId });
    };
  }

  /** Thread ids currently held (for tests and diagnostics). */
  retainedThreads(): string[] {
    return [...this.threads.keys()];
  }

  /**
   * Asks the server for the thread again, with `options` for this send only: the unsubscribe and
   * the subscribe go out in order, so the server replaces the old subscription (a second subscribe
   * for a held thread is ignored). False when the socket is not open (a reconnect subscribes anyway).
   */
  resubscribe(threadId: string, options: ThreadSubscription): boolean {
    if (!this.threads.has(threadId) || !this.isOpen()) return false;
    this.send({ type: "thread.unsubscribe", threadId });
    this.sendSubscribe(threadId, options);
    return true;
  }

  private isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === OPEN && this.connection === "open";
  }

  private sendSubscribe(threadId: string, override?: ThreadSubscription): void {
    const held = this.threads.get(threadId);
    if (!held || !this.isOpen()) return;
    const { pageSize, rows, have } = override ?? (typeof held.options === "function" ? held.options() : held.options);
    this.send({
      type: "thread.subscribe",
      threadId,
      ...(pageSize === undefined ? {} : { pageSize }),
      ...(rows === undefined ? {} : { rows }),
      ...(have === undefined ? {} : { have }),
    });
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private setConnection(next: Connection): void {
    if (this.connection === next) return;
    this.connection = next;
    for (const listener of [...this.connectionListeners]) listener();
  }

  private connect(): void {
    this.setConnection("connecting");
    let socket: SocketLike;
    try {
      socket = this.options.open();
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.setConnection("open");
      for (const threadId of this.threads.keys()) this.sendSubscribe(threadId);
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "hello") noteServerTime(msg.serverTime);
      for (const listener of [...this.messageListeners]) listener(msg);
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.setConnection("closed");
    const delay = this.options.backoffMs(this.attempt++);
    this.timer = this.options.setTimer(() => {
      this.timer = undefined;
      this.connect();
    }, delay);
  }

  /** Stops reconnecting and closes the socket (tests). */
  dispose(): void {
    if (this.timer !== undefined) this.options.clearTimer(this.timer);
    this.timer = undefined;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.setConnection("closed");
  }
}

let defaultHub: SocketHub | null = null;

/** The page's shared hub, connected to this origin's /ws. */
export function socketHub(): SocketHub {
  defaultHub ??= new SocketHub({
    open: () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      return new WebSocket(`${proto}://${location.host}/ws`) as unknown as SocketLike;
    },
  });
  return defaultHub;
}
