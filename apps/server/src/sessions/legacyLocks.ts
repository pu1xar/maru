// The hand-set delete locks of earlier builds (table `locks`), carried into the list rule
// (DESIGN.md 6, 잠금): a session is locked because it is in the user's list, archive included.
// A session that was locked by hand and is not in the list is added to the list and archived, so
// the lock it had stays (it shows in the sidebar's archive). One that is in the list needs
// nothing. The table is renamed afterwards, so this runs once and the old rows stay readable.
import type { ProviderId } from "@maru/shared";
import type { ProjectStore } from "../projects/store.ts";
import type { ChosenStore } from "../state/chosen.ts";
import type { LockStore } from "../state/locks.ts";

export interface LegacyLockReport {
  /** Rows the old table held. */
  total: number;
  /** Already in the list, so locked by the new rule as they are. */
  alreadyInList: number;
  /** Added to the list and archived. */
  movedToArchive: number;
}

export function migrateLegacyLocks(d: {
  locks: Pick<LockStore, "keys" | "retire">;
  chosen: Pick<ChosenStore, "has" | "set">;
  projects: Pick<ProjectStore, "archive">;
}): LegacyLockReport {
  const keys = d.locks.keys();
  const report: LegacyLockReport = { total: keys.length, alreadyInList: 0, movedToArchive: 0 };
  for (const key of keys) {
    const at = key.indexOf(":");
    const provider = key.slice(0, at);
    const id = key.slice(at + 1);
    if (at < 0 || !id || (provider !== "claude" && provider !== "codex")) continue;
    const p = provider as ProviderId;
    if (d.chosen.has(p, id)) {
      report.alreadyInList++;
      continue;
    }
    d.chosen.set(p, id, true);
    d.projects.archive(p, id, true);
    report.movedToArchive++;
  }
  // An empty table is left as it is, so it never replaces a retired copy that holds rows.
  if (keys.length > 0) d.locks.retire();
  return report;
}

export function legacyLockLine(r: LegacyLockReport): string | null {
  return r.total === 0
    ? null
    : `legacy locks: ${r.total} rows, ${r.alreadyInList} already in the list, ${r.movedToArchive} added to the list and archived to stay locked`;
}
