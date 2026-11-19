import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProjectStore } from "../projects/store.ts";
import { ChosenStore } from "../state/chosen.ts";
import { LockStore } from "../state/locks.ts";
import { legacyLockLine, migrateLegacyLocks } from "./legacyLocks.ts";

test("hand-set locks become list membership: a locked session outside the list is added and archived, one in the list is left, and it runs once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maru-legacy-locks-"));
  const file = path.join(dir, "state.sqlite");
  const locks = new LockStore(file);
  const chosen = new ChosenStore(file);
  const projects = new ProjectStore(file);
  try {
    locks.set("claude", "out1", true);
    locks.set("codex", "out2", true);
    locks.set("claude", "in1", true);
    chosen.set("claude", "in1", true);
    chosen.set("claude", "plain", true); // in the list, never locked by hand

    const report = migrateLegacyLocks({ locks, chosen, projects });
    assert.deepEqual(report, { total: 3, alreadyInList: 1, movedToArchive: 2 });
    assert.match(legacyLockLine(report)!, /3 rows, 1 already in the list, 2 added to the list and archived/);
    // Outside the list before, locked now: in the list and archived, as the sidebar's archive shows it.
    assert.equal(chosen.has("claude", "out1"), true);
    assert.equal(chosen.has("codex", "out2"), true);
    assert.notEqual(projects.archivedOf("claude", "out1"), null);
    assert.notEqual(projects.archivedOf("codex", "out2"), null);
    // Already in the list: not archived by the migration.
    assert.equal(projects.archivedOf("claude", "in1"), null);
    assert.equal(projects.archivedOf("claude", "plain"), null);

    // The old rows are kept under another name, and a second start finds no lock row.
    locks.close();
    const again = new LockStore(file);
    assert.equal(again.count(), 0);
    assert.deepEqual(migrateLegacyLocks({ locks: again, chosen, projects }), { total: 0, alreadyInList: 0, movedToArchive: 0 });
    assert.equal(legacyLockLine({ total: 0, alreadyInList: 0, movedToArchive: 0 }), null);
    again.close();
    const raw = new DatabaseSync(file);
    const rows = raw.prepare("SELECT session_key FROM locks_migrated ORDER BY session_key").all().map((r) => String(r.session_key));
    raw.close();
    assert.deepEqual(rows, ["claude:in1", "claude:out1", "codex:out2"]);
  } finally {
    chosen.close();
    projects.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
