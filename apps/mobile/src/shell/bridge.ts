// What the shell screen's WebView page and the app say to each other (DESIGN.md 6s). The page is
// xterm.js and nothing else: the app owns the /shell socket (so the device token never enters the
// page) and the page only draws bytes and reports keys and its size. All of it is JSON text;
// terminal bytes travel as base64 because a WebView message is a string.
//
//   page -> app    posted with window.ReactNativeWebView.postMessage (PageMessage)
//   app -> page    run as a script that calls window.maru.recv(message) (AppMessage, injection())

/** What the page reports. */
export type PageMessage =
  /** The terminal is up and fitted: the app opens the socket with this grid. */
  | { t: "ready"; cols: number; rows: number }
  /** The box changed size (a rotation, the keyboard opening) and the grid with it. */
  | { t: "resize"; cols: number; rows: number }
  /** What the keyboard typed (xterm's onData), UTF-8 text. */
  | { t: "in"; d: string }
  /** xterm's binary input (mouse reports in some modes), one byte per character code. */
  | { t: "bin"; d: string }
  /** The shell switched its cursor key mode (vim and less do), so the arrow keys of the key bar follow it. */
  | { t: "mode"; appCursor: boolean }
  /** The page script failed. */
  | { t: "error"; message: string };

/** The xterm settings the page takes at start and when they change. */
export interface PageLook {
  fontFamily: string;
  /** @font-face rules for the font's files (look.ts pageFont); empty for the phone's own monospace. */
  faceCss: string;
  fontSize: number;
  theme: {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent: string;
    selectionBackground: string;
    selectionForeground: string;
  };
}

/** What the app tells the page. */
export type AppMessage =
  /** Terminal output (base64). */
  | { t: "out"; b: string }
  /** Start the screen over: the server sends the scrollback and the screen again on every attach. */
  | { t: "reset" }
  | { t: "focus" }
  /** Text from the clipboard, entered the way a paste is (bracketed when the shell asked for it). */
  | { t: "paste"; text: string }
  | { t: "look"; look: PageLook };

const isGridNumber = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** A page message from the untrusted text a WebView hands over, or null when it is not one. */
export function parsePageMessage(raw: string): PageMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  switch (m.t) {
    case "ready":
    case "resize":
      return isGridNumber(m.cols) && isGridNumber(m.rows) ? { t: m.t, cols: m.cols, rows: m.rows } : null;
    case "in":
    case "bin":
      return typeof m.d === "string" ? { t: m.t, d: m.d } : null;
    case "mode":
      return typeof m.appCursor === "boolean" ? { t: "mode", appCursor: m.appCursor } : null;
    case "error":
      return typeof m.message === "string" ? { t: "error", message: m.message } : null;
    default:
      return null;
  }
}

/** The script that hands `message` to the page. It ends in `true` as WebView.injectJavaScript asks. */
export function injection(message: AppMessage): string {
  return `window.maru&&window.maru.recv(${JSON.stringify(message)});true;`;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < n ? bytes[i + 1]! : 0;
    const c = i + 2 < n ? bytes[i + 2]! : 0;
    out += B64[a >> 2]! + B64[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < n ? B64[((b & 15) << 2) | (c >> 6)]! : "=";
    out += i + 2 < n ? B64[c & 63]! : "=";
  }
  return out;
}

export interface OutputBatcherOptions {
  /** Receives the base64 of everything pushed since the last send, in order. */
  send: (b64: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** How long output collects before it is sent (one frame). */
  windowMs?: number;
}

/**
 * Terminal output arrives in many small socket messages; each one sent to the page on its own is a
 * script run per message. This joins what arrives within one frame into one message, keeping the
 * order and every byte (nothing is dropped, however much arrives).
 */
export class OutputBatcher {
  private chunks: Uint8Array[] = [];
  private timer: unknown = null;
  private readonly o: Required<OutputBatcherOptions>;

  constructor(options: OutputBatcherOptions) {
    this.o = {
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      windowMs: 16,
      ...options,
    };
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.timer ??= this.o.setTimer(() => this.flush(), this.o.windowMs);
  }

  /** Sends what is waiting now. */
  flush(): void {
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
    if (this.chunks.length === 0) return;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const c of this.chunks) {
      joined.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    this.o.send(base64Encode(joined));
  }

  /** Forgets what is waiting (the screen is starting over). */
  clear(): void {
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
    this.chunks = [];
  }
}
