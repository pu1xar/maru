import { test } from "node:test";
import assert from "node:assert/strict";
import type { PendingQuestionView, SessionSummary, UnifiedStatus } from "@maru/shared";
import type { ThreadStatus } from "../codex/protocol/v2/ThreadStatus.ts";
import type { Turn } from "../codex/protocol/v2/Turn.ts";
import { DeviceStore } from "../devices/store.ts";
import { SessionIndex } from "../index/store.ts";
import { VisibleIndex } from "../index/visible.ts";
import { ChosenStore } from "../state/chosen.ts";
import type { FcmMessage, SendResult } from "./fcm.ts";
import { PushService, driveHooks, recipients } from "./service.ts";

const CLAUDE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CODEX_ID = "019a0000-0000-7000-8000-000000000001";
const CLAUDE_KEY = `claude:acct:${CLAUDE_ID}`;
const CODEX_KEY = `codex:acct:${CODEX_ID}`;
/** FCM registration tokens are long (about 150 characters); only their first 8 may reach a log. */
const token = (name: string) => `${name}:APA91b${"x".repeat(140)}`;

function s(provider: "claude" | "codex", id: string, status: UnifiedStatus, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    key: `${provider}:acct:${id}`, provider, account: "acct", id, cwd: "/x", name: `${provider} 세션`, title: null, preview: null,
    status, owner: "ui", pid: null, tmuxPane: null, parentKey: null, updatedAt: 1, createdAt: null, sizeBytes: null, entrypoint: null, ...over,
  };
}

const turn = (t: Partial<Turn>): Turn => ({
  id: "t", rootTurnId: null, items: [], itemsView: "notLoaded", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null, ...t,
});

function rig(answer: (m: FcmMessage) => SendResult | Promise<SendResult> = () => ({ ok: true })) {
  const index = new SessionIndex();
  const chosen = new ChosenStore(":memory:");
  const view = new VisibleIndex(index, chosen);
  const devices = new DeviceStore(":memory:");
  const sent: FcmMessage[] = [];
  const logs: string[] = [];
  const screen = new Set<string>();
  const driven = new Set<string>();
  let pending: PendingQuestionView[] = [];
  let claudeResult: ((key: string, r: Record<string, unknown>) => void) | null = null;
  let claudeExit: ((key: string, info: { code: "done" | "error" | "interrupted"; error?: string }) => void) | null = null;
  let codexTurn: ((key: string, t: Turn) => void) | null = null;
  let codexStatus: ((key: string, st: ThreadStatus) => void) | null = null;
  const push = new PushService({
    view, devices, log: (l) => logs.push(l),
    pending: () => pending,
    drives: (key) => driven.has(key),
    statusFromDriver: (key) => driven.has(key) && key.startsWith("codex:"),
    onScreen: (id) => screen.has(id),
    sender: { send: async (m) => { sent.push(m); return answer(m); } },
    claudeResults: (l) => { claudeResult = l; return () => { claudeResult = null; }; },
    claudeExits: (l) => { claudeExit = l; return () => { claudeExit = null; }; },
    codexTurns: (l) => { codexTurn = l; return () => { codexTurn = null; }; },
    codexStatuses: (l) => { codexStatus = l; return () => { codexStatus = null; }; },
  });
  const put = (x: SessionSummary) => index.apply({ type: "upsert", session: x });
  return {
    index, chosen, devices, push, sent, logs, screen, driven, put,
    setPending: (p: PendingQuestionView[]) => { pending = p; },
    claudeResult: (key: string, r: Record<string, unknown>) => claudeResult!(key, r),
    claudeExit: (key: string, info: { code: "done" | "error" | "interrupted"; error?: string }) => claudeExit!(key, info),
    codexTurn: (key: string, t: Partial<Turn>) => codexTurn!(key, turn(t)),
    codexStatus: (key: string, st: ThreadStatus) => codexStatus!(key, st),
    hooked: () => claudeResult !== null && claudeExit !== null && codexTurn !== null && codexStatus !== null,
  };
}

