// The desktop app (DESIGN.md 2e): the Electron shell for Mac and Windows that shows this server's
// web page with a desktop device token. This file holds the server's feed of shell builds (signed
// manifest, installers) and the bridge the shell gives the page (window.maruDesktop).
//
// Web listener and, for a desktop token, the device listener:
//   GET  /api/desktop/app              -> DesktopAppInfo (the 기기 tab)
//   GET  /api/desktop/update           -> DesktopUpdateResponse, 404 when this release has no build
//   GET  /api/desktop/download/<file>  one file the manifest lists, or a block map it lists (attachment,
//                                      byte ranges, see builds.ts)

export type DesktopPlatform = "darwin" | "win32";
export type DesktopArch = "arm64" | "x64";

/** One built file of a shell build. */
export interface DesktopArtifact {
  /** File name in the build folder, and the last segment of its download path. */
  file: string;
  platform: DesktopPlatform;
  arch: DesktopArch;
  /**
   * zip   the Mac app, what a Mac app updates itself from
   * dmg   the Mac app as a disk image, to install by hand
   * nsis  the Windows installer: a first install, and every update (run silently)
   */
  format: "zip" | "dmg" | "nsis";
  size: number;
  /** Hex SHA-256 of the file; the app checks a download against it before installing. */
  sha256: string;
  /**
   * The file's block map (apps/desktop/src/blockmap.ts), which lets an app that has an earlier build
   * fetch only the blocks that changed. Inside the signed manifest, so its SHA-256 is signed too.
   * The zip and nsis files have one; the dmg is only ever downloaded whole.
   */
  blockmap?: DesktopBlockmap;
}

/** A block map file next to its update file (same download route). */
export interface DesktopBlockmap {
  file: string;
  size: number;
  /** Hex SHA-256 of the block map file. */
  sha256: string;
}

/** The signed body of a shell build (manifest.json). */
export interface DesktopUpdateManifest {
  format: 1;
  /** Names the document, so a signature this key made over anything else is not taken for one. */
  type: "maru-desktop-update";
  /** The shell's version: the maru version of the commit it was built from (0.1.N, DESIGN.md 2c). */
  version: string;
  /** Hash of the shell's inputs (apps/desktop/scripts/fingerprint.ts); same value, same shell. */
  fingerprint: string;
  builtAt: string;
  artifacts: DesktopArtifact[];
}

/** GET /api/desktop/update. */
export interface DesktopUpdateResponse {
  /** manifest.json exactly as signed. */
  manifest: string;
  /** Base64 RSASSA-PKCS1-v1_5 SHA-256 over the UTF-8 bytes of `manifest`, by the update signing key. */
  signature: string;
}

/** GET /api/desktop/app. */
export interface DesktopAppInfo {
  /** The shell build this release serves; null when it has none. */
  build: Omit<DesktopUpdateManifest, "format" | "type"> | null;
}

// The bridge: what the desktop app's preload gives the page (window.maruDesktop). Shaped after
// T3 Code's desktopBridge update calls (getUpdateState, onUpdateState, checkForUpdate,
// installUpdate). A page in a browser has no bridge.

/**
 * The shell's update, after T3 Code's update machine. The app downloads a newer build as soon as
 * it sees one, so there is no "available" step; it installs when the user restarts from the page
 * or the menu, or when the app quits.
 */
export type DesktopUpdateState =
  | { status: "disabled"; reason: string }
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up-to-date"; checkedAt: number }
  | { status: "downloading"; version: string; received: number; total: number }
  | { status: "downloaded"; version: string }
  | { status: "error"; context: "check" | "download" | "install"; message: string; checkedAt: number };

/** The paired device as the shell knows it. */
export interface DesktopDevice {
  id: string;
  name: string;
  /** The server URL the app talks to (the page's own origin). */
  server: string;
}

