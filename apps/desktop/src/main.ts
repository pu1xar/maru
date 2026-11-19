// The maru desktop app (DESIGN.md 2e): an Electron shell for Mac and Windows that shows the paired
// maru server's web page with a desktop device token. The page comes from the server on every
// start, so a web deploy is the app's screen update; the shell itself updates from a build the
// server hands out, signed on the Mac (updater.ts).
//
// Env (tests and development only):
//   MARU_DESKTOP_USER_DATA  the app's data folder instead of the OS default (pairing, window place,
//                           logs, downloaded updates); a second copy with its own folder runs beside
//                           the first
//   MARU_VERSION            the version an unpackaged run (`electron .`) reports
//   MARU_DESKTOP_SHOW_INACTIVE  show the window without taking focus (automated runs on a Mac in use)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, screen, session, type IpcMainInvokeEvent } from "electron";
import type { DesktopDevice } from "@maru/shared";
import { attachAuth } from "./auth.ts";
import { readLeanRequest } from "./leanState.ts";
import { LeanWindows } from "./leanWindows.ts";
import { DropReplies, SplitDragTracker, closesAfter, contentPoint } from "./splitDrag.ts";
import { isServerUrl } from "./links.ts";
import { menuTemplate } from "./menu.ts";
import { readPairingInput, readPairingLink, readServer } from "./pairingInput.ts";
import { createPairingStore, hasLegacyPairingFile } from "./pairingBackends.ts";
import type { Pairing } from "./pairingStore.ts";
import { checkSelf, claim, unpairSelf } from "./serverApi.ts";
import { Updater } from "./updater.ts";
import { MainWindow, type ShellPage } from "./window.ts";

const SHELL_SCHEME = "maru-app";
const LINK_SCHEME = "maru";
/** Defined by the bundle (scripts/bundle.ts) from scripts/builderConfig.ts APP_ID. */
declare const __MARU_APP_ID__: string | undefined;
const APP_ID = typeof __MARU_APP_ID__ === "string" ? __MARU_APP_ID__ : "dev.maru.desktop";
/** The phone app's reconnect pause (apps/mobile connection.ts): 1 s doubling to 15 s, no retry count. */
/** How long the main page has to place a dropped lean window (it may have to switch to the split view and measure it first). */
const SPLIT_DROP_WAIT_MS = 8000;
/** macOS: a lean window that has not moved for this long was let go (the OS reports no end of a window move). */
const SPLIT_DROP_IDLE_MS = 350;
const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 15_000;

/** What the local screens show (pages/*.js reads it through the preload). */
export type ShellState =
  | { page: "pair"; version: string; notice: string | null; prefill: { server: string; code: string } | null; paired: string | null }
  | { page: "offline"; version: string; server: string; error: string; retryAt: number | null };

