// Lean windows at run time (DESIGN.md 6x): opening one, and knowing which sessions have one.
//
// Desktop app: the main process opens the window and holds the list (window.maruDesktop, shared
// desktop.ts); this module mirrors the list it pushes.
// Browser: a popup (`window.open` with the `popup` feature). The tabs and popups of one origin
// tell each other over a BroadcastChannel: a lean window announces itself when it loads and when it
// goes, and a page that starts asks the open ones to announce again (`hello`).
// Either way the list is the same pure registry (leanWindow.logic.ts), read through useLeanKeys.
import { useSyncExternalStore } from "react";

import { desktopBridge } from "./desktopBridge.ts";
import {
  EMPTY_REGISTRY,
  applyLeanMessage,
  isLeanSearch,
  leanKeys,
  leanPath,
  parseLeanSizes,
  popupFeatures,
  popupName,
  rekeyRegistry,
  rememberLeanSize,
  windowIdFor,
  type LeanMessage,
  type LeanRegistry,
} from "./leanWindow.logic.ts";
import { onSessionRekey } from "./sessionViewState.ts";
import { reportProjectFailure } from "../components/ProjectDialogs.tsx";

const CHANNEL = "maru-lean-windows";
const SIZES_KEY = "maru_lean_sizes";

type Wire =
  | LeanMessage
  /** A page that just started asks every lean window to announce itself. */
  | { type: "hello" }
  /** Asks the lean window of this session to come forward (the popup is another page's). */
  | { type: "focus"; key: string };

let registry: LeanRegistry = EMPTY_REGISTRY;
let keys: ReadonlySet<string> = leanKeys(registry);
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;
/** Popups this page opened, for focusing them and for noticing one that closed without telling. */
const popups = new Map<string, Window>();
/** This page's id on the channel, for a lean window's announcements. */
const selfId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random());

function setRegistry(next: LeanRegistry): void {
  if (next === registry) return;
  registry = next;
  keys = leanKeys(next);
  for (const l of [...listeners]) l();
}

function post(msg: Wire): void {
  try {
    channel?.postMessage(msg);
  } catch {
    // A closed channel: the pages stop hearing each other until the next load.
  }
}

/** The sessions that have a lean window now. The set keeps its identity until the list changes. */
export function useLeanKeys(): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => keys,
  );
}

export function leanKeysNow(): ReadonlySet<string> {
  return keys;
}

/** Whether this page is itself a lean window. */
export function isLeanWindow(): boolean {
  return typeof window !== "undefined" && isLeanSearch(window.location.search);
}

/**
 * Starts mirroring the list (main.tsx). The desktop app's list comes from its main process; in a
 * browser the channel carries it.
 */
export function startLeanWindows(): void {
  const bridge = desktopBridge();
  if (bridge?.getLeanWindows && bridge.onLeanWindows) {
    const apply = (entries: { id: string; key: string }[]) => setRegistry(applyLeanMessage(registry, { type: "list", entries }));
    void bridge.getLeanWindows().then(apply, () => {});
    bridge.onLeanWindows(apply);
  } else if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e: MessageEvent<Wire>) => onWire(e.data);
    if (!isLeanWindow()) post({ type: "hello" });
  }
  // A session that moved to another account keeps its lean window (browser lists; the desktop
  // app's main process learns the new key when the window's page announces nothing, so it keeps
  // the old one until the window is opened again).
  onSessionRekey((from, to) => setRegistry(rekeyRegistry(registry, from, to)));
}

function onWire(msg: Wire): void {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "open" || msg.type === "close") {
    setRegistry(applyLeanMessage(registry, msg));
    return;
  }
  if (msg.type === "hello") announce();
  if (msg.type === "focus" && msg.key === ownKey) window.focus();
}

// ---- A lean window's own announcements (browser) ----

let ownKey: string | null = null;

function announce(): void {
  if (ownKey) post({ type: "open", id: selfId, key: ownKey });
}

/** Called by the lean window once its session is known: tells the other pages, and tells them when it closes. */
export function announceLeanWindow(key: string): void {
  if (desktopBridge()?.getLeanWindows) return;
  ownKey = key;
  announce();
  window.addEventListener("pagehide", () => post({ type: "close", id: selfId }));
}

/** The lean window's size is remembered per session (browser), as the popup's next size. */
export function rememberOwnSize(key: string): void {
  const save = () => {
    try {
      const sizes = rememberLeanSize(parseLeanSizes(window.localStorage.getItem(SIZES_KEY)), key, { w: window.outerWidth, h: window.outerHeight });
      window.localStorage.setItem(SIZES_KEY, JSON.stringify(sizes));
    } catch {
      // Storage blocked: the popup opens at the default size.
    }
  };
  window.addEventListener("resize", save);
  window.addEventListener("pagehide", save);
}

function savedSize(key: string): { w: number; h: number } | undefined {
  try {
    return parseLeanSizes(window.localStorage.getItem(SIZES_KEY))[key];
  } catch {
    return undefined;
  }
}

// ---- Opening ----

export interface OpenAt {
  /** Screen coordinates of the drop. */
  x: number;
  y: number;
}

/** Brings the session's lean window forward; false when this page does not know one. */
export function focusLeanWindow(key: string): boolean {
  const bridge = desktopBridge();
  if (bridge?.focusLeanWindow && bridge.getLeanWindows) {
    void bridge.focusLeanWindow(key);
    return keys.has(key);
  }
  if (!keys.has(key)) return false;
  const own = popups.get(key);
  if (own && !own.closed) own.focus();
  else post({ type: "focus", key });
  return true;
}

/**
 * The lean window of a session: a new one, or the existing one brought forward. `at` is where the
 * drop happened on the screen (a menu choice has none).
 */
export function openLeanWindow(key: string, at: OpenAt | null): void {
  if (focusLeanWindow(key)) return;
  const bridge = desktopBridge();
  if (bridge?.openLeanWindow && bridge.getLeanWindows) {
    bridge.openLeanWindow({ key, path: leanPath(key), at }).catch((err: unknown) => reportProjectFailure("Could not open the window", err));
    return;
  }
  const popup = window.open(leanPath(key), popupName(key), popupFeatures(savedSize(key), at));
  if (!popup) {
    reportProjectFailure("Could not open the window", new Error("The browser blocked the pop-up. Allow pop-ups for this site"));
    return;
  }
  popups.set(key, popup);
  const id = `popup:${key}`;
  setRegistry(applyLeanMessage(registry, { type: "open", id, key }));
  // The popup announces itself under its own id once it loads; a popup that closes without
  // announcing (a crash, a blocked unload) is noticed here.
  const timer = setInterval(() => {
    if (!popup.closed) return;
    clearInterval(timer);
    popups.delete(key);
    setRegistry(applyLeanMessage(registry, { type: "close", id }));
    const real = windowIdFor(registry, key);
    if (real) setRegistry(applyLeanMessage(registry, { type: "close", id: real }));
  }, 1000);
}
