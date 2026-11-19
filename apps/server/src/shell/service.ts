// Shell terminals (DESIGN.md 6s): the HTTP routes that list, open and close them, and the
// WebSocket of one attached view. The shells themselves live in their own tmux server (tmux.ts);
// this process holds one tmux client per open view, in a pty, and pipes it to the view's socket.
// When this process ends (a deploy restarts it) those clients end and the shells keep running; the
// page attaches again and reads the scrollback back from tmux.
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { WebSocket } from "ws";
import {
  isShellId, parseShellClientFrame, shellGrid, type CreateShellRequest, type ShellInfo, type ShellListResponse, type ShellServerFrame,
} from "@maru/shared";
import { nodePtySpawn, type IPty, type PtySpawner } from "./pty.ts";
import {
  formatLiteral, hasControlChars, historyPrelude, joinCommands, LIST_FORMAT, newShellId, paneCommand, parseSessionList,
  serverOptionCommands, shellEnv, shellUser, tmuxLiteral, TmuxError, tmuxRunner, type TmuxRunner,
} from "./tmux.ts";

export class ShellError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ShellServiceOptions {
  /** The tmux binary (tmux.ts resolveTmux); null when there is none, and every route answers 503. */
  tmux: string | null;
  /** The shells' tmux socket (config.ts SHELL_SOCKET). */
  socket: string;
  /** The user's login shell. */
  shell?: string;
  /** The environment the tmux server and the attached clients start with (tmux.ts shellEnv). */
  env?: Record<string, string>;
  /** Tests pass a runner or a pty of their own. */
  run?: TmuxRunner;
  spawnPty?: PtySpawner;
  /** How often view sockets are pinged; one that has not answered by the next ping is closed. Default 30 s. */
  pingMs?: number;
  log?: (line: string) => void;
}

/** Output queued on a view's socket above which the tmux client is paused until it drains. */
const PAUSE_ABOVE = 4 * 1024 * 1024;
const RESUME_BELOW = 512 * 1024;
/**
 * Same as /ws (http/server.ts): a dead peer is noticed, and an idle shell view keeps its socket
 * under the 100 s after which many proxies close an idle WebSocket.
 */
const PING_MS = 30_000;

interface View {
  ws: WebSocket;
  id: string;
  grid: { cols: number; rows: number };
  pty: IPty | null;
  /**
   * The tmux client has drawn its first output, so it has put its tty in raw mode. Input written
   * before that would meet the tty's line discipline (echoed, and a Ctrl+C would kill the client).
   */
  ready: boolean;
  /** Input that came before the tmux client was ready. */
  pending: Buffer[];
  /** The shell was closed from a close button: the view ends with "closed", not "exited". */
  closedByUser: boolean;
  done: boolean;
  unanswered: boolean;
}

export class ShellService {
  private readonly opts: ShellServiceOptions;
  private readonly run: TmuxRunner | null;
  private readonly env: Record<string, string>;
  private readonly shell: string;
  private readonly views = new Set<View>();
  private readonly pinger: ReturnType<typeof setInterval>;
  private spawner: PtySpawner | null;

  constructor(opts: ShellServiceOptions) {
    this.opts = opts;
    const user = shellUser();
    this.shell = opts.shell ?? user.shell;
    this.env = opts.env ?? shellEnv(process.env, { ...user, shell: this.shell });
    this.run = opts.run ?? (opts.tmux ? tmuxRunner(opts.tmux, opts.socket, this.env) : null);
    this.spawner = opts.spawnPty ?? null;
    this.pinger = setInterval(() => {
      for (const v of this.views) {
        if (v.unanswered) {
          v.ws.terminate();
          continue;
        }
        if (v.ws.readyState !== v.ws.OPEN) continue;
        v.unanswered = true;
        v.ws.ping();
      }
    }, opts.pingMs ?? PING_MS);
    this.pinger.unref();
  }

  private tmux(): TmuxRunner {
    if (!this.run) throw new ShellError(503, "tmux not found");
    return this.run;
  }

  /** Every shell of the tmux server, whichever way it was opened. */
  async list(): Promise<ShellInfo[]> {
    let out: string;
    try {
      out = await this.tmux()(["list-sessions", "-F", LIST_FORMAT]);
    } catch (err) {
      if (err instanceof TmuxError && err.missing) return [];
      throw err;
    }
    return parseSessionList(out);
  }

  async get(id: string): Promise<ShellInfo | null> {
    return (await this.list()).find((s) => s.id === id) ?? null;
  }

