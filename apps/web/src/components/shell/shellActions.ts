// What the terminal screen's tabs and the sidebar's terminal group do to a shell (DESIGN.md 6s):
// show it, open it in the split view, end it. Both surfaces call these, so a shell behaves the same
// from either, and both read the one list (lib/shellList.ts).
import { closeShell } from "~/lib/shellApi";
import { forgetShell, getShellList } from "~/lib/shellList";
import { shellRowTarget } from "~/lib/shellGroup";
import { openPanesView, isPanesBase } from "~/lib/panesRoute";
import { pickActive, planShellEnd, lastActiveShell, rememberActiveShell } from "~/lib/shellTabs";
import { closeTerminal, openTerminal } from "~/lib/terminalRoute";
import { getPaneTabs, paneActions } from "../split/paneStore";

/**
 * A shell row picked in the sidebar. A shell that a pane of the split view shows, with the split
 * view as the base of the page, takes focus there (its tab comes up, and the terminal screen,
 * settings or the dashboard over the split view give way); any other shell is the terminal
 * screen's shown tab, and the screen opens.
 */
export function showShell(shellId: string): void {
  const splitIsBase = isPanesBase();
  const target = shellRowTarget(shellId, splitIsBase ? getPaneTabs() : null, splitIsBase);
  if (target.kind === "pane") {
    paneActions.selectTab(target.tabId);
    paneActions.focus(target.paneId);
    openPanesView();
    return;
  }
  rememberActiveShell(shellId);
  openTerminal();
}

/** The shell opens as a pane of the split view, which then shows (the terminal screen gives way). */
export function openShellInSplit(shellId: string): void {
  paneActions.openShell(shellId);
  openPanesView();
}

/**
 * A shell is over (it exited, or was ended): it leaves the list and its panes close, the terminal
 * screen shows its neighbor, and the screen closes when no shell is left.
 */
export function shellGone(shellId: string): void {
  // The split view's tabs are read only once that view has been the base: reading them here would
  // fix their first layout before the split view opens (paneStore.ts initial).
  if (isPanesBase()) paneActions.shellEnded(shellId);
  const list = getShellList() ?? [];
  // Ending from a tab ends its view with "exited" too: the second call finds nothing to do.
  if (!list.some((s) => s.id === shellId)) return;
  const plan = planShellEnd(list, shellId, pickActive(list, lastActiveShell()));
  forgetShell(shellId);
  rememberActiveShell(plan.active);
  if (plan.closeScreen) closeTerminal();
}

/** Ends the shell (its tmux session). The caller reports a failure; nothing changes then. */
export async function endShell(shellId: string): Promise<void> {
  await closeShell(shellId);
  shellGone(shellId);
}
