// The window's preload (DESIGN.md 2e). Sandboxed, so it is one CommonJS file that requires only
// electron (scripts/bundle.ts). It gives the server's page window.maruDesktop (the shell's version,
// its update and the device, after T3 Code's desktopBridge update calls) and the local screens
// window.maruShell (pairing, retry). The main process checks every call's sender again.
//
// It also tells both kinds of page about the window and the window about the page (chrome.ts):
//   <html data-desktop="mac|win|linux">   the page's desktop rules (web index.css) turn on
//   --desktop-window-controls-inset       what a Mac page keeps clear for the traffic lights (T3)
//   <html data-desktop-fullscreen>        full screen: no traffic lights, no space for them
//   maru:chrome                           the page's top bar height in window points and its theme
import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from "electron";
import type { DesktopLeanWindow, DesktopSplitDrag, DesktopUpdateState, MaruDesktopBridge } from "@maru/shared";
import { barHeightAt } from "./chrome.ts";

const version = process.argv.find((a) => a.startsWith("--maru-version="))?.slice("--maru-version=".length) ?? "unknown";
const platformTag = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux";
/** T3's preload: the traffic lights take 90 window points, whatever the page's zoom. */
const MAC_CONTROLS_INSET = 90;
/** The top bar at 2.75rem (web index.css --workspace-topbar-height), when no bar is on the page. */
const TOPBAR_REM = 2.75;

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

let sent = "";
function syncChrome(): void {
  const html = document.documentElement;
  if (html.dataset.desktop !== platformTag) html.dataset.desktop = platformTag;
  const zoom = webFrame.getZoomFactor();
  if (platformTag === "mac") {
    const inset = `${MAC_CONTROLS_INSET / zoom}px`;
    if (html.style.getPropertyValue("--desktop-window-controls-inset") !== inset) html.style.setProperty("--desktop-window-controls-inset", inset);
  }
  // The bar under the window's controls (chrome.ts barHeightAt): the top left on a Mac, the top right on Windows.
  const bars = [...document.querySelectorAll("[data-titlebar]")];
  const under =
    platformTag === "linux"
      ? null
      : barHeightAt(bars.map((b) => b.getBoundingClientRect()), platformTag === "mac" ? 8 : window.innerWidth - 8, 4);
  const css = under || bars[0]?.getBoundingClientRect().height || parseFloat(getComputedStyle(html).fontSize) * TOPBAR_REM;
  // The server's page marks its theme with the root's dark class; the local screens follow the system.
  const dark = location.protocol === "maru-app:" ? matchMedia("(prefers-color-scheme: dark)").matches : html.classList.contains("dark");
  const report = JSON.stringify({ topbar: Math.round(css * zoom * 10) / 10, dark });
  if (report === sent) return;
  sent = report;
  ipcRenderer.send("maru:chrome", JSON.parse(report));
}

function setFullscreen(on: boolean): void {
  document.documentElement.toggleAttribute("data-desktop-fullscreen", on);
}

// At most one measurement per frame: the page changes its DOM constantly while a turn streams, and
// the layout a measurement reads is the one the frame computes anyway.
let frame = 0;
function scheduleChrome(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    syncChrome();
  });
}

window.addEventListener("DOMContentLoaded", () => {
  syncChrome();
  // The theme, the UI scale (the root's font size) and the bar itself can change at any time.
  new MutationObserver(scheduleChrome).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  new MutationObserver(scheduleChrome).observe(document.body, { childList: true, subtree: true });
  // Opening or collapsing the sidebar changes which bar is under the controls.
  new MutationObserver(scheduleChrome).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["data-sidebar-state"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", scheduleChrome);
  void ipcRenderer.invoke("maru:window-state").then((s: { fullscreen: boolean }) => setFullscreen(s.fullscreen), () => {});
});
window.addEventListener("resize", scheduleChrome);
subscribe<{ fullscreen: boolean }>("maru:window-state", (s) => setFullscreen(s.fullscreen));

if (location.protocol === "maru-app:") {
  contextBridge.exposeInMainWorld("maruShell", {
    version,
    platform: process.platform,
    state: () => ipcRenderer.invoke("shell:state"),
    onState: (listener: (state: unknown) => void) => subscribe("shell:state", listener),
    pair: (server: string, code: string) => ipcRenderer.invoke("shell:pair", server, code),
    retry: () => ipcRenderer.invoke("shell:retry"),
    reset: () => ipcRenderer.invoke("shell:reset"),
  });
} else {
  const bridge: MaruDesktopBridge = {
    version,
    platform: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
    arch: process.arch,
    getDevice: () => ipcRenderer.invoke("maru:device"),
    getUpdateState: () => ipcRenderer.invoke("maru:update-state"),
    onUpdateState: (listener: (state: DesktopUpdateState) => void) => subscribe("maru:update-state", listener),
    checkForUpdate: () => ipcRenderer.invoke("maru:update-check"),
    installUpdate: () => ipcRenderer.invoke("maru:update-install"),
    unpair: () => ipcRenderer.invoke("maru:unpair"),
    setWindowBackdrop: (translucent: boolean) => ipcRenderer.invoke("maru:backdrop", translucent === true),
    onZoomShortcut: (listener: (direction: 1 | -1) => void) => subscribe<unknown>("maru:zoom-shortcut", (d) => listener(d === -1 ? -1 : 1)),
    zoomPage: (direction: 1 | -1) => ipcRenderer.invoke("maru:zoom-page", direction === -1 ? -1 : 1),
    openLeanWindow: (request: { key: string; path: string; at: { x: number; y: number } | null }) =>
      ipcRenderer.invoke("maru:lean-open", { key: String(request.key), path: String(request.path), at: request.at }),
    focusLeanWindow: (key: string) => ipcRenderer.invoke("maru:lean-focus", String(key)),
    getLeanWindows: () => ipcRenderer.invoke("maru:lean-windows"),
    onLeanWindows: (listener: (windows: DesktopLeanWindow[]) => void) => subscribe<DesktopLeanWindow[]>("maru:lean-windows", listener),
    onSplitDrag: (listener: (drag: DesktopSplitDrag | null) => void) =>
      subscribe<DesktopSplitDrag | null>("maru:split-drag", (d) => listener(d)),
    onSplitDrop: (listener: (drop: DesktopSplitDrag & { id: string }) => void) =>
      subscribe<DesktopSplitDrag & { id: string }>("maru:split-drop", listener),
    replySplitDrop: (id: string, outcome: string) => ipcRenderer.invoke("maru:split-drop-result", String(id), String(outcome)),
    getKeepOnTop: () => ipcRenderer.invoke("maru:keep-on-top"),
    setKeepOnTop: (on: boolean) => ipcRenderer.invoke("maru:set-keep-on-top", on === true),
    copyText: (text: string) => ipcRenderer.invoke("maru:copy-text", String(text)),
    onCopyUiName: (listener: () => void) => subscribe<unknown>("maru:copy-ui-name", () => listener()),
    onKeepOnTop: (listener: (on: boolean) => void) => subscribe<unknown>("maru:keep-on-top", (v) => listener(v === true)),
  };
  contextBridge.exposeInMainWorld("maruDesktop", bridge);
}
