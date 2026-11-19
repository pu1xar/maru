// The lean windows (DESIGN.md 6x, 2e): one session per window, the server's same web page in its
// lean form (`/?s=<id>&window=lean`: the conversation with its header and the composer). Each has
// the main window's preload, sandbox and session (so the same device token), and each remembers its
// own size and place (leanState.ts). The main process holds the list (session key to window) and
// tells every page of the app when it changes; an app that is started again opens none of them.
import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, nativeTheme, screen, type Session, type WebFrameMain } from "electron";
import { PAGE_BACKGROUND, TOPBAR_PX, backgroundColor, macButtonPosition, overlayOptions, titleBarOptions } from "./chrome.ts";
import { LEAN_MIN_SIZE, leanBounds, parseLeanStates, type LeanRequest, type LeanStates } from "./leanState.ts";
import { SAVE_DELAY_MS } from "./windowState.ts";

export interface LeanWindowsOptions {
  session: Session;
  preload: string;
  preloadArgs: string[];
  stateFile: string;
  /** The main window's link rules and context menu apply to a lean window too. */
  guard: (wc: Electron.WebContents) => void;
  contextMenu: (win: BrowserWindow, params: Electron.ContextMenuParams) => void;
  /** A window opened: follows its moves (splitDrag.ts); returns what to call when it closes. */
  track?: (win: BrowserWindow) => () => void;
  /** The list of open windows changed. */
  onChange: () => void;
  log: (line: string) => void;
}

interface Entry {
  key: string;
  win: BrowserWindow;
  chrome: { topbar: number; dark: boolean } | null;
  saveTimer: NodeJS.Timeout | null;
}

export class LeanWindows {
  private opts: LeanWindowsOptions;
  private entries = new Map<string, Entry>();

  constructor(opts: LeanWindowsOptions) {
    this.opts = opts;
  }

  list(): { id: string; key: string }[] {
    return [...this.entries].map(([id, e]) => ({ id, key: e.key }));
  }

  /** The lean window whose page the frame is, or null. */
  ofFrame(frame: WebFrameMain | null): Entry | null {
    if (!frame) return null;
    for (const e of this.entries.values()) if (!e.win.isDestroyed() && e.win.webContents.mainFrame === frame) return e;
    return null;
  }

  /** The session key of a lean window. */
  keyOf(win: BrowserWindow): string | null {
    for (const e of this.entries.values()) if (e.win === win) return e.key;
    return null;
  }

  windows(): BrowserWindow[] {
    return [...this.entries.values()].map((e) => e.win).filter((w) => !w.isDestroyed());
  }

  /** Opens the session's lean window, or brings the one it has forward. */
  open(req: LeanRequest): void {
    if (this.focus(req.key)) return;
    const saved = parseLeanStates(readFile(this.opts.stateFile))[req.key] ?? null;
    const bounds = leanBounds(saved, req.at, screen.getAllDisplays().map((d) => d.workArea));
    const dark = nativeTheme.shouldUseDarkColors;
    const win = new BrowserWindow({
      ...bounds,
      minWidth: LEAN_MIN_SIZE.width,
      minHeight: LEAN_MIN_SIZE.height,
      show: false,
      autoHideMenuBar: true,
      title: "maru",
      ...titleBarOptions(process.platform, dark, TOPBAR_PX),
      backgroundColor: backgroundColor(false, dark),
      webPreferences: {
        session: this.opts.session,
        preload: this.opts.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        additionalArguments: this.opts.preloadArgs,
      },
    });
    const id = String(win.id);
    const entry: Entry = { key: req.key, win, chrome: null, saveTimer: null };
    this.entries.set(id, entry);
    win.once("ready-to-show", () => {
      if (process.env.MARU_DESKTOP_SHOW_INACTIVE) win.showInactive();
      else win.show();
    });
    win.on("enter-full-screen", () => win.webContents.send("maru:window-state", { fullscreen: true }));
    win.on("leave-full-screen", () => {
      win.webContents.send("maru:window-state", { fullscreen: false });
      if (process.platform === "darwin" && entry.chrome) win.setWindowButtonPosition(macButtonPosition(entry.chrome.topbar));
    });
    const save = () => {
      if (entry.saveTimer) clearTimeout(entry.saveTimer);
      entry.saveTimer = setTimeout(() => this.saveNow(entry), SAVE_DELAY_MS);
    };
    const untrack = this.opts.track?.(win);
    win.on("resize", save);
    win.on("move", save);
    win.on("close", () => this.saveNow(entry));
    win.on("closed", () => {
      if (entry.saveTimer) clearTimeout(entry.saveTimer);
      untrack?.();
      this.entries.delete(id);
      this.opts.onChange();
    });
    win.webContents.on("render-process-gone", (_e, details) => {
      this.opts.log(`lean window: renderer gone (${details.reason})`);
      if (details.reason !== "clean-exit" && !win.isDestroyed()) win.webContents.reload();
    });
    win.webContents.on("context-menu", (_e, params) => this.opts.contextMenu(win, params));
    this.opts.guard(win.webContents);
    void win.loadURL(req.url).catch(() => {
      // did-fail-load below logs it; the window stays for the user to close.
    });
    win.webContents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.opts.log(`lean window: load failed ${code} ${description} ${url}`);
    });
    this.opts.onChange();
  }

  /** Brings the session's lean window forward; false when it has none. */
  focus(key: string): boolean {
    for (const e of this.entries.values()) {
      if (e.key !== key || e.win.isDestroyed()) continue;
      if (e.win.isMinimized()) e.win.restore();
      if (!e.win.isVisible()) e.win.show();
      e.win.focus();
      return true;
    }
    return false;
  }

  /** The page's top bar height and theme (preload): the traffic lights or the overlay follow them. */
  setChrome(entry: Entry, next: { topbar: number; dark: boolean }): void {
    const win = entry.win;
    if (win.isDestroyed() || !Number.isFinite(next.topbar) || next.topbar < 20 || next.topbar > 200) return;
    entry.chrome = { topbar: next.topbar, dark: !!next.dark };
    if (process.platform === "darwin" && !win.isFullScreen()) win.setWindowButtonPosition(macButtonPosition(next.topbar));
    if (process.platform === "win32") win.setTitleBarOverlay(overlayOptions(entry.chrome.dark, next.topbar));
    win.setBackgroundColor(entry.chrome.dark ? PAGE_BACKGROUND.dark : PAGE_BACKGROUND.light);
  }

  closeAll(): void {
    for (const w of this.windows()) w.close();
  }

  saveNow(entry: Entry): void {
    if (entry.saveTimer) clearTimeout(entry.saveTimer);
    entry.saveTimer = null;
    const win = entry.win;
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    try {
      const states: LeanStates = parseLeanStates(readFile(this.opts.stateFile));
      states[entry.key] = win.getNormalBounds();
      fs.mkdirSync(path.dirname(this.opts.stateFile), { recursive: true });
      fs.writeFileSync(`${this.opts.stateFile}.tmp`, JSON.stringify(states));
      fs.renameSync(`${this.opts.stateFile}.tmp`, this.opts.stateFile);
    } catch (e) {
      this.opts.log(`lean window: could not save its place: ${String(e)}`);
    }
  }
}

function readFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
