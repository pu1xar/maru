import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "@maru/shared";

import { shortAccount } from "../model.ts";
import {
  folderChoices,
  folderName,
  heldByThisServer,
  metaOwner,
  moveTargets,
  movedKey,
  relocateAction,
  retryWhileHeld,
  shouldFollowMove,
} from "./sessionMeta.ts";

const ID = "0f6a1c2e-1111-4222-8333-944445555666";

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  const provider = over.provider ?? "claude";
  const account = over.account ?? `${provider}-personal`;
  return {
    key: `${provider}:${account}:${ID}`,
    provider,
    account,
    id: ID,
    cwd: "/Users/me/projects/a",
    name: null,
    title: null,
    preview: null,
    status: "closed",
    owner: "none",
    pid: null,
    tmuxPane: null,
    parentKey: null,
    updatedAt: 1,
    createdAt: 1,
    sizeBytes: null,
    entrypoint: null,
    ...over,
  };
}

test("the account label drops its provider prefix, once", () => {
  assert.equal(shortAccount("claude-personal"), "personal");
  assert.equal(shortAccount("codex-other"), "other");
  assert.equal(shortAccount("claude-codex-x"), "codex-x");
  assert.equal(shortAccount("team"), "team");
});

test("the holder is maru for this server's run, terminal for anyone else's, nothing once closed", () => {
  assert.equal(metaOwner(session({ status: "open-idle", owner: "ui" })), "maru");
  assert.equal(metaOwner(session({ status: "running", owner: "ui" })), "maru");
  assert.equal(metaOwner(session({ status: "open-idle", owner: "terminal" })), "terminal");
  assert.equal(metaOwner(session({ status: "running", owner: "terminal" })), "terminal");
  // A Codex thread another client loaded: the same owner value, so the same word.
  assert.equal(metaOwner(session({ provider: "codex", status: "open-idle", owner: "terminal" })), "terminal");
  assert.equal(metaOwner(session({ provider: "codex", status: "waiting-input", owner: "terminal" })), "terminal");
  assert.equal(metaOwner(session({ status: "closed", owner: "none" })), null);
  // A stale owner on a closed entry says nothing either.
  assert.equal(metaOwner(session({ status: "closed", owner: "ui" })), null);
});

test("a closed session moves and changes folder at once", () => {
  assert.deepEqual(relocateAction(session(), "account"), { kind: "now" });
  assert.deepEqual(relocateAction(session(), "folder"), { kind: "now" });
  assert.deepEqual(relocateAction(session({ provider: "codex" }), "account"), { kind: "now" });
});

test("this server's idle Claude run closes first; a running one waits with its reason", () => {
  const idle = session({ status: "open-idle", owner: "ui" });
  assert.deepEqual(relocateAction(idle, "account"), { kind: "close-first" });
  assert.deepEqual(relocateAction(idle, "folder"), { kind: "close-first" });
  assert.deepEqual(relocateAction(session({ status: "running", owner: "ui" }), "account"), {
    kind: "blocked",
    reason: "Cannot move to another account: a turn is running",
  });
  assert.deepEqual(relocateAction(session({ status: "waiting-input", owner: "ui" }), "folder"), {
    kind: "blocked",
    reason: "Cannot change working folder: a turn is running",
  });
  // Closing would end background tasks, so it waits for them as the header's close does.
  assert.deepEqual(relocateAction(session({ status: "open-idle", owner: "ui", backgroundTasks: 2 }), "account"), {
    kind: "blocked",
    reason: "Cannot move to another account: background work is running",
  });
});

test("a session another process holds is blocked, idle or not", () => {
  for (const status of ["open-idle", "running", "waiting-input"] as const) {
    assert.deepEqual(relocateAction(session({ status, owner: "terminal" }), "account"), {
      kind: "blocked",
      reason: "Cannot move to another account: open in a terminal",
    });
    assert.deepEqual(relocateAction(session({ status, owner: "terminal" }), "folder"), {
      kind: "blocked",
      reason: "Cannot change working folder: open in a terminal",
    });
    assert.deepEqual(relocateAction(session({ provider: "codex", status, owner: "terminal" }), "account"), {
      kind: "blocked",
      reason: "Cannot move to another account: open in another client",
    });
  }
});

test("a Codex thread this server holds is not closed first, and never changes folder", () => {
  assert.deepEqual(relocateAction(session({ provider: "codex", status: "open-idle", owner: "ui" }), "account"), {
    kind: "blocked",
    reason: "Cannot move to another account: the session is open",
  });
  assert.deepEqual(relocateAction(session({ provider: "codex", status: "running", owner: "ui" }), "account"), {
    kind: "blocked",
    reason: "Cannot move to another account: a turn is running",
  });
  assert.deepEqual(relocateAction(session({ provider: "codex", status: "error", owner: "ui" }), "account"), {
    kind: "blocked",
    reason: "Cannot move to another account: the session is open",
  });
  for (const s of [session({ provider: "codex" }), session({ provider: "codex", status: "open-idle", owner: "ui" })]) {
    assert.deepEqual(relocateAction(s, "folder"), { kind: "blocked", reason: "Cannot change working folder: Codex sessions keep their folder" });
  }
});

