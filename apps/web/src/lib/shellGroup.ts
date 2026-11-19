// The sidebar's terminal group (DESIGN.md 6s, 6k): the "터미널" row of the views menu with the
// shells listed under it. What a click on a shell row does, which row shows as selected, and the
// key the group's fold is stored under are decided here, pure, so they are testable without a page.
import type { PaneTabs } from "./paneTabs.ts";
import { tabOfShell } from "./paneTabs.ts";

/** The group's entry in the folded-groups list (lib/collapsedGroups.ts), next to the session Groups' keys. */
export const TERMINAL_GROUP_KEY = "view:terminal";

/** Where a click on a shell row goes. */
export type ShellRowTarget =
  /** The split view's pane that shows the shell: its tab comes up and the pane takes focus. */
  | { kind: "pane"; tabId: string; paneId: string }
  /** The terminal screen with that shell as the shown tab. */
  | { kind: "terminal"; shellId: string };

/**
 * A shell that a pane of the split view shows is picked there when the split view is the base of
 * the page (showing, or under the terminal screen, settings or the dashboard); otherwise it is a
 * tab of the terminal screen. `tabs` is the split view's tabs, null while they are unread.
 */
export function shellRowTarget(shellId: string, tabs: PaneTabs | null, splitIsBase: boolean): ShellRowTarget {
  const at = splitIsBase && tabs ? tabOfShell(tabs, shellId) : null;
  return at ? { kind: "pane", tabId: at.tab.id, paneId: at.pane.id } : { kind: "terminal", shellId };
}

/**
 * Whether a shell row shows as selected: the terminal screen's shown tab while the screen is open,
 * else the focused pane's shell while the split view shows.
 */
export function isShellSelected(args: {
  shellId: string;
  terminalOpen: boolean;
  /** The terminal screen's shown tab (shellTabs.ts pickActive over the list). */
  terminalShell: string | null;
  panesShown: boolean;
  /** The focused pane's shell in the split view's shown tab. */
  focusedPaneShell: string | null;
}): boolean {
  if (args.terminalOpen) return args.shellId === args.terminalShell;
  return args.panesShown && args.focusedPaneShell === args.shellId;
}
