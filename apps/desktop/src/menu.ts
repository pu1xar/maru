// The application menu (DESIGN.md 2e), after T3 Code's DesktopApplicationMenu.ts: the app menu on
// a Mac (about, update check, settings, services, hide, quit), Edit and View by role (Zoom in and out are plain items), Window, and
// Help with the update check on every platform. Labels are Korean like the page.
//
// Like T3, ⌘W has no menu shortcut: the page uses it to close a split pane (DESIGN.md 6k), and a
// menu shortcut would take the key before the page sees it.
import type { MenuItemConstructorOptions } from "electron";

export interface MenuActions {
  checkForUpdates(): void;
  closeWindow(): void;
  openSettings(): void;
  unpair(): void;
  /** Zoom in (+1) and Zoom out (-1): the page decides what grows (DESIGN.md 2e, 확대 단축키). */
  zoom(direction: 1 | -1): void;
  /** The Window menu's Keep on top: the lean window with the keyboard stays above the others (DESIGN.md 6x). */
  toggleKeepOnTop(): void;
}

export function menuTemplate(platform: NodeJS.Platform, appName: string, actions: MenuActions): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  const update: MenuItemConstructorOptions = { label: "Check for updates...", click: () => actions.checkForUpdates() };
  const settings: MenuItemConstructorOptions = { label: "Settings...", accelerator: "CmdOrCtrl+,", click: () => actions.openSettings() };
  const unpair: MenuItemConstructorOptions = { label: "Disconnect this device...", click: () => actions.unpair() };
  const template: MenuItemConstructorOptions[] = [];
  if (mac) {
    template.push({
      label: appName,
      submenu: [
        { role: "about", label: `About ${appName}` },
        update,
        { type: "separator" },
        settings,
        unpair,
        { type: "separator" },
        { role: "services", label: "Services" },
        { type: "separator" },
        { role: "hide", label: `Hide ${appName}` },
        { role: "hideOthers", label: "Hide others" },
        { role: "unhide", label: "Show all" },
        { type: "separator" },
        { role: "quit", label: `Quit ${appName}` },
      ],
    });
  }
  template.push({
    label: "File",
    submenu: mac
      ? [{ label: "Close window", click: () => actions.closeWindow() }]
      : [settings, unpair, { type: "separator" }, { role: "quit", label: "Quit" }],
  });
  template.push({
    label: "Edit",
    submenu: [
      { role: "undo", label: "Undo" },
      { role: "redo", label: "Redo" },
      { type: "separator" },
      { role: "cut", label: "Cut" },
      { role: "copy", label: "Copy" },
      { role: "paste", label: "Paste" },
      { role: "pasteAndMatchStyle", label: "Paste and match style" },
      { role: "delete", label: "Delete" },
      { role: "selectAll", label: "Select all" },
    ],
  });
  template.push({
    label: "View",
    submenu: [
      { role: "reload", label: "Reload" },
      { role: "forceReload", label: "Force reload" },
      { role: "toggleDevTools", label: "Developer tools" },
      { type: "separator" },
      { role: "resetZoom", label: "Actual size" },
      // Plain items, not the zoomIn and zoomOut roles: the roles zoom the whole page, and these send
      // the page a direction. A menu item has one accelerator, so the key without Shift (the = key)
      // is a hidden twin; a mouse driver may send any of the three.
      { label: "Zoom in", accelerator: "CmdOrCtrl+Plus", click: () => actions.zoom(1) },
      { label: "Zoom in", accelerator: "CmdOrCtrl+=", visible: false, acceleratorWorksWhenHidden: true, click: () => actions.zoom(1) },
      { label: "Zoom out", accelerator: "CmdOrCtrl+-", click: () => actions.zoom(-1) },
      { type: "separator" },
      { role: "togglefullscreen", label: "Full screen" },
    ],
  });
  // A checkbox the app keeps in step with the focused window (main.ts syncKeepOnTopItem): on for a
  // lean window that is kept on top, off and disabled while another window has the keyboard.
  const keepOnTop: MenuItemConstructorOptions = { id: "keep-on-top", label: "Keep on top", type: "checkbox", checked: false, enabled: false, click: () => actions.toggleKeepOnTop() };
  template.push({
    label: "Window",
    role: "windowMenu",
    submenu: mac
      ? [{ role: "minimize", label: "Minimize" }, { role: "zoom", label: "Zoom" }, keepOnTop, { type: "separator" }, { role: "front", label: "Bring all to front" }]
      : [{ role: "minimize", label: "Minimize" }, { role: "zoom", label: "Zoom" }, keepOnTop],
  });
  template.push({ label: "Help", role: "help", submenu: [update] });
  return template;
}
