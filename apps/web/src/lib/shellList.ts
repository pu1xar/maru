// The shells as the page reads them (DESIGN.md 6k, 6s): one list for the page, read from the server
// while some view subscribes (every 3 seconds). The terminal screen's tabs, the sidebar's terminal
// group and the split view's shell panes all read it, so they list the same shells under the same
// names (shellTabs.ts shellLabels), a pane's label follows the foreground command, and a pane whose
// shell ended closes.
import { useSyncExternalStore } from "react";
import type { ShellInfo } from "@maru/shared";

import { createShell, listShells } from "./shellApi.ts";
import { lastActiveShell, newShellCwd, onActiveShellChange } from "./shellTabs.ts";

/** How often the list is read again while a view subscribes (the terminal screen's rate). */
export const SHELL_LIST_POLL_MS = 3000;

let list: ShellInfo[] | null = null;
/** Bumped by every shell this page makes: a read that began before one may not list it, so it is not used. */
let generation = 0;
const listeners = new Set<() => void>();
/** Told the ids of the shells a successful read lists (the split view closes the panes of the others). */
const readHandlers = new Set<(alive: ReadonlySet<string>) => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function emit(): void {
  for (const l of [...listeners]) l();
}

export async function refreshShells(): Promise<void> {
  const gen = generation;
  let next: ShellInfo[];
  try {
    next = await listShells();
  } catch {
    // An unreachable server or no tmux: the list stays as it was and nothing is closed on a failed read.
    return;
  }
  if (gen !== generation) return;
  list = next;
  emit();
  const alive = new Set(next.map((s) => s.id));
  for (const h of [...readHandlers]) h(alive);
}

/** Calls `handler` with the shell ids of every successful read. */
export function onShellsRead(handler: (alive: ReadonlySet<string>) => void): () => void {
  readHandlers.add(handler);
  return () => {
    readHandlers.delete(handler);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshShells();
    timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void refreshShells();
    }, SHELL_LIST_POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const quiet = (): (() => void) => () => {};

/**
 * Every shell the server has (null before the first read). While `enabled` it keeps the list read;
 * disabled, it only returns the last list and makes no request.
 */
export function useShellList(enabled: boolean): ShellInfo[] | null {
  return useSyncExternalStore(enabled ? subscribe : quiet, () => list);
}

/**
 * Makes a shell in `sessionCwd`'s folder (the home folder when there is none or the folder is
 * gone, as the terminal screen does) and adds it to the list.
 */
export async function createShellIn(sessionCwd: string | null | undefined): Promise<ShellInfo> {
  const cwd = newShellCwd(sessionCwd);
  let shell: ShellInfo;
  try {
    shell = await createShell({ cwd });
  } catch (err) {
    if (cwd === null) throw err;
    shell = await createShell({ cwd: null });
  }
  adoptShell(shell);
  return shell;
}

/** Adds a shell the server made for this page (the accounts sign-in) to the list. */
export function adoptShell(shell: ShellInfo): void {
  generation++;
  list = [...(list ?? []).filter((s) => s.id !== shell.id), shell];
  emit();
}

/** The list as it is now (null before the first read), for code that acts on it outside a render. */
export function getShellList(): ShellInfo[] | null {
  return list;
}

/**
 * Takes a shell that is over (ended here, or exited) out of the list at once. A read that began
 * before this may still list it, so it is not used.
 */
export function forgetShell(id: string): void {
  generation++;
  if (!list?.some((s) => s.id === id)) return;
  list = list.filter((s) => s.id !== id);
  emit();
}

/** The shell the terminal screen shows (shellTabs.ts rememberActiveShell), as the sidebar's selection. */
export function useActiveShellId(): string | null {
  return useSyncExternalStore(onActiveShellChange, lastActiveShell, () => null);
}