test("a subagent thread moves with its parent only", () => {
  const child = session({ provider: "codex", parentKey: "codex:codex-personal:parent" });
  assert.deepEqual(relocateAction(child, "account"), { kind: "blocked", reason: "A subagent thread moves with its parent session" });
  const claudeChild = session({ parentKey: "claude:claude-personal:parent" });
  assert.deepEqual(relocateAction(claudeChild, "folder"), { kind: "blocked", reason: "Cannot change working folder: a subagent thread keeps its parent's folder" });
});

test("a move keeps provider and id under the new account, among the provider's other accounts", () => {
  const s = session();
  assert.equal(movedKey(s, "claude-shared"), `claude:claude-shared:${ID}`);
  const accounts = [
    { id: "claude-work", provider: "claude" as const },
    { id: "claude-personal", provider: "claude" as const },
    { id: "claude-shared", provider: "claude" as const },
    { id: "codex-personal", provider: "codex" as const },
  ];
  assert.deepEqual(moveTargets(accounts, s).map((a) => a.id), ["claude-work", "claude-shared"]);
  assert.deepEqual(moveTargets(accounts, session({ provider: "codex" })).map((a) => a.id), []);
});

test("the page follows a move unless the person picked another session meanwhile", () => {
  const from = `claude:claude-personal:${ID}`;
  assert.equal(shouldFollowMove({ viewShown: true, selected: from, from }), true);
  // The list dropped the old key first and unmounted the view, but the address still names it.
  assert.equal(shouldFollowMove({ viewShown: false, selected: from, from }), true);
  assert.equal(shouldFollowMove({ viewShown: false, selected: "claude:claude-personal:other", from }), false);
  assert.equal(shouldFollowMove({ viewShown: false, selected: null, from }), false);
  // A split pane is shown while its own key changes; the address is not its selection.
  assert.equal(shouldFollowMove({ viewShown: true, selected: null, from }), true);
});

test("folder choices are the listed sessions' folders, newest first, without the current one", () => {
  const list = [
    session({ cwd: "/Users/me/a", updatedAt: 10 }),
    session({ cwd: "/Users/me/b", updatedAt: 30 }),
    session({ cwd: "/Users/me/a", updatedAt: 40 }),
    session({ cwd: "/Users/me/c", updatedAt: 20 }),
    session({ cwd: "/Users/me/sub", updatedAt: 50, parentKey: "x" }),
    session({ cwd: null, updatedAt: 60 }),
  ];
  assert.deepEqual(folderChoices(list, "/Users/me/b"), ["/Users/me/a", "/Users/me/c"]);
  assert.deepEqual(folderChoices(list, null), ["/Users/me/a", "/Users/me/b", "/Users/me/c"]);
});

test("only this server's own hold is waited out; other refusals end the change", async () => {
  assert.equal(heldByThisServer(409, "maru가 돌리는 세션입니다. 실행이 끝난 뒤 옮기세요"), true);
  assert.equal(heldByThisServer(409, "maru가 돌리는 세션입니다 (pid 42). 실행이 끝난 뒤 폴더를 바꾸세요"), true);
  assert.equal(heldByThisServer(409, "Claude 프로세스(pid 42)가 이 세션을 열고 있습니다. 그 프로세스를 종료한 뒤 옮기세요"), false);
  assert.equal(heldByThisServer(400, "maru가 돌리는 세션입니다"), false);
  assert.equal(heldByThisServer(409, "This session is run by maru. Move it after the run ends"), true);

  const held = new Error("held");
  const other = new Error("other");
  const isHeld = (e: unknown) => e === held;
  const wait = async () => {};

  let calls = 0;
  const value = await retryWhileHeld(
    async () => {
      calls += 1;
      if (calls < 3) throw held;
      return "moved";
    },
    { isHeld, stillWanted: () => true, wait },
  );
  assert.equal(value, "moved");
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(
    retryWhileHeld(async () => {
      calls += 1;
      throw calls === 1 ? held : other;
    }, { isHeld, stillWanted: () => true, wait }),
    other,
  );
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    retryWhileHeld(async () => {
      calls += 1;
      throw held;
    }, { isHeld, stillWanted: () => calls < 2, wait }),
    held,
  );
  assert.equal(calls, 2);
});

test("a folder's last name", () => {
  assert.equal(folderName("/Users/me/projects/"), "projects");
  assert.equal(folderName("/"), "/");
});