export interface MaruDesktopBridge {
  /** The shell's version (0.1.N), platform and CPU. */
  version: string;
  platform: DesktopPlatform | "linux";
  arch: string;
  getDevice(): Promise<DesktopDevice>;
  getUpdateState(): Promise<DesktopUpdateState>;
  /** Called on every change; returns the unsubscribe. */
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
  checkForUpdate(): Promise<DesktopUpdateState>;
  /** Restarts into the downloaded build. */
  installUpdate(): Promise<void>;
  /** Tells the server to forget this device, drops the token and shows the pairing screen. */
  unpair(): Promise<void>;
  /**
   * The window's backdrop (DESIGN.md 2e, 창 배경): blurred and see-through (Mac vibrancy, Windows
   * acrylic) behind the parts of the page the page makes transparent, or an opaque window.
   */
  setWindowBackdrop(translucent: boolean): Promise<void>;
  /**
   * The menu's Zoom in and Zoom out (and their keys, which a mouse driver can send for Cmd+wheel)
   * arrive here as a direction instead of zooming the page (DESIGN.md 2e, 확대 단축키); the page
   * decides what to zoom. Returns the unsubscribe. Absent in a shell built before this existed.
   */
  onZoomShortcut?(listener: (direction: 1 | -1) => void): () => void;
  /** Zooms the whole page one step (what Zoom in and Zoom out did before). Absent in an older shell. */
  zoomPage?(direction: 1 | -1): Promise<void>;
  /**
   * Lean windows (DESIGN.md 6x): one session in a window of its own. `path` is the page's own
   * address for it (`/?s=<id>&window=lean`); the main process checks it names this server. A session
   * that already has a lean window gets that window brought forward instead. `at` is the drop's
   * screen position (the new window is centred near it). Absent in a shell built before this existed.
   */
  openLeanWindow?(request: { key: string; path: string; at: { x: number; y: number } | null }): Promise<void>;
  /** Brings the session's lean window forward; false when it has none. */
  focusLeanWindow?(key: string): Promise<boolean>;
  /** The open lean windows (window id and session key), now and on every change; returns the unsubscribe. */
  getLeanWindows?(): Promise<DesktopLeanWindow[]>;
  onLeanWindows?(listener: (windows: DesktopLeanWindow[]) => void): () => void;
  /**
   * A lean window being moved over the main window (DESIGN.md 6x, the desktop app's way back into
   * the split view): the cursor in this page's client pixels while it is over the page, null once
   * it is not. `key` is the window's session. Returns the unsubscribe. Absent in an older shell.
   */
  onSplitDrag?(listener: (drag: DesktopSplitDrag | null) => void): () => void;
  /**
   * The lean window was let go over this page at that point. The page answers with what it did
   * (`replySplitDrop`, a `PlaceOutcome`); the main process closes the window when the session
   * joined the split view.
   */
  onSplitDrop?(listener: (drop: DesktopSplitDrag & { id: string }) => void): () => void;
  replySplitDrop?(id: string, outcome: string): Promise<void>;
  /** Keep this window above the others (a lean window's pin, and the Window menu's item). */
  getKeepOnTop?(): Promise<boolean>;
  setKeepOnTop?(on: boolean): Promise<boolean>;
  onKeepOnTop?(listener: (on: boolean) => void): () => void;
  /** Writes text to the system clipboard (the debugging copy of an element's name). Absent in an older shell. */
  copyText?(text: string): Promise<void>;
  /**
   * The context menu's "Copy UI name" was chosen: the page copies the name of the element it was
   * opened on. Returns the unsubscribe. Absent in an older shell.
   */
  onCopyUiName?(listener: () => void): () => void;
}

/** A lean window's session carried over the main window, at the cursor in the page's client pixels. */
export interface DesktopSplitDrag {
  key: string;
  x: number;
  y: number;
}

/** One open lean window as the main process lists it. */
export interface DesktopLeanWindow {
  id: string;
  key: string;
}
