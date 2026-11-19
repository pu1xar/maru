// First: moves the storage keys of the build before the rename to their maru_ names, before any
// module or render reads storage.
import "./lib/legacyStorage.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./index.css";
import { App } from "./App.tsx";
import { LeanApp } from "./LeanApp.tsx";
import { isLeanWindow, startLeanWindows } from "./lib/leanWindow.ts";
import { applyDisplayPrefs, readDisplayPrefs } from "./lib/displayPrefs.ts";
import { startForegroundTasks } from "./lib/backgroundTasks.ts";
import { startPendingQuestions } from "./lib/pending.ts";
import { startQueuedMessages } from "./lib/queuedMessages.ts";
import { startTerminalTheme } from "./lib/terminalTheme.ts";
import { startTheme } from "./lib/theme.ts";
import { installBonFont } from "./lib/bonFont.ts";
import { initBackdrop } from "./lib/desktopBackdrop.ts";
import { startZoomShortcut } from "./lib/areaZoom.ts";
import { restoreLastView } from "./lib/lastView.ts";
import { startUiNameCopy } from "./lib/uiNameCopy.ts";

// Before the first render, so the page never paints at the default size first.
applyDisplayPrefs(readDisplayPrefs());
// The web copy of Bon Google Sans Code, from the font CDN setting (nothing without one).
installBonFont();
// index.html already put the theme on the root; from here the app keeps it.
startTheme();
// The desktop app's window backdrop (DESIGN.md 2e); nothing in a browser.
initBackdrop();
// The desktop menu zoom keys zoom the area under the pointer (DESIGN.md 6g); nothing in a browser.
startZoomShortcut();
// The chat code preset "Terminal background" follows the terminal color set's background.
startTerminalTheme();
// Alt+Shift+click copies the element's one-line name (DESIGN.md 7e).
startUiNameCopy();
startPendingQuestions();
startForegroundTasks();
startQueuedMessages();

// The last screen comes back when the address names none (DESIGN.md 6v); before the first render,
// since the routes read the address on first use.
// A lean window (DESIGN.md 6x) is one fixed session: it has no last screen to return to.
const lean = isLeanWindow();
if (!lean) restoreLastView();
// The open lean windows, for the sidebar's marks and for opening a session that has one.
startLeanWindows();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {lean ? <LeanApp /> : <App />}
  </StrictMode>,
);