  async create(req: Partial<CreateShellRequest>): Promise<ShellInfo> {
    // A line break or the list's separator in a value would hide the shell from the list (tmux.ts LIST_FORMAT).
    let cwd = this.env.HOME!;
    if (req.cwd !== null && req.cwd !== undefined) {
      if (typeof req.cwd !== "string" || !path.isAbsolute(req.cwd)) throw new ShellError(400, "Folder must be an absolute path");
      if (hasControlChars(req.cwd)) throw new ShellError(400, "Folder name contains control characters");
      let dir = false;
      try {
        dir = fs.statSync(req.cwd).isDirectory();
      } catch {
        // missing
      }
      if (!dir) throw new ShellError(400, `Folder not found: ${req.cwd}`);
      cwd = req.cwd;
    }
    const id = newShellId();
    const run = this.tmux();
    await run(joinCommands([
      ["start-server"],
      ...serverOptionCommands(),
      // tmux expands `-c` as a format: a folder named `x#(cmd)` would run cmd (formatLiteral).
      ["new-session", "-d", "-s", id, "-c", tmuxLiteral(formatLiteral(cwd)), "-x", "120", "-y", "30", "--", ...paneCommand(this.shell)],
    ]));
    await run(["set-option", "-t", id, "@maru_cwd", tmuxLiteral(cwd)]);
    this.opts.log?.(`shell: opened ${id} in ${cwd}`);
    return (await this.get(id)) ?? { id, cwd, createdAt: Date.now(), command: path.basename(this.shell), path: cwd, clients: 0 };
  }

  /**
   * Types `text` into the shell and presses Enter, as a person at the keyboard would (the shell
   * echoes it as a line it runs). Not an HTTP route: the accounts login (accounts/service.ts)
   * starts the official CLI's sign-in in a shell this way.
   */
  async typeLine(id: string, text: string): Promise<void> {
    if (!isShellId(id)) throw new ShellError(400, "Invalid terminal id");
    if (hasControlChars(text)) throw new ShellError(400, "The line contains control characters");
    const run = this.tmux();
    try {
      // A new shell is typed into once its prompt is drawn: input that arrives before is echoed by
      // the tty and again by the shell. A shell with no prompt text at all is typed into after 5 s.
      for (let i = 0; i < 100; i++) {
        if ((await run(["capture-pane", "-p", "-t", `=${id}:`])).trim() !== "") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await run(["send-keys", "-t", `=${id}:`, "-l", "--", tmuxLiteral(text)]);
      await run(["send-keys", "-t", `=${id}:`, "Enter"]);
    } catch (err) {
      if (err instanceof TmuxError && err.missing) throw new ShellError(404, "Terminal not found");
      throw err;
    }
  }

  /** Ends the shell (its processes get SIGHUP from tmux). False when there was none. */
  async close(id: string): Promise<boolean> {
    for (const v of this.views) if (v.id === id) v.closedByUser = true;
    try {
      await this.tmux()(["kill-session", "-t", `=${id}`]);
    } catch (err) {
      if (err instanceof TmuxError && err.missing) return false;
      throw err;
    }
    this.opts.log?.(`shell: closed ${id}`);
    return true;
  }

  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    io: { readJson(req: http.IncomingMessage): Promise<unknown>; sendJson(res: http.ServerResponse, code: number, body: unknown): void },
  ): Promise<boolean> {
    const p = url.pathname;
    if (p !== "/api/shells" && !p.startsWith("/api/shells/")) return false;
    try {
      if (p === "/api/shells" && req.method === "GET") {
        const body: ShellListResponse = { shells: await this.list() };
        io.sendJson(res, 200, body);
        return true;
      }
      if (p === "/api/shells" && req.method === "POST") {
        const body = (await io.readJson(req)) as Partial<CreateShellRequest> | null;
        io.sendJson(res, 200, await this.create(body ?? {}));
        return true;
      }
      const id = p.slice("/api/shells/".length);
      if (req.method === "DELETE" && isShellId(id)) {
        if (!(await this.close(id))) io.sendJson(res, 404, { error: "Terminal not found" });
        else io.sendJson(res, 200, { ok: true });
        return true;
      }
      io.sendJson(res, 404, { error: "not found" });
      return true;
    } catch (err) {
      if (err instanceof ShellError) io.sendJson(res, err.status, { error: err.message });
      else if (err instanceof TmuxError) io.sendJson(res, 500, { error: `tmux: ${err.message}` });
      else throw err;
      return true;
    }
  }

