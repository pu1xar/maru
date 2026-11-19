// One view's socket to one shell (DESIGN.md 6s, contract in packages/shared/src/shell.ts). It
// attaches, passes keyboard input and the grid, and hands the terminal its output. A socket that
// closes without the server's `ended` (a deploy restarted the web server, the network dropped) is
// opened again with backoff while the view lives; the server then sends `attached` and the
// scrollback again, so the view resets its terminal on every `attached`.
import { parseShellServerFrame, SHELL_SOCKET_PATH, type ShellInfo, type ShellServerFrame } from "@maru/shared";

export type ShellConnectionState = "connecting" | "live" | "reconnecting" | "ended";

/** The part of the browser WebSocket used here, so tests can pass a fake. */
export interface ShellSocketLike {
  readonly readyState: number;
  binaryType: string;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string | Uint8Array): void;
  close(): void;
}

export interface ShellConnectionOptions {
  id: string;
  /** The server's scheme and host: a page passes its own `location`, the Android app its paired server's. */
  origin: { protocol: string; host: string };
  /** The terminal's grid now (asked on every connect). */
  grid: () => { cols: number; rows: number };
  open: (url: string) => ShellSocketLike;
  onAttached: (shell: ShellInfo) => void;
  onOutput: (data: Uint8Array) => void;
  onEnded: (frame: Extract<ShellServerFrame, { type: "ended" }>) => void;
  onState: (state: ShellConnectionState) => void;
  backoffMs?: (attempt: number) => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

/**
 * A socket that stayed attached this long starts the backoff over; one that closes sooner (a
 * client that attaches and drops again) keeps it growing, so a loop does not resend the scrollback
 * every half second.
 */
export const SHELL_STABLE_MS = 5000;

const OPEN = 1;
const encoder = new TextEncoder();

export function shellSocketUrl(id: string, cols: number, rows: number, loc: { protocol: string; host: string }): string {
  const proto = loc.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${loc.host}${SHELL_SOCKET_PATH}?id=${encodeURIComponent(id)}&cols=${cols}&rows=${rows}`;
}

export class ShellConnection {
  private readonly o: Required<ShellConnectionOptions>;
  private socket: ShellSocketLike | null = null;
  private attempt = 0;
  private timer: unknown = undefined;
  private state: ShellConnectionState = "connecting";
  private disposed = false;

  constructor(options: ShellConnectionOptions) {
    this.o = {
      backoffMs: (attempt) => Math.min(10_000, 500 * 2 ** attempt),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
      ...options,
    };
    this.connect();
  }

  getState = (): ShellConnectionState => this.state;

  private setState(next: ShellConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.o.onState(next);
  }

  private connect(): void {
    if (this.disposed) return;
    const { cols, rows } = this.o.grid();
    const socket = this.o.open(shellSocketUrl(this.o.id, cols, rows, this.o.origin));
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let ended = false;
    let attachedAt: number | null = null;
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      const data = ev.data;
      if (typeof data === "string") {
        const frame = parseShellServerFrame(data);
        if (frame?.type === "attached") {
          attachedAt = this.o.now();
          this.setState("live");
          this.o.onAttached(frame.shell);
        } else if (frame?.type === "ended") {
          ended = true;
          this.setState("ended");
          this.o.onEnded(frame);
        }
        return;
      }
      if (data instanceof ArrayBuffer) this.o.onOutput(new Uint8Array(data));
      else if (data instanceof Uint8Array) this.o.onOutput(data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (ended || this.disposed) return;
      if (attachedAt !== null && this.o.now() - attachedAt >= SHELL_STABLE_MS) this.attempt = 0;
      this.setState("reconnecting");
      const delay = this.o.backoffMs(this.attempt++);
      this.timer = this.o.setTimer(() => this.connect(), delay);
    };
    socket.onerror = () => {};
  }

  /** Keyboard input. Typed while the socket is down it is not sent (the view says it is reconnecting). */
  input(data: string): void {
    if (this.state === "live" && this.socket?.readyState === OPEN) this.socket.send(encoder.encode(data));
  }

  /** xterm's binary input (mouse reports in some modes): one byte per character code. */
  inputBinary(data: string): void {
    if (this.state !== "live" || this.socket?.readyState !== OPEN) return;
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
    this.socket.send(bytes);
  }

  resize(cols: number, rows: number): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  dispose(): void {
    this.disposed = true;
    this.o.clearTimer(this.timer);
    const s = this.socket;
    this.socket = null;
    s?.close();
  }
}
