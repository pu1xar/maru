// Keys of the terminal screen (DESIGN.md 6s), and the rule that gives the focused shell its keys.
// `code` is read, not `key`: a Korean input source turns letters into jamo and Option changes `key`.
//
//   Mac          others            action
//   ⌘J           Ctrl+`            open the terminal screen (and type into its shell), or close it
//   ⌘⇧J          Ctrl+Shift+`      open the screen and make a new shell
//   ⌥⇧⌘[ ⌥⇧⌘]    Ctrl+Alt+Shift+[ ] previous, next shell (tab) while the screen shows
//
// ⌘J is T3 Code's terminal toggle (mod+j). Outside a Mac its Ctrl+J is the shell's line feed, so the
// toggle there is VS Code's Ctrl+`. T3's mod+n and mod+w would be Chrome's reserved new window and
// close tab, and its mod+d is the split view's (6k), so a new shell is ⌘⇧J. The split view has ⌘[ ⌘]
// (previous and next pane) and ⌘⇧[ ⌥⌘[ (its tabs), so the shells take ⌥⇧⌘[ ⌥⇧⌘].
import type { KeyLike } from "./paneKeys.ts";

export type ShellKeyAction = "toggle" | "new" | "prev" | "next";

/** The attribute on a shell's terminal element; keys typed in it are the shell's (leaveToShell). */
export const SHELL_TERMINAL_ATTR = "data-shell-terminal";

export function matchShellKey(event: KeyLike, isMac: boolean): ShellKeyAction | null {
  if (event.repeat || event.isComposing) return null;
  const { code, altKey: alt, shiftKey: shift } = event;
  if (isMac) {
    if (!event.metaKey || event.ctrlKey) return null;
    if (code === "KeyJ" && !alt) return shift ? "new" : "toggle";
  } else {
    if (!event.ctrlKey || event.metaKey) return null;
    if (code === "Backquote" && !alt) return shift ? "new" : "toggle";
  }
  if (alt && shift && code === "BracketLeft") return "prev";
  if (alt && shift && code === "BracketRight") return "next";
  return null;
}

export type TerminalKeyStep = "open" | "close" | "open-new" | "new" | "prev" | "next" | null;

/**
 * What a shell key does to the terminal screen: the toggle opens or closes it, the new-shell key
 * opens it when closed and makes a shell either way, and the tab keys act only while it shows.
 */
export function terminalKeyStep(action: ShellKeyAction, open: boolean): TerminalKeyStep {
  switch (action) {
    case "toggle":
      return open ? "close" : "open";
    case "new":
      return open ? "new" : "open-new";
    case "prev":
    case "next":
      return open ? action : null;
  }
}

/** Labels for tooltips. */
export function shellKeyLabels(isMac: boolean) {
  return isMac
    ? { toggle: "⌘J", create: "⌘⇧J", cycle: "⌥⇧⌘[ ⌥⇧⌘]" }
    : { toggle: "Ctrl+`", create: "Ctrl+Shift+`", cycle: "Ctrl+Alt+Shift+[ ]" };
}

export type ShellBarKey = "esc" | "tab" | "up" | "down" | "left" | "right" | "ctrl-c";

/** What a key-bar key (touch screens) sends; arrows follow the shell's cursor key mode (vim and less switch it). */
export function keySequence(name: ShellBarKey, appCursor: boolean): string {
  const arrow = (c: string) => (appCursor ? `\x1bO${c}` : `\x1b[${c}`);
  switch (name) {
    case "esc":
      return "\x1b";
    case "tab":
      return "\t";
    case "ctrl-c":
      return "\x03";
    case "up":
      return arrow("A");
    case "down":
      return arrow("B");
    case "right":
      return arrow("C");
    case "left":
      return arrow("D");
  }
}

/** The control code of one typed character (the key bar's latched Ctrl): a letter or @[\]^_ ; else null. */
export function controlChar(data: string): string | null {
  if (data.length !== 1) return null;
  const code = data.toUpperCase().charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code & 0x1f) : null;
}

/** Whether the event was typed into a shell's terminal. */
export function inShellTerminal(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  return typeof el?.closest === "function" && el.closest(`[${SHELL_TERMINAL_ATTR}]`) !== null;
}

/**
 * Whether an app shortcut should leave this key to the shell that has the focus: a key with Ctrl is
 * the shell's control character (ctrl+b, ctrl+o, ctrl+d, ctrl+w, ctrl+[ ...), so the app's Ctrl
 * shortcuts (the background key on every platform, and outside a Mac the sidebar, panel, mode and
 * pane keys) do not take it there. A Mac's ⌘ keys never reach a shell and stay the app's.
 */
export function leaveToShell(event: { target: EventTarget | null; ctrlKey: boolean; metaKey: boolean }, isMac: boolean): boolean {
  if (!event.ctrlKey || (isMac && event.metaKey)) return false;
  return inShellTerminal(event.target);
}