test("recipients: devices with a token whose app is not on screen", () => {
  const targets = [{ deviceId: "a", token: "ta" }, { deviceId: "b", token: "tb" }];
  assert.deepEqual(recipients(targets, (id) => id === "a"), [{ deviceId: "b", token: "tb" }]);
  assert.deepEqual(recipients([], () => false), []);
});

test("a listed session's turn end reaches each phone without the app on screen, once, tagged by session", async () => {
  const r = rig();
  const a = r.devices.create("Pixel A").device;
  const b = r.devices.create("Pixel B").device;
  r.devices.create("no token");
  r.devices.setPushToken(a.id, token("fcm-a"));
  r.devices.setPushToken(b.id, token("fcm-b"));
  r.chosen.set("claude", CLAUDE_ID, true);
  r.put(s("claude", CLAUDE_ID, "open-idle"));
  r.put(s("claude", CLAUDE_ID, "running"));
  r.screen.add(b.id);
  r.put(s("claude", CLAUDE_ID, "open-idle"));
  await r.push.settled();
  assert.equal(r.sent.length, 1, "B has the app open; the third device has no token");
  assert.deepEqual(r.sent[0], {
    token: token("fcm-a"),
    notification: { title: "claude 세션", body: "Response finished" },
    android: { priority: "high", notification: { channel_id: "maru-sessions", tag: CLAUDE_KEY } },
    data: { kind: "turn.completed", sessionKey: CLAUDE_KEY },
  });
  assert.deepEqual(r.logs, [`push: turn.completed ${CLAUDE_KEY} to 1 device(s)`]);

  // B leaves the app; a terminal session's question goes to both, worded without the question.
  r.screen.delete(b.id);
  r.put(s("claude", CLAUDE_ID, "running"));
  r.put(s("claude", CLAUDE_ID, "waiting-input"));
  await r.push.settled();
  assert.deepEqual(r.sent.slice(1).map((m) => [m.token.slice(0, 5), m.data.kind, m.notification.body]).sort(), [
    ["fcm-a", "question", "Waiting for input"],
    ["fcm-b", "question", "Waiting for input"],
  ]);
});

