// The app's one window (DESIGN.md 2e), after T3 Code's DesktopWindow.ts: sandboxed, context
// isolated, no Node in the page, a preload with a narrow bridge; shown at ready-to-show; place and
// size kept across launches; links outside the server go to the default browser.
//
// It shows one of three things:
//   app      the paired server's own web page (`<server>/`), every request carrying the device
//            token (auth.ts), so a web deploy is an app update
//   pair     the local pairing screen (maru-app://shell/pair.html)
//   offline  the local "server not reachable" screen, which retries
import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, Menu, clipboard, nativeTheme, screen, shell, type Session, type WebContents } from "electron";
import { PAGE_BACKGROUND, TOPBAR_PX, backdropOptions, backgroundColor, macButtonPosition, overlayOptions, titleBarOptions } from "./chrome.ts";
import { linkTarget, isServerUrl } from "./links.ts";
import { DEFAULT_SIZE, MIN_SIZE, SAVE_DELAY_MS, parseWindowState, restorableBounds, type WindowState } from "./windowState.ts";

export type ShellPage = "pair" | "offline";

export interface MainWindowOptions {
  session: Session;
  preload: string;
  stateFile: string;
  /** Extra argv for the preload (`--maru-version=...`): a sandboxed preload cannot ask the app. */
  preloadArgs: string[];
  shellUrl: (page: ShellPage) => string;
  /** The paired server's origin, or null. */
  server: () => string | null;
  /** The server answered a page request with this status (401: maybe revoked; 5xx: down). */
  onServerStatus: (status: number) => void;
  /** The server's page failed to load at all (no network, refused, TLS). */
  onLoadFailed: (error: string) => void;
  /** Whether the window starts with the see-through backdrop (the page's last choice, chrome.ts). */
  translucent: boolean;
  log: (line: string) => void;
}

const BACKGROUND = PAGE_BACKGROUND;

export class MainWindow {
  win: BrowserWindow | null = null;
  private opts: MainWindowOptions;
  private saveTimer: NodeJS.Timeout | null = null;
  /** What the window shows now. */
  showing: "app" | ShellPage | null = null;
  /** The status of the last app page load: a page that is an error answer is not shown. */
  private holdShow = false;
  /** What the page last reported (preload): its top bar in window points, and its theme. */
  private chrome: { topbar: number; dark: boolean } | null = null;
  private translucent: boolean;

  constructor(opts: MainWindowOptions) {
    this.opts = opts;
    this.translucent = opts.translucent;
  }

  private dark(): boolean {
    return this.chrome?.dark ?? nativeTheme.shouldUseDarkColors;
  }

