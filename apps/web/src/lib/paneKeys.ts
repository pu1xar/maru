// Keys of the split view (DESIGN.md 6k), iTerm's pane keys on a Mac. `code` is read, not `key`: a
// Korean input source turns letters into jamo and Option changes `key` too.
//
// Chrome reserves some of iTerm's keys in a normal tab, so the page never sees them there: ⌘W
// (close tab) and ⌥⌘← ⌥⌘→ (previous and next tab). In an installed app window Chrome reserves
// nothing. So closing also has ⌥⌘W, and ⌘[ ⌘] (iTerm's previous and next pane) reach every pane
// from a tab. ⌘D, ⌘⇧D, ⌥⌘↑ ⌥⌘↓, ⌘[ ⌘] are browser shortcuts the page may take (bookmark, bookmark
// all tabs, toolbar pane focus, back and forward); they act on panes only in the split view.
import type { Direction, Edge } from "./paneLayout.ts";

export type PaneKeyAction =
  | { type: "split"; edge: Extract<Edge, "right" | "bottom"> }
  /** `onlyWithPanes`: ⌘W closes a pane only while there are two or more, else the window closes as usual. */
  | { type: "close"; onlyWithPanes: boolean }
  | { type: "focus"; dir: Direction }
  | { type: "cycle"; delta: 1 | -1 }
  /** ⌥⌘T, the chat and terminal switch, for the focused pane only. */
  | { type: "toggleMode" }
  /** ⌥⌘B, the file and agents sheet of the focused pane (the right panel's key in the single view). */
  | { type: "togglePanel" }
  /** The tab strip (lib/paneTabs.ts): a new tab, the next or previous tab, tab number `index` (0-based), closing the shown tab. */
  | { type: "newTab" }
  | { type: "tab"; delta: 1 | -1 }
  | { type: "tabAt"; index: number }
  | { type: "closeTab" }
  /** ⌘1..9: focus pane number `index` (0-based, reading order). */
  | { type: "paneAt"; index: number }
  /** ⌘⇧T: bring back the pane the user closed last in this tab. */
  | { type: "reopenPane" };

export interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

const ARROWS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

export function matchPaneKey(event: KeyLike, isMac: boolean): PaneKeyAction | null {
  if (event.repeat || event.isComposing) return null;
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod) return null;
  const { altKey: alt, shiftKey: shift, code } = event;
  if (code === "KeyD" && !alt) return { type: "split", edge: shift ? "bottom" : "right" };
  // Tabs follow iTerm: ⌘T, ⌘⇧[ ⌘⇧], and ⌥⌘1..9 for numbers (⌘1..9 is the pane number). Chrome keeps ⌘T and ⌘⇧[ ⌘⇧] for its own tabs in a normal
  // tab, so each has a twin the page does see: ⌥⌘N and ⌥⌘[ ⌥⌘] (⌥ in place of ⇧). Closing a tab is
  // ⌥⇧⌘W, the pane's ⌥⌘W with ⇧ for the bigger unit.
  if (code === "KeyT" && !alt && !shift) return { type: "newTab" };
  if (code === "KeyN" && alt && !shift) return { type: "newTab" };
  if (code === "KeyW" && alt && shift) return { type: "closeTab" };
  if ((code === "BracketLeft" || code === "BracketRight") && alt !== shift) return { type: "tab", delta: code === "BracketLeft" ? -1 : 1 };
  // Numbers: ⌘1..9 go to the pane with that number (reading order), ⌥⌘1..9 to the tab.
  if (!shift && /^Digit[1-9]$/.test(code)) return { type: alt ? "tabAt" : "paneAt", index: Number(code.slice(5)) - 1 };
  if (code === "KeyT" && shift && !alt) return { type: "reopenPane" };
  if (shift) return null;
  if (code === "KeyW") return { type: "close", onlyWithPanes: !alt };
  if (alt && code in ARROWS) return { type: "focus", dir: ARROWS[code]! };
  if (!alt && code === "BracketLeft") return { type: "cycle", delta: -1 };
  if (!alt && code === "BracketRight") return { type: "cycle", delta: 1 };
  if (alt && code === "KeyT") return { type: "toggleMode" };
  if (alt && code === "KeyB") return { type: "togglePanel" };
  return null;
}

/** Labels for tooltips and menus. */
export function paneKeyLabels(isMac: boolean) {
  return isMac
    ? {
        splitRight: "⌘D",
        splitDown: "⌘⇧D",
        close: "⌥⌘W",
        focus: "⌥⌘ arrows",
        cycle: "⌘[ ⌘]",
        newTab: "⌘T",
        tabs: "⌘⇧[ ⌘⇧]",
        tabNumber: "⌥⌘1~9",
        paneNumber: "⌘1~9",
        reopenPane: "⌘⇧T",
        closeTab: "⌥⇧⌘W",
        rename: "F2",
      }
    : {
        splitRight: "Ctrl+D",
        splitDown: "Ctrl+Shift+D",
        close: "Ctrl+Alt+W",
        focus: "Ctrl+Alt+arrows",
        cycle: "Ctrl+[ Ctrl+]",
        newTab: "Ctrl+T",
        tabs: "Ctrl+Shift+[ Ctrl+Shift+]",
        tabNumber: "Ctrl+Alt+1~9",
        paneNumber: "Ctrl+1~9",
        reopenPane: "Ctrl+Shift+T",
        closeTab: "Ctrl+Alt+Shift+W",
        rename: "F2",
      };
}