test("a session this server runs: its question comes from session.pending, its turn end from its result", async () => {
  const r = rig();
  const a = r.devices.create("Pixel").device;
  r.devices.setPushToken(a.id, token("fcm-a"));
  r.chosen.set("claude", CLAUDE_ID, true);
  r.driven.add(CLAUDE_KEY);
  r.put(s("claude", CLAUDE_ID, "open-idle"));
  r.put(s("claude", CLAUDE_ID, "running"));
  const q: PendingQuestionView = { requestId: "q", toolUseId: "t", toolName: "Bash", kind: "approval", input: {}, title: null, description: null };
  r.push.serverMessage({ type: "session.pending", key: CLAUDE_KEY, questions: [q] });
  r.push.serverMessage({ type: "hello", sessions: [], projects: [] });
  r.setPending([q]);
  r.put(s("claude", CLAUDE_ID, "waiting-input"));
  r.push.serverMessage({ type: "session.pending", key: CLAUDE_KEY, questions: [] });
  r.setPending([]);
  r.put(s("claude", CLAUDE_ID, "running"));
  r.claudeResult(CLAUDE_KEY, { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", result: "API Error: 529 Overloaded" });
  r.put(s("claude", CLAUDE_ID, "open-idle"));
  await r.push.settled();
  assert.deepEqual(r.sent.map((m) => [m.data.kind, m.notification.body]), [
    ["question", "Waiting for input: Allow Bash?"],
    ["turn.failed", "Ended with an error: API Error: 529 Overloaded"],
  ]);
});

test("a Codex thread this server drives: the driver connection's status and report give one notice, whatever the index says", async () => {
  const r = rig();
  const a = r.devices.create("Pixel").device;
  r.devices.setPushToken(a.id, token("fcm-a"));
  r.chosen.set("codex", CODEX_ID, true);
  r.put(s("codex", CODEX_ID, "open-idle"));
  r.driven.add(CODEX_KEY);
  assert.ok(r.hooked());
  r.codexStatus(CODEX_KEY, { type: "active", activeFlags: [] });
  r.put(s("codex", CODEX_ID, "running"));
  r.put(s("codex", CODEX_ID, "open-idle"));
  r.codexStatus(CODEX_KEY, { type: "idle" });
  await r.push.settled();
  assert.equal(r.sent.length, 0, "the status change waits for the turn's report");
  r.codexTurn(CODEX_KEY, { status: "inProgress" });
  r.codexTurn(CODEX_KEY, { status: "failed", error: { message: "stream disconnected", codexErrorInfo: null, additionalDetails: null, misalignment: null } });
  await r.push.settled();
  assert.deepEqual(r.sent.map((m) => [m.data.kind, m.notification.body]), [["turn.failed", "Ended with an error: stream disconnected"]]);
  r.push.close();
  assert.equal(r.hooked(), false, "close unsubscribes from the drivers");
  r.driven.clear();
  r.put(s("codex", CODEX_ID, "running"));
  r.put(s("codex", CODEX_ID, "open-idle"));
  await r.push.settled();
  assert.equal(r.sent.length, 1, "and from the list");
});

test("sessions off the list, subagent threads, the first sweep and running to closed push nothing", async () => {
  const r = rig();
  const a = r.devices.create("Pixel").device;
  r.devices.setPushToken(a.id, token("fcm-a"));
  r.put(s("claude", CLAUDE_ID, "running"));
  r.put(s("claude", CLAUDE_ID, "open-idle"));
  r.chosen.set("codex", CODEX_ID, true);
  r.put(s("codex", CODEX_ID, "running"));
  const child = { key: "codex:acct:019a0000-0000-7000-8000-0000000000c1", id: "019a0000-0000-7000-8000-0000000000c1", parentKey: CODEX_KEY };
  r.put(s("codex", child.id, "running", child));
  r.put(s("codex", child.id, "open-idle", child));
  // The daemon went away: the index's fallback reads the thread closed.
  r.put(s("codex", CODEX_ID, "closed"));
  await r.push.settled();
  assert.deepEqual(r.sent, []);
  assert.deepEqual(r.logs, [`push: no notice for ${CODEX_KEY}: running became closed: the process or the daemon went away`]);
});

test("a token FCM calls gone is dropped from its device; other failures are logged and the token stays", async () => {
  const r = rig((m) => m.token === token("fcm-gone")
    ? { ok: false, status: 404, error: "NOT_FOUND: Requested entity was not found.", tokenGone: true }
    : { ok: false, status: 503, error: "UNAVAILABLE: try later", tokenGone: false });
  const a = r.devices.create("old phone").device;
  const b = r.devices.create("phone").device;
  r.devices.setPushToken(a.id, token("fcm-gone"));
  r.devices.setPushToken(b.id, token("fcm-busy"));
  r.chosen.set("claude", CLAUDE_ID, true);
  r.put(s("claude", CLAUDE_ID, "running"));
  r.put(s("claude", CLAUDE_ID, "open-idle"));
  await r.push.settled();
  assert.equal(r.devices.pushTokenOf(a.id), null);
  assert.equal(r.devices.pushTokenOf(b.id), token("fcm-busy"));
  assert.deepEqual(r.logs.slice(1).sort(), [
    `push: dropped token fcm-gone... of device ${a.id} (NOT_FOUND: Requested entity was not found.)`,
    `push: turn.completed ${CLAUDE_KEY} to device ${b.id} failed (UNAVAILABLE: try later)`,
  ]);
  assert.ok(!r.logs.some((l) => l.includes(token("fcm-busy")) || l.includes(token("fcm-gone"))), "tokens reach the log only as their first 8 characters");
});

test("a store that fails after FCM answered, a sender or a store that throws: logged, never an unhandled rejection or a throw into the index", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    const r = rig(() => ({ ok: false, status: 404, error: "UNREGISTERED", tokenGone: true }));
    const a = r.devices.create("Pixel").device;
    r.devices.setPushToken(a.id, token("fcm-a"));
    const realDrop = r.devices.dropPushToken.bind(r.devices);
    r.devices.dropPushToken = () => { throw new Error("database is locked"); };
    r.chosen.set("claude", CLAUDE_ID, true);
    r.put(s("claude", CLAUDE_ID, "running"));
    r.put(s("claude", CLAUDE_ID, "open-idle"));
    await r.push.settled();
    await new Promise((x) => setImmediate(x));
    assert.match(r.logs.at(-1)!, /^push: could not drop token fcm-a:AP\.\.\. of device .* \(UNREGISTERED\): database is locked$/);
    r.devices.dropPushToken = realDrop;

    const t = rig(() => { throw new Error("socket closed"); });
    const b = t.devices.create("Pixel").device;
    t.devices.setPushToken(b.id, token("fcm-b"));
    t.chosen.set("claude", CLAUDE_ID, true);
    t.put(s("claude", CLAUDE_ID, "running"));
    t.put(s("claude", CLAUDE_ID, "open-idle"));
    await t.push.settled();
    assert.match(t.logs.at(-1)!, /failed \(socket closed\)$/);

    // A store that fails while the index publishes: the index's other listeners still get the event.
    const seen: string[] = [];
    t.index.subscribe((e) => seen.push(e.type));
    t.devices.close();
    t.put(s("claude", CLAUDE_ID, "running"));
    t.put(s("claude", CLAUDE_ID, "open-idle"));
    assert.deepEqual(seen, ["upsert", "upsert"]);
    assert.match(t.logs.at(-1)!, /^push: /);
    await new Promise((x) => setImmediate(x));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a notice too large for FCM goes in its brief form, and the log says so", async () => {
  const r = rig();
  const a = r.devices.create("Pixel").device;
  r.devices.setPushToken(a.id, token("fcm-a"));
  r.chosen.set("claude", CLAUDE_ID, true);
  r.driven.add(CLAUDE_KEY);
  r.put(s("claude", CLAUDE_ID, "open-idle"));
  r.put(s("claude", CLAUDE_ID, "running"));
  r.claudeResult(CLAUDE_KEY, { subtype: "success", is_error: true, result: `API Error: ${"긴 응답 ".repeat(800)}` });
  r.put(s("claude", CLAUDE_ID, "open-idle"));
  await r.push.settled();
  assert.deepEqual(r.sent[0]!.notification, { title: "claude 세션", body: "Ended with an error (see the reason in the app)" });
  assert.deepEqual(r.logs, [`push: turn.failed ${CLAUDE_KEY} to 1 device(s), brief form (over FCM's 4096 bytes)`]);
});

test("driveHooks: main.ts's wiring of the two drivers", () => {
  const calls: string[] = [];
  const unsub = (name: string) => () => calls.push(`off ${name}`);
  const q = (id: string): PendingQuestionView => ({ requestId: id, toolUseId: id, toolName: "Bash", kind: "approval", input: {}, title: null, description: null });
  const hooks = driveHooks(
    {
      pendingOf: (key) => (key === CLAUDE_KEY ? [q("c")] : []),
      isDriven: (key) => key === CLAUDE_KEY,
      onResult: () => { calls.push("claude onResult"); return unsub("result"); },
      onRunExit: () => { calls.push("claude onRunExit"); return unsub("exit"); },
    },
    {
      pendingOf: (key) => (key === CODEX_KEY ? [q("x")] : []),
      isDriven: (key) => key === CODEX_KEY,
      onTurnEnd: () => { calls.push("codex onTurnEnd"); return unsub("turn"); },
      onThreadStatus: () => { calls.push("codex onThreadStatus"); return unsub("status"); },
    },
  );
  assert.deepEqual([CLAUDE_KEY, CODEX_KEY, "other"].map((k) => [hooks.drives(k), hooks.statusFromDriver(k), hooks.pending(k).map((p) => p.requestId)]), [
    [true, false, ["c"]],
    [true, true, ["x"]],
    [false, false, []],
  ]);
  hooks.claudeResults(() => {})();
  hooks.claudeExits(() => {})();
  hooks.codexTurns(() => {})();
  hooks.codexStatuses(() => {})();
  assert.deepEqual(calls, ["claude onResult", "off result", "claude onRunExit", "off exit", "codex onTurnEnd", "off turn", "codex onThreadStatus", "off status"]);
});
