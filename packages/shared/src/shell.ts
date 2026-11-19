// Shell terminals (DESIGN.md 6s): a plain login shell, with no agent in it and no session that owns it. Each one is a session of a tmux server that maru keeps for these shells alone, so the shell
// outlives the web server's restarts and a page's reload; the web server only attaches a tmux client
// to it for each open view.
//
// HTTP (web listener, and the device listener for a desktop or an Android token, DESIGN.md 6s):
//   GET    /api/shells                     every shell
//   POST   /api/shells                     CreateShellRequest -> ShellInfo
//   DELETE /api/shells/<id>                ends the shell
// WebSocket SHELL_SOCKET_PATH?id=<id>&cols=<n>&rows=<n>: one attached view of one shell.
//   binary frames  client -> server: keyboard input (UTF-8); server -> client: terminal output
//   text frames    JSON, ShellClientFrame and ShellServerFrame

/** One shell terminal as the server lists it. */
export interface ShellInfo {
  /** The tmux session name, `sh-` and 12 lowercase letters or digits. */
  id: string;
  /** The folder it started in. */
  cwd: string;
  /** Epoch ms. */
  createdAt: number;
  /** The command in the foreground of the shell (tmux `pane_current_command`): the shell's own name when idle. */
  command: string;
  /** The shell's current folder (tmux `pane_current_path`). */
  path: string;
  /** Views attached right now, in any browser. */
  clients: number;
}

export interface ShellListResponse {
  shells: ShellInfo[];
}

export interface CreateShellRequest {
  /** Absolute folder to start in; null starts in the home folder. */
  cwd: string | null;
}

export const SHELL_SOCKET_PATH = "/shell";

const SHELL_ID = /^sh-[a-z0-9]{12}$/;

export function isShellId(value: unknown): value is string {
  return typeof value === "string" && SHELL_ID.test(value);
}

/** The grid a view may ask for; outside it the request is refused, not clamped. */
export const SHELL_GRID_LIMITS = { cols: { min: 2, max: 1000 }, rows: { min: 1, max: 500 } } as const;

/** The view's grid from untrusted input, or null when it is not a pair of integers inside the limits. */
export function shellGrid(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  const c = typeof cols === "string" ? Number(cols) : cols;
  const r = typeof rows === "string" ? Number(rows) : rows;
  if (typeof c !== "number" || typeof r !== "number" || !Number.isInteger(c) || !Number.isInteger(r)) return null;
  const { cols: cl, rows: rl } = SHELL_GRID_LIMITS;
  if (c < cl.min || c > cl.max || r < rl.min || r > rl.max) return null;
  return { cols: c, rows: r };
}

/** Text frames a view sends. */
export type ShellClientFrame = { type: "resize"; cols: number; rows: number };

/**
 * Text frames the server sends.
 *   attached  the view is live; output follows as binary frames (the scrollback first)
 *   ended     the view is over and the socket closes after it:
 *               exited   the shell ended (exit, Ctrl+D, or its process was killed)
 *               closed   someone closed the shell (the close button, in any browser)
 *               missing  no shell with that id (already gone)
 *               error    the server could not attach (message says why)
 * A socket that closes without `ended` (the server restarted, the network dropped) leaves the shell
 * running, and the view attaches again.
 */
export type ShellServerFrame =
  | { type: "attached"; shell: ShellInfo }
  | { type: "ended"; reason: "exited" | "closed" | "missing" | "error"; message?: string };

export function parseShellClientFrame(text: string): ShellClientFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const v = value as Partial<ShellClientFrame> | null;
  if (v?.type !== "resize") return null;
  const grid = shellGrid(v.cols, v.rows);
  return grid ? { type: "resize", ...grid } : null;
}

export function parseShellServerFrame(text: string): ShellServerFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const v = value as { type?: unknown; shell?: unknown; reason?: unknown; message?: unknown } | null;
  if (v?.type === "attached" && v.shell && typeof v.shell === "object") return { type: "attached", shell: v.shell as ShellInfo };
  if (v?.type === "ended" && (v.reason === "exited" || v.reason === "closed" || v.reason === "missing" || v.reason === "error")) {
    return { type: "ended", reason: v.reason, ...(typeof v.message === "string" ? { message: v.message } : {}) };
  }
  return null;
}
