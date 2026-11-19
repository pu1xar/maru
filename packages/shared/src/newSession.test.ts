import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canStartNewSession,
  chooseNewSessionAccount,
  NEW_SESSION_MODELS,
  newSessionFolders,
  parseNewSessionMemory,
  providerAccounts,
  rememberNewSession,
} from "./newSession.ts";

const accounts = [
  { id: "claude-a", provider: "claude" as const },
  { id: "claude-b", provider: "claude" as const },
  { id: "codex-a", provider: "codex" as const },
];

test("the account: picked in this form, else the remembered one, else the first", () => {
  assert.deepEqual(providerAccounts(accounts, "claude").map((a) => a.id), ["claude-a", "claude-b"]);
  assert.equal(chooseNewSessionAccount(accounts, "claude", "claude-b", {}), "claude-b");
  assert.equal(chooseNewSessionAccount(accounts, "claude", "", { account: { claude: "claude-b" } }), "claude-b");
  // A remembered or picked account the server no longer has falls through.
  assert.equal(chooseNewSessionAccount(accounts, "claude", "gone", { account: { claude: "also-gone" } }), "claude-a");
  assert.equal(chooseNewSessionAccount(accounts, "codex", "claude-b", {}), "codex-a");
  assert.equal(chooseNewSessionAccount([], "codex", "", {}), "");
});

test("folders are picked from the recent ones; a new pick heads the list", () => {
  assert.deepEqual(newSessionFolders(["/a", "/b"], null), ["/a", "/b"]);
  assert.deepEqual(newSessionFolders(["/a", "/b"], "/b"), ["/a", "/b"]);
  assert.deepEqual(newSessionFolders(["/a"], "/new"), ["/new", "/a"]);
});

test("starting needs a folder, an account and a first message", () => {
  assert.equal(canStartNewSession({ cwd: "/a", account: "claude-a", prompt: " hi ", busy: false }), true);
  assert.equal(canStartNewSession({ cwd: null, account: "claude-a", prompt: "hi", busy: false }), false);
  assert.equal(canStartNewSession({ cwd: "/a", account: "", prompt: "hi", busy: false }), false);
  assert.equal(canStartNewSession({ cwd: "/a", account: "claude-a", prompt: "  ", busy: false }), false);
  assert.equal(canStartNewSession({ cwd: "/a", account: "claude-a", prompt: "hi", busy: true }), false);
});

test("memory round-trips and drops what does not fit", () => {
  const m = rememberNewSession({ account: { codex: "codex-a" } }, "claude", "claude-b", "/a");
  assert.deepEqual(m, { provider: "claude", account: { codex: "codex-a", claude: "claude-b" }, cwd: "/a" });
  assert.deepEqual(parseNewSessionMemory(JSON.parse(JSON.stringify(m))), m);
  assert.deepEqual(parseNewSessionMemory({ provider: "gpt", account: { claude: 3 }, cwd: 7 }), { account: {} });
  assert.deepEqual(parseNewSessionMemory(null), {});
  assert.deepEqual(NEW_SESSION_MODELS.claude[0], { value: "", label: "Default" });
});
