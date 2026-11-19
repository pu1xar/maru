// The /ws connection to the paired server: the same protocol as the web (packages/shared
// ServerMessage, ClientMessage), with the device token in the upgrade's Authorization header.
// It reconnects after a drop with a growing pause (1 s doubling to 15 s, without a retry count);
// before each retry it asks /api/device/me, so a removed device stops at once instead of retrying.
// It is closed while the app is in the background (suspend, resume): the server counts a device
// with an open /ws as on the screen and pushes only to the others (DESIGN.md 2d, push notifications).
//
// One socket at a time. Every open() and stop() starts a new generation; what an older one
// started (a retry waiting on /api/device/me, which can hang as React Native's HTTP client has no
// timeout, or its timer) does nothing once it resumes, and open() closes the socket before it.
// A second socket would apply every live event twice and keep the server from pushing while
// the app is in the background (independent review, 2026-11-16).
import type { ClientMessage, ServerMessage } from "@maru/shared";
import { ApiError, authHeaders, fetchSelf, wsUrl, type Pairing } from "./api.ts";

export type ConnectionState = "connecting" | "open" | "offline" | "revoked";

const MIN_PAUSE_MS = 1000;
const MAX_PAUSE_MS = 15000;

type RNWebSocketCtor = new (url: string, protocols?: string | string[] | null, options?: { headers: Record<string, string> }) => WebSocket;

export class Connection {
  private ws: WebSocket | null = null;
  private stopped = false;
  private gen = 0;
  private pause = MIN_PAUSE_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(msg: ServerMessage) => void>();
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private openListeners = new Set<() => void>();
  state: ConnectionState = "connecting";
  private pairing: Pairing;

  constructor(pairing: Pairing) {
    this.pairing = pairing;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.gen += 1;
    this.clearTimer();
    this.drop();
  }

  /** Closes /ws while the app is in the background. */
  suspend(): void {
    if (this.stopped || this.state === "revoked") return;
    this.stop();
    this.setState("offline");
  }

  /** Reconnects now (the app came to the foreground). */
  resume(): void {
    if (this.state === "revoked") return;
    if (this.stopped) {
      this.start();
      return;
    }
    if (this.state === "open") return;
    this.pause = MIN_PAUSE_MS;
    this.open();
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  onMessage(fn: (msg: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onState(fn: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  /** Every (re)connect, so open screens subscribe again. */
  onOpen(fn: () => void): () => void {
    this.openListeners.add(fn);
    return () => this.openListeners.delete(fn);
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    for (const fn of this.stateListeners) fn(s);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Forgets the current socket first, so its close event is not taken for a drop, then closes it. */
  private drop(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private open(): void {
    this.gen += 1;
    const gen = this.gen;
    this.clearTimer();
    this.drop();
    this.setState("connecting");
    const Ctor = WebSocket as unknown as RNWebSocketCtor;
    const ws = new Ctor(wsUrl(this.pairing), null, { headers: authHeaders(this.pairing) });
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.pause = MIN_PAUSE_MS;
      this.setState("open");
      for (const fn of this.openListeners) fn();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      for (const fn of this.listeners) fn(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      this.setState("offline");
      void this.retryLater(gen);
    };
  }

  private async retryLater(gen: number): Promise<void> {
    try {
      await fetchSelf(this.pairing);
    } catch (e) {
      if (gen === this.gen && e instanceof ApiError && e.status === 401) {
        this.setState("revoked");
        return;
      }
    }
    if (this.stopped || gen !== this.gen) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped && gen === this.gen) this.open();
    }, this.pause);
    this.pause = Math.min(this.pause * 2, MAX_PAUSE_MS);
  }
}