  /** The page's top bar height and theme (preload): the traffic lights or the overlay follow them. */
  setChrome(next: { topbar: number; dark: boolean }): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !Number.isFinite(next.topbar) || next.topbar < 20 || next.topbar > 200) return;
    this.chrome = { topbar: next.topbar, dark: !!next.dark };
    // The vibrancy and acrylic materials follow the app's appearance, not the page: with the system
    // in light mode, a light material behind the dark page's see-through sidebar turned it from
    // #131313 to #282828 and its 8% white divider nearly white (measured 2026-11-16).
    nativeTheme.themeSource = this.chrome.dark ? "dark" : "light";
    if (process.platform === "darwin" && !win.isFullScreen()) win.setWindowButtonPosition(macButtonPosition(next.topbar));
    if (process.platform === "win32") win.setTitleBarOverlay(overlayOptions(this.chrome.dark, next.topbar));
    if (!this.translucent) win.setBackgroundColor(backgroundColor(false, this.chrome.dark));
  }

  /** The see-through backdrop on or off (the page's 창 배경 setting). */
  setBackdrop(translucent: boolean): void {
    this.translucent = translucent;
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (process.platform === "darwin") win.setVibrancy(translucent ? "sidebar" : null);
    if (process.platform === "win32") win.setBackgroundMaterial(translucent ? "acrylic" : "none");
    win.setBackgroundColor(backgroundColor(translucent && process.platform !== "linux", this.dark()));
  }

  isFullScreen(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isFullScreen();
  }

  create(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const saved = readState(this.opts.stateFile);
    const bounds = restorableBounds(saved, screen.getAllDisplays().map((d) => d.workArea));
    const win = new BrowserWindow({
      ...(bounds ?? DEFAULT_SIZE),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      autoHideMenuBar: true,
      title: "maru",
      ...titleBarOptions(process.platform, this.dark(), this.chrome?.topbar ?? TOPBAR_PX),
      ...backdropOptions(process.platform, this.translucent, this.dark()),
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
    this.win = win;
    win.once("ready-to-show", () => {
      if (this.holdShow) return;
      if (saved?.maximized && bounds) win.maximize();
      if (process.env.MARU_DESKTOP_SHOW_INACTIVE) win.showInactive();
      else win.show();
    });
    // Until the page reports its own theme, the window follows the system's.
    nativeTheme.on("updated", () => {
      if (!win.isDestroyed() && !this.chrome) win.setBackgroundColor(backgroundColor(this.translucent && process.platform !== "linux", this.dark()));
    });
    // Full screen hides the traffic lights, so the page drops the space it keeps for them.
    win.on("enter-full-screen", () => this.send("maru:window-state", { fullscreen: true }));
    win.on("leave-full-screen", () => {
      this.send("maru:window-state", { fullscreen: false });
      if (process.platform === "darwin" && this.chrome) win.setWindowButtonPosition(macButtonPosition(this.chrome.topbar));
    });
    const save = () => this.scheduleSave();
    win.on("resize", save);
    win.on("move", save);
    win.on("maximize", save);
    win.on("unmaximize", save);
    win.on("close", () => this.saveNow());
    win.on("closed", () => {
      this.win = null;
      this.showing = null;
    });
    this.guard(win.webContents);
    win.webContents.on("did-create-window", (child) => this.guard(child.webContents));
    win.webContents.on("did-navigate", (_e, url, status) => {
      if (this.showing !== "app" || !isServerUrl(url, this.opts.server())) return;
      if (status === 401 || status >= 500) {
        this.holdShow = true;
        this.opts.onServerStatus(status);
      }
    });
    win.webContents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
      // -3 is an aborted load: the next navigation replaced it.
      if (!isMainFrame || code === -3 || this.showing !== "app") return;
      this.opts.log(`window: load failed ${code} ${description} ${url}`);
      this.opts.onLoadFailed(`${description} (${code})`);
    });
    win.webContents.on("render-process-gone", (_e, details) => {
      this.opts.log(`window: renderer gone (${details.reason})`);
      if (details.reason !== "clean-exit" && !win.isDestroyed()) win.webContents.reload();
    });
    win.webContents.on("context-menu", (_e, params) => this.contextMenu(win, params));
    return win;
  }

  /** The server's page. */
  showApp(server: string): void {
    const win = this.create();
    this.showing = "app";
    this.holdShow = false;
    void win.loadURL(`${server}/`).catch(() => {
      // did-fail-load reports it.
    });
  }

  showShell(page: ShellPage): void {
    const win = this.create();
    this.showing = page;
    this.holdShow = false;
    void win.loadURL(this.opts.shellUrl(page)).then(() => {
      if (win.isVisible()) return;
      if (process.env.MARU_DESKTOP_SHOW_INACTIVE) win.showInactive();
      else win.show();
    });
  }

  /** Brings the window up (a second launch, a deep link, the Dock icon). */
  focus(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  }

  /** The web settings' route, the way the page itself enters it (settingsRoute.ts), without a reload. */
  openSettings(): void {
    if (this.showing !== "app" || !this.win) return;
    void this.win.webContents.executeJavaScript(
      `(() => { const u = new URL(location.href); u.searchParams.set("view", "settings");`
        + ` history.pushState(history.state, "", u); dispatchEvent(new PopStateEvent("popstate", { state: history.state })); })()`,
    );
  }

  send(channel: string, value: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, value);
  }

  /** T3's link rules: the server's pages stay in the app, the web opens in the default browser. */
  guard(wc: WebContents): void {
    wc.setWindowOpenHandler(({ url }) => {
      const target = linkTarget(url, this.opts.server());
      if (target === "app") {
        // A file or an attachment in its own window: the same session adds the token, no preload.
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
            webPreferences: { session: this.opts.session, preload: undefined, contextIsolation: true, sandbox: true, nodeIntegration: false },
          },
        };
      }
      if (target === "browser") void shell.openExternal(url);
      return { action: "deny" };
    });
    wc.on("will-navigate", (e, url) => {
      const here = wc.getURL();
      const shellPage = here.startsWith("maru-app://");
      // The shell pages never navigate; the server's page may move within the server.
      if (!shellPage && linkTarget(url, this.opts.server()) === "app") return;
      e.preventDefault();
      if (linkTarget(url, this.opts.server()) === "browser") void shell.openExternal(url);
    });
    // will-navigate does not see a redirect: the server's page must not become another site's
    // page in the app's window (independent review, 2026-11-16).
    wc.on("will-redirect", (e, url, _inPlace, isMainFrame) => {
      if (!isMainFrame || linkTarget(url, this.opts.server()) === "app") return;
      e.preventDefault();
      this.opts.log(`window: refused a redirect to ${url}`);
      if (wc === this.win?.webContents && this.showing === "app") this.opts.onLoadFailed(`The server redirected to a different address: ${new URL(url).origin}`);
    });
    // Frames inside the page (the PDF preview) stay on the server or on a blank document.
    wc.on("will-frame-navigate", (e) => {
      if (e.isMainFrame || e.url === "about:blank" || e.url === "about:srcdoc" || linkTarget(e.url, this.opts.server()) === "app") return;
      e.preventDefault();
    });
  }

  contextMenu(win: BrowserWindow, params: Electron.ContextMenuParams): void {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (params.linkURL && linkTarget(params.linkURL, this.opts.server()) !== "drop") {
      items.push({ label: "Copy link", click: () => clipboard.writeText(params.linkURL) });
      items.push({ type: "separator" });
    }
    if (params.isEditable) {
      items.push({ role: "cut", label: "Cut", enabled: params.editFlags.canCut });
      items.push({ role: "copy", label: "Copy", enabled: params.editFlags.canCopy });
      items.push({ role: "paste", label: "Paste", enabled: params.editFlags.canPaste });
      items.push({ role: "selectAll", label: "Select all" });
    } else if (params.selectionText) {
      items.push({ role: "copy", label: "Copy" });
    }
    // The server's page names the element under the pointer itself (web lib/uiNameCopy.ts); the
    // menu only asks it to copy the name of the last right-clicked element.
    if (isServerUrl(win.webContents.getURL(), this.opts.server())) {
      if (items.length > 0) items.push({ type: "separator" });
      items.push({ label: "Copy UI name", click: () => win.webContents.send("maru:copy-ui-name") });
    }
    while (items.at(-1)?.type === "separator") items.pop();
    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: win });
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), SAVE_DELAY_MS);
  }

  saveNow(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const win = this.win;
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    // T3: a maximized or full screen window keeps its normal bounds for the next start.
    const state: WindowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
    try {
      fs.mkdirSync(path.dirname(this.opts.stateFile), { recursive: true });
      fs.writeFileSync(`${this.opts.stateFile}.tmp`, JSON.stringify(state));
      fs.renameSync(`${this.opts.stateFile}.tmp`, this.opts.stateFile);
    } catch (e) {
      this.opts.log(`window: could not save its place: ${String(e)}`);
    }
  }
}

function readState(file: string): WindowState | null {
  try {
    return parseWindowState(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