if (process.env.MARU_DESKTOP_USER_DATA) app.setPath("userData", path.resolve(process.env.MARU_DESKTOP_USER_DATA));
// Chromium's own secret store ("maru Safe Storage" in the Mac login Keychain) is partitioned by the
// app's code hash and asks again after every update, so nothing here opens it: cookie encryption is
// fused off (builderConfig.ts) and this switch gives any other OSCrypt use a throwaway in-memory key.
// The one reader of the real item is the one-time move of an older pairing.bin (pairingStore.ts), so
// the switch is left off for that start only (DESIGN.md 2e).
if (process.platform === "darwin" && !hasLegacyPairingFile(app.getPath("userData"))) app.commandLine.appendSwitch("use-mock-keychain");
protocol.registerSchemesAsPrivileged([{ scheme: SHELL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// A released app does not open a debugging port: through it another program of this user could read
// the requests the window sends, the device token among them. The fuses (builderConfig.ts) close
// the Node inspector and ELECTRON_RUN_AS_NODE the same way. An unpackaged run keeps them for work.
const debugging = ["remote-debugging-port", "remote-debugging-pipe"].some((s) => app.commandLine.hasSwitch(s));
if (app.isPackaged && debugging) {
  process.stderr.write("maru: refusing to run with a remote debugging switch\n");
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) {
  // One app per user data folder (T3: the lock comes before ready). A second launch hands its deep
  // link to the first and quits.
  app.quit();
} else {
  start();
}

function start(): void {
  const userData = app.getPath("userData");
  const logFile = path.join(userData, "logs", "main.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = (line: string) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    process.stdout.write(text);
    fs.appendFileSync(logFile, text);
  };
  const version = app.isPackaged ? app.getVersion() : process.env.MARU_VERSION || "0.0.0-dev";

  // Deep links (maru://pair?...) can arrive before the app is ready: queue them (T3 DesktopClerk).
  const pending: string[] = [];
  let onLink: ((url: string) => void) | null = null;
  const takeLink = (url: string) => (onLink ? onLink(url) : pending.push(url));
  const linkIn = (argv: string[]) => argv.find((a) => a.startsWith(`${LINK_SCHEME}://`));
  app.on("open-url", (e, url) => {
    e.preventDefault();
    takeLink(url);
  });
  app.on("second-instance", (_e, argv) => {
    const link = linkIn(argv);
    if (link) takeLink(link);
    else win?.focus();
  });
  const first = linkIn(process.argv);
  if (first) pending.push(first);

  let win: MainWindow | null = null;

  void app.whenReady().then(() => {
    if (process.platform === "win32") app.setAppUserModelId(APP_ID);
    // On a Mac the bundle's Info.plist names the scheme; Windows learns it at run time.
    if (process.platform === "win32" && app.isPackaged) app.setAsDefaultProtocolClient(LINK_SCHEME);
    app.setAboutPanelOptions({ applicationName: app.getName(), applicationVersion: version, version: "" });

    const ses = session.fromPartition("persist:maru");
    const store = createPairingStore(userData);
    const appearanceFile = path.join(userData, "appearance.json");
    const loaded = store.load();
    let pairing: Pairing | null = loaded.pairing;
    let notice: string | null = loaded.error;
    let prefill: { server: string; code: string } | null = null;
    let offline: { error: string; retryAt: number | null; attempts: number } | null = null;
    let retryTimer: NodeJS.Timeout | null = null;
    if (loaded.error) log(`pairing: ${loaded.error}`);

    attachAuth(ses, { pairing: () => pairing, onUnauthorized: () => void verify() });

    // The local screens, served from the app's own files with a strict policy (T3 ElectronProtocol).
    const pagesDir = path.join(__dirname, "pages");
    const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
    ses.protocol.handle(SHELL_SCHEME, async (req) => {
      const url = new URL(req.url);
      const name = url.pathname.replace(/^\/+/, "");
      if (url.host !== "shell" || !/^[a-z0-9-]+\.(html|js|css|svg)$/.test(name)) return new Response("not found", { status: 404 });
      try {
        const body = await fs.promises.readFile(path.join(pagesDir, name));
        return new Response(body, {
          headers: {
            "content-type": TYPES[path.extname(name)]!,
            "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          },
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    });

    const updater = new Updater({
      session: ses,
      pairing: () => pairing,
      certificate: readCertificate(),
      dir: path.join(userData, "updates"),
      version,
      log,
    });

    const shellState = (): ShellState =>
      win?.showing === "offline" && pairing && offline
        ? { page: "offline", version, server: pairing.server, error: offline.error, retryAt: offline.retryAt }
        : { page: "pair", version, notice, prefill, paired: pairing?.server ?? null };

    const showShell = (page: ShellPage) => {
      if (win!.showing === page) win!.send("shell:state", shellState());
      else win!.showShell(page);
    };

    const showPair = () => {
      clearRetry();
      offline = null;
      showShell("pair");
    };

    const connect = () => {
      clearRetry();
      if (!pairing) return showPair();
      offline = null;
      win!.showApp(pairing.server);
    };

    const clearRetry = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    };

    // Not reachable: the offline screen, and a probe with a growing pause until the server answers.
    // The probe is the device's self check, so a removed device goes to pairing, not to a loop.
    const goOffline = (error: string) => {
      if (!pairing) return showPair();
      clearRetry();
      const attempts = (offline?.attempts ?? 0) + 1;
      const pause = Math.min(MIN_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS);
      offline = { error, retryAt: Date.now() + pause, attempts };
      log(`offline: ${error}; next try in ${pause} ms`);
      showShell("offline");
      retryTimer = setTimeout(() => void probe(), pause);
    };

    const probe = async () => {
      clearRetry();
      if (!pairing) return showPair();
      if (offline) {
        offline = { ...offline, retryAt: null };
        win!.send("shell:state", shellState());
      }
      const r = await checkSelf(ses, pairing);
      if (r === "ok") {
        offline = null;
        connect();
      } else if (r === "revoked") revoked();
      else goOffline(r.error);
    };

    const revoked = () => {
      log("pairing: the server no longer knows this device");
      store.clear();
      pairing = null;
      lean.closeAll();
      notice = "The server disconnected this device. Connect again from the web app";
      showPair();
    };

    // A 401 on a page request or a failed WebSocket: ask the server once whether the device is
    // still paired. Only a clear "not paired" leaves the page. A server that does not answer (a
    // deploy restarts it for a few seconds) leaves the loaded page as it is: the page reconnects on
    // its own and offers the reload when the server's version changed (VersionNotice). Going to the
    // offline screen there threw the page away and reloaded the new version unasked (user report
    // 2026-11-17: "Connection reset" and an update without a click on every deploy).
    let verifying = false;
    async function verify(): Promise<void> {
      if (verifying || !pairing) return;
      verifying = true;
      try {
        const r = await checkSelf(ses, pairing);
        if (r === "revoked") revoked();
        else if (r !== "ok") log(`pairing: check not answered (${r.error}); the page reconnects on its own`);
      } finally {
        verifying = false;
      }
    }

    const doPair = async (serverText: string, codeText: string): Promise<{ ok: true } | { error: string }> => {
      const target = readPairingInput(String(serverText ?? ""), String(codeText ?? ""));
      if ("error" in target) return target;
      try {
        const res = await claim(ses, target, deviceName());
        const old = pairing;
        const next: Pairing = { server: target.server, token: res.token, device: res.device };
        store.save(next);
        pairing = next;
        notice = null;
        prefill = null;
        log(`pairing: paired as ${res.device.id} (${res.device.name}) with ${target.server}`);
        // A pairing it replaces is ended on its server, as far as that server answers.
        if (old) void unpairSelf(ses, old).catch((e: unknown) => log(`pairing: could not end the old pairing: ${String(e)}`));
        connect();
        void updater.check();
        return { ok: true };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    };

    const unpair = async (opts: { confirm: boolean }) => {
      const p = pairing;
      if (!p) return showPair();
      if (opts.confirm) {
        const r = await dialog.showMessageBox(win!.win!, {
          type: "warning",
          buttons: ["Disconnect", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          message: "Disconnect this device?",
          detail: `This removes the token for this device (${p.device.name}) from ${p.server}. To use it again, connect again from the web app`,
        });
        if (r.response !== 0) return;
      }
      try {
        await unpairSelf(ses, p);
      } catch (e) {
        log(`pairing: the server did not take the unpairing: ${String(e)}`);
      }
      store.clear();
      pairing = null;
      lean.closeAll();
      notice = "Disconnected";
      showPair();
    };

    // A pairing link: fills the pairing screen, and the user presses 연결. A link never pairs on its
    // own, so a link from somewhere else cannot point the app at another server unseen.
    onLink = (url: string) => {
      const link = readPairingLink(url);
      win?.focus();
      if (!link) return;
      // What the screen and the question show is the origin the app would talk to, rebuilt from
      // checked parts; a link whose server does not pass is shown as typed, with the reason.
      const server = readServer(link.server);
      const shown = "server" in server ? server.server : link.server;
      void (async () => {
        if (pairing) {
          const r = await dialog.showMessageBox(win!.win!, {
            type: "question",
            buttons: ["Connect new", "Cancel"],
            defaultId: 1,
            cancelId: 1,
            message: "A server is already connected",
            detail: `Current: ${pairing.server}\nLink: ${shown}\nChoose Connect new to fill the connect screen with the link. The current connection is replaced when the new one finishes`,
          });
          if (r.response !== 0) return;
        }
        prefill = { server: shown, code: link.code };
        notice = "error" in server ? server.error : "Filled in from the link. Check the server address, then press Connect";
        showPair();
      })();
    };

    const restartToUpdate = () => {
      if (updater.install(true)) app.quit();
    };

    const askRestart = async (v: string) => {
      const r = await dialog.showMessageBox(win!.win!, {
        type: "info",
        buttons: ["Restart", "Later"],
        defaultId: 0,
        cancelId: 1,
        message: `Downloaded maru ${v}`,
        detail: "If you choose Later, the downloaded version is kept and installed when you restart from the sidebar or the Devices tab",
      });
      if (r.response === 0) restartToUpdate();
    };

    // The menu's check (T3 DesktopApplicationMenu): a dialog says the result; the page shows a
    // build that is ready on its own.
    const menuCheck = async () => {
      const before = updater.state();
      if (before.status === "disabled") {
        await dialog.showMessageBox(win!.win!, { type: "info", message: "Automatic updates are not available", detail: before.reason });
        return;
      }
      if (before.status === "downloaded") return askRestart(before.version);
      const s = await updater.check();
      if (s.status === "up-to-date") await dialog.showMessageBox(win!.win!, { type: "info", message: "You are up to date", detail: `maru ${version}` });
      else if (s.status === "error") await dialog.showMessageBox(win!.win!, { type: "error", message: "Could not check for updates", detail: s.message });
      else if (s.status === "downloaded") await askRestart(s.version);
      else if (!pairing) await dialog.showMessageBox(win!.win!, { type: "info", message: "Could not check because no server is connected" });
    };

    // The lean windows (leanWindows.ts, DESIGN.md 6x): the session's page in a window of its own.
    // Every page of the app hears the list when it changes, the main window's among them.
    const pushLean = () => {
      const list = lean.list();
      for (const w of [win?.win, ...lean.windows()]) if (w && !w.isDestroyed()) w.webContents.send("maru:lean-windows", list);
    };
    const lean: LeanWindows = new LeanWindows({
      session: ses,
      preload: path.join(__dirname, "preload.cjs"),
      preloadArgs: [`--maru-version=${version}`],
      stateFile: path.join(userData, "lean-windows.json"),
      guard: (wc) => win?.guard(wc),
      contextMenu: (w, params) => win?.contextMenu(w, params),
      track: (w) => trackSplitDrag(w),
      onChange: pushLean,
      log,
    });
    // A lean window moved over the main window goes back into its split view (splitDrag.ts, DESIGN.md
    // 6x). The cursor over the main page is sent to it for the drop preview; letting go there asks
    // the page to place the session, and the window closes when it did. Linux gives no end of a
    // move, so the window is only a window there.
    const dropReplies = new DropReplies();
    /** The main page's client pixels under a screen point, or null when the main window is not showing the app there. */
    const mainPoint = (cursor: { x: number; y: number }) => {
      const m = win?.win;
      if (!m || m.isDestroyed() || !m.isVisible() || m.isMinimized() || win?.showing !== "app") return null;
      return contentPoint(cursor, m.getContentBounds(), m.webContents.getZoomFactor());
    };
    const trackSplitDrag = (leanWin: BrowserWindow): (() => void) => {
      if (process.platform !== "darwin" && process.platform !== "win32") return () => {};
      const tracker = new SplitDragTracker({
        cursor: () => screen.getCursorScreenPoint(),
        windowBounds: () => leanWin.getBounds(),
        mainPoint,
        preview: (p) => {
          const target = win?.win;
          const key = lean.keyOf(leanWin);
          if (target && !target.isDestroyed()) target.webContents.send("maru:split-drag", p && key ? { key, x: p.x, y: p.y } : null);
        },
        drop: (p) => {
          const target = win?.win;
          const key = lean.keyOf(leanWin);
          if (!target || target.isDestroyed() || !key) return;
          void dropReplies.ask((id) => target.webContents.send("maru:split-drop", { id, key, x: p.x, y: p.y }), SPLIT_DROP_WAIT_MS).then((outcome) => {
            if (!closesAfter(outcome)) return;
            win?.focus();
            if (!leanWin.isDestroyed()) leanWin.close();
          });
        },
        // macOS reports `moved` as `move` and has no end of a move: the window stopping is the end.
        idleMs: process.platform === "darwin" ? SPLIT_DROP_IDLE_MS : null,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
      });
      leanWin.on("move", () => tracker.moved());
      if (process.platform === "win32") leanWin.on("moved", () => tracker.ended());
      return () => tracker.dispose();
    };
    /** The app window with the keyboard: a lean window, else the main one. */
    const focusedWindow = (): BrowserWindow | null => {
      const f = BrowserWindow.getFocusedWindow();
      if (f && lean.windows().includes(f)) return f;
      return win?.win && !win.win.isDestroyed() ? win.win : null;
    };
    // One step of the page zoom, what the zoomIn and zoomOut menu roles do (0.5 zoom level).
    const zoomPage = (direction: 1 | -1, target?: Electron.WebContents) => {
      const wc = target ?? (win?.win && !win.win.isDestroyed() ? win.win.webContents : null);
      if (wc) wc.setZoomLevel(wc.getZoomLevel() + direction * 0.5);
    };
    // Keep on top (the lean window's pin and the Window menu's item): the window and the page hear it.
    const syncKeepOnTopItem = () => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("keep-on-top");
      const w = BrowserWindow.getFocusedWindow();
      if (!item) return;
      item.enabled = !!w && lean.windows().includes(w);
      item.checked = !!w && !w.isDestroyed() && w.isAlwaysOnTop();
    };
    const setKeepOnTop = (w: BrowserWindow, on: boolean): boolean => {
      w.setAlwaysOnTop(on, "floating");
      w.webContents.send("maru:keep-on-top", on);
      syncKeepOnTopItem();
      return on;
    };
    app.on("browser-window-focus", syncKeepOnTopItem);

    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(process.platform, app.getName(), {
      checkForUpdates: () => void menuCheck(),
      closeWindow: () => (BrowserWindow.getFocusedWindow() ?? win?.win)?.close(),
      openSettings: () => win?.openSettings(),
      unpair: () => void unpair({ confirm: true }),
      // The server's page chooses what grows (the area under the pointer, else the page); a local
      // screen (pairing, offline) has no such page, so it zooms whole as the menu roles did.
      zoom: (direction) => {
        const w = focusedWindow();
        if (!w) return;
        if (w !== win?.win || win.showing === "app") w.webContents.send("maru:zoom-shortcut", direction);
        else zoomPage(direction);
      },
      toggleKeepOnTop: () => {
        const w = BrowserWindow.getFocusedWindow();
        if (w && lean.windows().includes(w)) setKeepOnTop(w, !w.isAlwaysOnTop());
        else syncKeepOnTopItem();
      },
    })));

    // IPC: the page's bridge answers only the server's page in the main window; the shell calls
    // answer only the local screens (T3 DesktopIpc: the main window's main frame alone).
    // The server's page in the main window or in a lean window: the same sender check for both.
    const fromApp = (e: IpcMainInvokeEvent) => {
      const frame = e.senderFrame;
      const inApp = !!frame && ((!!win?.win && frame === win.win.webContents.mainFrame) || lean.ofFrame(frame) !== null);
      const ok = inApp && !!pairing && isServerUrl(frame!.url, pairing.server);
      if (!ok) throw new Error("not allowed");
      return pairing!;
    };
    /** The window the page that asked is in (call after fromApp). */
    const windowOf = (e: IpcMainInvokeEvent): BrowserWindow | null => lean.ofFrame(e.senderFrame)?.win ?? win?.win ?? null;
    const fromShell = (e: IpcMainInvokeEvent) => {
      const ok = !!win?.win && e.senderFrame === win.win.webContents.mainFrame && e.senderFrame.url.startsWith(`${SHELL_SCHEME}://shell/`);
      if (!ok) throw new Error("not allowed");
    };
    ipcMain.handle("maru:device", (e): DesktopDevice => {
      const p = fromApp(e);
      return { id: p.device.id, name: p.device.name, server: p.server };
    });
    ipcMain.handle("maru:update-state", (e) => (fromApp(e), updater.state()));
    ipcMain.handle("maru:update-check", (e) => (fromApp(e), updater.check()));
    // The page's 다시 시작 (sidebar pill, 기기 tab) asks first: the pill appears when a build arrives,
    // and a click meant for what was under it restarted the app (user report 2026-11-17).
    ipcMain.handle("maru:update-install", async (e) => {
      fromApp(e);
      const s = updater.state();
      if (s.status === "downloaded") await askRestart(s.version);
    });
    ipcMain.handle("maru:unpair", async (e) => {
      fromApp(e);
      await unpair({ confirm: false });
    });
    ipcMain.handle("shell:state", (e) => (fromShell(e), shellState()));
    ipcMain.handle("shell:pair", (e, server: unknown, code: unknown) => (fromShell(e), doPair(String(server ?? ""), String(code ?? ""))));
    ipcMain.handle("shell:retry", (e) => {
      fromShell(e);
      void probe();
    });
    ipcMain.handle("shell:reset", async (e) => {
      fromShell(e);
      await unpair({ confirm: true });
    });
    updater.onState((s) => {
      if (win?.showing === "app") win.send("maru:update-state", s);
    });
    // The window's chrome (chrome.ts): any page of the main window reports its top bar and theme
    // and asks whether the window is full screen; only the server's page sets the backdrop.
    const fromWindow = (e: Electron.IpcMainEvent | IpcMainInvokeEvent) =>
      !!win?.win && e.senderFrame === win.win.webContents.mainFrame
      && (e.senderFrame.url.startsWith(`${SHELL_SCHEME}://shell/`) || (!!pairing && isServerUrl(e.senderFrame.url, pairing.server)));
    const leanFromWindow = (e: Electron.IpcMainEvent | IpcMainInvokeEvent) => {
      const entry = lean.ofFrame(e.senderFrame);
      return entry && !!pairing && isServerUrl(e.senderFrame!.url, pairing.server) ? entry : null;
    };
    ipcMain.on("maru:chrome", (e, v: { topbar?: unknown; dark?: unknown }) => {
      const report = { topbar: Number(v?.topbar), dark: v?.dark === true };
      const entry = leanFromWindow(e);
      if (entry) lean.setChrome(entry, report);
      else if (fromWindow(e)) win?.setChrome(report);
    });
    ipcMain.handle("maru:window-state", (e) => {
      const entry = leanFromWindow(e);
      if (entry) return { fullscreen: entry.win.isFullScreen() };
      if (!fromWindow(e)) throw new Error("not allowed");
      return { fullscreen: win?.isFullScreen() ?? false };
    });
    ipcMain.handle("maru:zoom-page", (e, direction: unknown) => {
      fromApp(e);
      zoomPage(direction === -1 ? -1 : 1, e.sender);
    });
    ipcMain.handle("maru:copy-text", (e, text: unknown) => {
      fromApp(e);
      if (typeof text !== "string") throw new Error("copy-text: text must be a string");
      clipboard.writeText(text);
    });
    ipcMain.handle("maru:lean-open", (e, raw: unknown) => {
      const p = fromApp(e);
      const request = readLeanRequest(raw, p.server);
      if (!request) throw new Error("not allowed");
      lean.open(request);
    });
    // The main page's answer to a lean window let go over it.
    ipcMain.handle("maru:split-drop-result", (e, id: unknown, outcome: unknown) => {
      fromApp(e);
      if (!win?.win || e.senderFrame !== win.win.webContents.mainFrame) throw new Error("not allowed");
      if (typeof id !== "string" || typeof outcome !== "string") return false;
      return dropReplies.answer(id, outcome);
    });
    ipcMain.handle("maru:lean-focus", (e, key: unknown) => (fromApp(e), typeof key === "string" && lean.focus(key)));
    ipcMain.handle("maru:lean-windows", (e) => (fromApp(e), lean.list()));
    ipcMain.handle("maru:keep-on-top", (e) => {
      fromApp(e);
      return windowOf(e)?.isAlwaysOnTop() ?? false;
    });
    ipcMain.handle("maru:set-keep-on-top", (e, on: unknown) => {
      fromApp(e);
      const w = windowOf(e);
      return w ? setKeepOnTop(w, on === true) : false;
    });
    ipcMain.handle("maru:backdrop", (e, translucent: unknown) => {
      fromApp(e);
      const on = translucent === true;
      win?.setBackdrop(on);
      writeBackdrop(appearanceFile, on);
    });

    win = new MainWindow({
      session: ses,
      preload: path.join(__dirname, "preload.cjs"),
      stateFile: path.join(userData, "window-state.json"),
      preloadArgs: [`--maru-version=${version}`],
      shellUrl: (page) => `${SHELL_SCHEME}://shell/${page}.html`,
      server: () => pairing?.server ?? null,
      onServerStatus: (status) => {
        if (status === 401) void verify();
        else goOffline(`The server answered with HTTP ${status}`);
      },
      onLoadFailed: (error) => goOffline(error),
      translucent: readBackdrop(appearanceFile),
      log,
    });
    connect();
    for (const url of pending.splice(0)) onLink!(url);
    updater.start();

    app.on("activate", () => {
      if (!win!.win) connect();
      else win!.focus();
    });
    app.on("before-quit", () => win?.saveNow());
    syncKeepOnTopItem();
    // A downloaded build waits for the user's 다시 시작; quitting leaves it staged (user request
    // 2026-11-17: the app updated itself on quit once downloads took a second).
    log(`maru desktop ${version} (${process.platform}-${process.arch}, Electron ${process.versions.electron}), data ${userData}`);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

/** The name the server lists the device under: this computer's name and its OS. */
function deviceName(): string {
  const host = os.hostname().replace(/\.local$/, "");
  const osName = process.platform === "darwin" ? "Mac" : process.platform === "win32" ? "Windows" : "Linux";
  return `${host} (${osName})`;
}

/** The update certificate build.ts puts next to the app's resources; none in an unpackaged run. */
/**
 * The page's last backdrop choice, so the next window opens with it before the page loads. The
 * page's own setting decides (web displayPrefs); its default is the translucent sidebar.
 */
function readBackdrop(file: string): boolean {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as { translucent?: unknown };
    return typeof v.translucent === "boolean" ? v.translucent : true;
  } catch {
    return true;
  }
}

function writeBackdrop(file: string, translucent: boolean): void {
  try {
    fs.writeFileSync(file, JSON.stringify({ translucent }));
  } catch {
    // The next start opens with the default and the page sets it again.
  }
}

function readCertificate(): string | null {
  if (!app.isPackaged) return null;
  try {
    return fs.readFileSync(path.join(process.resourcesPath, "update-certificate.pem"), "utf8");
  } catch {
    return null;
  }
}
