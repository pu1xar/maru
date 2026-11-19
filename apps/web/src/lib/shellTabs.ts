// The tabs of the terminal screen (DESIGN.md 6s): which shell shows, what a tab is called, where a
// new shell starts. The shells themselves are the server's (GET /api/shells); `active` only picks
// one of them. All of it is pure so the screen's behavior is testable without a page.
import type { ShellInfo } from "@maru/shared";

/** The shell that shows: the chosen one while it exists, else the newest. */
export function pickActive(shells: readonly ShellInfo[], active: string | null): string | null {
  if (active && shells.some((s) => s.id === active)) return active;
  return shells.at(-1)?.id ?? null;
}

/** The shell that shows after `closed` goes: its right neighbor, else its left (T3's closeSurface). */
export function afterClose(shells: readonly ShellInfo[], closed: string): string | null {
  const i = shells.findIndex((s) => s.id === closed);
  if (i < 0) return pickActive(shells, null);
  return shells[i + 1]?.id ?? shells[i - 1]?.id ?? null;
}

/** The previous or next shell, around the ends. */
export function cycleShell(shells: readonly ShellInfo[], active: string | null, delta: 1 | -1): string | null {
  if (!shells.length) return null;
  const i = shells.findIndex((s) => s.id === active);
  if (i < 0) return shells[0]!.id;
  return shells[(i + delta + shells.length) % shells.length]!.id;
}

/** A tab's label: the foreground command, numbered when several shells run the same one. */
export function shellLabels(shells: readonly ShellInfo[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const s of shells) counts.set(s.command, (counts.get(s.command) ?? 0) + 1);
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const s of shells) {
    const name = s.command || "shell";
    if ((counts.get(s.command) ?? 0) < 2) {
      out.set(s.id, name);
      continue;
    }
    const n = (seen.get(s.command) ?? 0) + 1;
    seen.set(s.command, n);
    out.set(s.id, `${name} ${n}`);
  }
  return out;
}

/**
 * The folder a new shell starts in: the folder of the session the screen covers (the focused
 * pane's in the split view), or null (the server uses the home folder) when there is none or it is
 * not an absolute path.
 */
export function newShellCwd(sessionCwd: string | null | undefined): string | null {
  return sessionCwd && sessionCwd.startsWith("/") ? sessionCwd : null;
}

/**
 * The shell the terminal screen shows, or showed when it was last left (reopening shows that tab
 * again, until a reload). The screen's tab strip and the sidebar's terminal group both read it,
 * so a row picked in the sidebar shows as that tab.
 */
let lastActive: string | null = null;
const activeListeners = new Set<() => void>();
export const lastActiveShell = (): string | null => lastActive;
export const rememberActiveShell = (id: string | null): void => {
  if (lastActive === id) return;
  lastActive = id;
  for (const l of [...activeListeners]) l();
};
/** Calls `listener` whenever the remembered shell changes. */
export function onActiveShellChange(listener: () => void): () => void {
  activeListeners.add(listener);
  return () => {
    activeListeners.delete(listener);
  };
}

/**
 * What the shell that is over leaves behind (an end from a tab, the sidebar, or an `exit`): the
 * shells still listed, the shell that shows (its right neighbor, else its left, when the shown one
 * ended), and whether the terminal screen has nothing left to show.
 */
export function planShellEnd(
  shells: readonly ShellInfo[],
  ended: string,
  shown: string | null,
): { remaining: ShellInfo[]; active: string | null; closeScreen: boolean } {
  const remaining = shells.filter((s) => s.id !== ended);
  const active = shown === ended ? afterClose(shells, ended) : shown;
  return { remaining, active, closeScreen: remaining.length === 0 };
}