  /** One view of one shell on an upgraded socket (`?id=&cols=&rows=`). */
  attach(ws: WebSocket, query: URLSearchParams): void {
    const id = query.get("id");
    const grid = shellGrid(query.get("cols"), query.get("rows"));
    if (!isShellId(id) || !grid) {
      sendFrame(ws, { type: "ended", reason: "error", message: "Invalid terminal request" });
      ws.close(1008);
      return;
    }
    const view: View = { ws, id, grid, pty: null, ready: false, pending: [], closedByUser: false, done: false, unanswered: false };
    this.views.add(view);
    ws.on("pong", () => (view.unanswered = false));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        if (view.pty && view.ready) view.pty.write(buf);
        else view.pending.push(buf);
        return;
      }
      const frame = parseShellClientFrame(String(data));
      if (frame?.type === "resize") {
        view.grid = { cols: frame.cols, rows: frame.rows };
        try {
          view.pty?.resize(frame.cols, frame.rows);
        } catch {
          // The tmux client already ended (the shell exited a moment ago): its pty is closed and the
          // ioctl fails with EBADF. The view ends through exited(); a throw here would take down the server.
        }
      }
    });
    const release = () => {
      if (view.done) return;
      view.done = true;
      this.views.delete(view);
      view.pty?.kill();
    };
    ws.on("close", release);
    ws.on("error", release);
    void this.start(view).catch((err: unknown) => {
      this.opts.log?.(`shell: attach ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.end(view, { type: "ended", reason: "error", message: err instanceof Error ? err.message : String(err) });
    });
  }

  private async start(view: View): Promise<void> {
    const run = this.tmux();
    const info = await this.get(view.id);
    if (view.done) return;
    if (!info) return this.end(view, { type: "ended", reason: "missing" });
    // The scrollback first, then the client: a few lines that scroll off in between are in neither
    // (the screen tmux draws on attach has them).
    let capture = "";
    try {
      // With no history, `-E -1` clamps to the screen's first row, which the attach draws anyway.
      const historySize = Number((await run(["display-message", "-p", "-t", `=${view.id}:`, "#{history_size}"])).trim());
      if (historySize > 0) capture = await run(["capture-pane", "-p", "-e", "-J", "-S", "-", "-E", "-1", "-t", `=${view.id}:`]);
    } catch (err) {
      if (err instanceof TmuxError && err.missing) return this.end(view, { type: "ended", reason: "missing" });
      throw err;
    }
    if (view.done) return;
    sendFrame(view.ws, { type: "attached", shell: { ...info, clients: info.clients + 1 } });
    const prelude = historyPrelude(capture, view.grid.rows);
    if (prelude) view.ws.send(Buffer.from(prelude, "utf8"), { binary: true });
    this.spawner ??= nodePtySpawn();
    const tmux = this.opts.tmux!;
    // `-f /dev/null` here too: attach-session starts a server when there is none (the last shell
    // ended in between), and that server must not read the user's ~/.tmux.conf.
    const pty = this.spawner(tmux, ["-u", "-S", `./${path.basename(this.opts.socket)}`, "-f", "/dev/null", "attach-session", "-t", `=${view.id}`], {
      name: "xterm-256color",
      cols: view.grid.cols,
      rows: view.grid.rows,
      cwd: path.dirname(this.opts.socket),
      env: { ...this.env, TERM: "xterm-256color" },
      encoding: null,
    });
    view.pty = pty;
    let paused = false;
    let drain: ReturnType<typeof setInterval> | null = null;
    let tail = "";
    pty.onData((d: string | Buffer) => {
      const buf = typeof d === "string" ? Buffer.from(d, "utf8") : d;
      if (!view.ready) {
        view.ready = true;
        for (const input of view.pending.splice(0)) pty.write(input);
      }
      // The last output, for the message when the client fails (exited()).
      tail = (tail + buf.toString("utf8")).slice(-2000);
      if (view.ws.readyState !== view.ws.OPEN) return;
      view.ws.send(buf, { binary: true });
      if (!paused && view.ws.bufferedAmount > PAUSE_ABOVE) {
        paused = true;
        pty.pause();
        drain = setInterval(() => {
          if (view.done || view.ws.bufferedAmount < RESUME_BELOW) {
            paused = false;
            if (drain) clearInterval(drain);
            drain = null;
            if (!view.done) pty.resume();
          }
        }, 20);
      }
    });
    pty.onExit(({ exitCode }) => {
      if (drain) clearInterval(drain);
      void this.exited(view, exitCode, tail);
    });
    if (view.done) pty.kill();
  }

  /** The view's tmux client ended: say why, unless this side ended it. */
  private async exited(view: View, exitCode: number, tail: string): Promise<void> {
    if (view.done) return;
    if (view.closedByUser) return this.end(view, { type: "ended", reason: "closed" });
    let alive: boolean;
    try {
      alive = (await this.get(view.id)) !== null;
    } catch {
      alive = false;
    }
    if (!alive) return this.end(view, { type: "ended", reason: view.closedByUser ? "closed" : "exited" });
    // The shell runs on but this client ended: a detach from elsewhere, or a client that failed.
    // A failure is said; otherwise the socket closes and the page attaches again.
    if (exitCode !== 0) return this.end(view, { type: "ended", reason: "error", message: tail.trim() || `tmux exit ${exitCode}` });
    view.done = true;
    this.views.delete(view);
    view.ws.close(1012, "attach again");
  }

  private end(view: View, frame: ShellServerFrame): void {
    if (view.done && view.ws.readyState !== view.ws.OPEN) return;
    view.done = true;
    this.views.delete(view);
    view.pty?.kill();
    sendFrame(view.ws, frame);
    view.ws.close(1000);
  }

  /** Ends every attached client (the shells keep running) and the pinger. */
  shutdown(): void {
    clearInterval(this.pinger);
    for (const v of [...this.views]) {
      v.done = true;
      v.pty?.kill();
      v.ws.terminate();
    }
    this.views.clear();
  }
}

function sendFrame(ws: WebSocket, frame: ShellServerFrame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}
