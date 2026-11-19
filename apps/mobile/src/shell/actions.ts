// What the shell screen and the drawer's Terminal group do to a shell (DESIGN.md 6s; the web's
// components/shell/shellActions.ts). Both call these, so a shell behaves the same from either, and
// both read the one list (listStore.ts).
import { lastActiveShell, pickActive, planShellEnd, rememberActiveShell } from "../../../web/src/lib/shellTabs.ts";
import type { ShellListStore } from "./listStore.ts";

/** A shell row picked in the drawer, or a tab: it is the shell the screen shows. */
export function showShell(id: string): void {
  rememberActiveShell(id);
}

/**
 * A shell is over (it exited, or was ended): it leaves the list, the screen shows its right
 * neighbor (else its left), and the screen has nothing to show when no shell is left. Ending from a
 * tab also ends its view with "exited": the second call finds nothing to do.
 */
export function shellGone(store: ShellListStore, id: string): { closeScreen: boolean } {
  const list = store.getSnapshot().shells ?? [];
  if (!list.some((s) => s.id === id)) return { closeScreen: false };
  const plan = planShellEnd(list, id, pickActive(list, lastActiveShell()));
  store.forget(id);
  rememberActiveShell(plan.active);
  return { closeScreen: plan.closeScreen };
}

/** Ends the shell (its tmux session), then what shellGone does. The caller reports a failure; nothing changes then. */
export async function endShell(store: ShellListStore, id: string): Promise<{ closeScreen: boolean }> {
  await store.close(id);
  return shellGone(store, id);
}
