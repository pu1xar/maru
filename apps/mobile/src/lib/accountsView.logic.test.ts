import { test } from "node:test";
import assert from "node:assert/strict";
import type { AccountsStatus } from "../../../../packages/shared/src/accounts.ts";
import { accountViews, restartNote } from "./accountsView.logic.ts";

const STATUS: AccountsStatus = {
  accounts: [
    { id: "claude", provider: "claude", dir: "/h/.claude", status: "signed-in", detected: true, pending: null },
    { id: "codex-w", provider: "codex", dir: "/h/.codex-w", status: "not-signed-in", detected: false, pending: "add" },
    { id: "old", provider: "claude", dir: "/h/.claude-old", status: "unknown", detected: false, pending: "remove" },
    { id: "nocli", provider: "codex", dir: "/h/.codex", status: "cli-missing", detected: false, pending: null },
  ],
  configFile: "/h/.config/maru/config.json",
  claudeUsage: false,
  claudeUsageRunning: false,
  codexUsage: false,
  codexUsageRunning: false,
  restartNeeded: true,
  configError: null,
};

test("each account shows the web's words and badge tints, Detected, and the restart note", () => {
  const v = accountViews(STATUS);
  assert.deepEqual(v.map((x) => [x.id, x.statusLabel, x.statusVariant, x.detected, x.note]), [
    ["claude", "Signed in", "success", true, null],
    ["codex-w", "Not signed in", "warning", false, "Restart maru to use this account"],
    ["old", "Unknown", "outline", false, "Removed from the config file. Restart maru to stop using it"],
    ["nocli", "CLI not found", "error", false, null],
  ]);
  assert.equal(new Set(v.map((x) => x.key)).size, 4);
});

test("the restart line shows only when the server says so", () => {
  assert.match(restartNote(STATUS) ?? "", /Restart maru/);
  assert.equal(restartNote({ ...STATUS, restartNeeded: false }), null);
});
