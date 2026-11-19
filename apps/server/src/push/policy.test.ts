import { test } from "node:test";
import assert from "node:assert/strict";
import type { IndexEvent, PendingQuestionView, SessionSummary, UnifiedStatus } from "@maru/shared";
import { claudeExitOutcome, claudeOutcome, codexOutcome, codexStatus } from "./outcome.ts";
import { sessionDisplayName as sessionTitle } from "@maru/shared";
import { PushPolicy, type PolicyContext, type PushNotice } from "./policy.ts";

const KEY = "claude:acct:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CX = "codex:acct:019a0000-0000-7000-8000-000000000001";

function s(status: UnifiedStatus, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    key: KEY, provider: "claude", account: "acct", id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", cwd: "/x", name: "blog 손보기",
    title: null, preview: null, status, owner: "ui", pid: null, tmuxPane: null, parentKey: null, updatedAt: 1, createdAt: null,
    sizeBytes: null, entrypoint: null, ...over,
  };
}
const cx = (status: UnifiedStatus) => s(status, { key: CX, provider: "codex", id: "019a0000-0000-7000-8000-000000000001", name: "릴리스" });

const up = (session: SessionSummary): IndexEvent => ({ type: "upsert", session });
const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({ pending: () => [], drives: () => false, statusFromDriver: () => false, ...over });
/** A Claude session this server runs: questions as pending lists, turn ends as result reports. */
const claudeDriven = ctx({ drives: () => true });
/** A Codex thread this server drives: its status comes from the driver connection. */
const codexDriven = ctx({ drives: () => true, statusFromDriver: (key) => key === CX });
const brief = (ns: PushNotice[]) => ns.map((n) => `${n.kind} ${n.body}`);

/** Feeds index statuses in order and collects every notice. */
function walk(p: PushPolicy, statuses: UnifiedStatus[], c = ctx(), make = s): string[] {
  return statuses.flatMap((st) => brief(p.observe(up(make(st)), c)));
}

const ask = (over: Partial<PendingQuestionView>): PendingQuestionView => ({
  requestId: "r1", toolUseId: "t1", toolName: "Bash", kind: "approval", input: {}, title: null, description: null, ...over,
});

test("a session's first event is only remembered, so a restart pushes nothing", () => {
  const p = new PushPolicy();
  assert.deepEqual(walk(p, ["waiting-input"]), []);
  assert.deepEqual(walk(p, ["waiting-input"]), [], "no change");
  assert.deepEqual(walk(p, ["running", "open-idle"]), ["turn.completed Response finished"]);
});

test("a session this server does not run: status alone, and running to closed is no finished turn", () => {
  const notes: string[] = [];
  const p = new PushPolicy((key, why) => notes.push(why));
  walk(p, ["closed"]);
  assert.deepEqual(walk(p, ["running", "waiting-input", "running", "open-idle"]), [
    "question Waiting for input",
    "turn.completed Response finished",
  ]);
  // A terminal quit mid-turn, or the Codex daemon went away and every thread reads closed.
  assert.deepEqual(walk(p, ["running", "closed"]), []);
  assert.deepEqual(notes, ["running became closed: the process or the daemon went away"]);
  // Answered or withdrawn elsewhere, closed by the idle closer, opened: none is a turn end.
  assert.deepEqual(walk(p, ["open-idle", "closed", "open-idle", "waiting-input", "open-idle", "closed"]), ["question Waiting for input"]);
  assert.deepEqual(walk(p, ["running", "error"]), ["turn.failed Ended with an error"], "Codex systemError");
  assert.deepEqual(walk(p, ["open-idle", "error"]), [], "this turn already got its turn.failed");
  assert.deepEqual(walk(p, ["waiting-input", "error"]), ["question Waiting for input", "turn.failed Ended with an error"]);
});

test("the Codex daemon going down pushes nothing: the index's fallback reads every thread closed", () => {
  const p = new PushPolicy();
  const keys = ["a", "b", "c"].map((x) => `codex:acct:019a0000-0000-7000-8000-00000000000${x}`);
  const thread = (key: string, status: UnifiedStatus) => up(s(status, { key, provider: "codex" }));
  for (const k of keys) p.observe(thread(k, "running"), ctx());
  for (const k of keys) p.observe(thread(k, "running"), ctx());
  assert.deepEqual(keys.flatMap((k) => p.observe(thread(k, "closed"), ctx())), []);
  // A thread this server drives ignores the index: the driver connection has its status.
  walk(p, ["running"], codexDriven, cx);
  p.driverStatus(CX, "running", codexDriven);
  assert.deepEqual(walk(p, ["closed"], codexDriven, cx), []);
});

test("questions of a session this server runs come from its pending list, each once, named as the web and the app do", () => {
  const p = new PushPolicy();
  walk(p, ["open-idle"], claudeDriven);
  walk(p, ["running"], claudeDriven);
  const color = ask({ requestId: "r1", toolUseId: "t1", kind: "question", toolName: "AskUserQuestion", input: { questions: [{ question: "어느 색으로 할까요?", options: [] }] } });
  const bash = ask({ requestId: "r2", toolUseId: "t2" });
  const [n] = p.pendingChanged(KEY, [color]);
  assert.deepEqual(n, {
    kind: "question", sessionKey: KEY, title: "blog 손보기", body: "Waiting for input: 어느 색으로 할까요?",
    brief: { title: "blog 손보기", body: "Waiting for input (see the question in the app)" },
  });
  // The status that follows the question says nothing more.
  assert.deepEqual(walk(p, ["waiting-input"], claudeDriven), []);
  assert.deepEqual(p.pendingChanged(KEY, [color]), [], "the same list again");
  assert.deepEqual(brief(p.pendingChanged(KEY, [color, bash])), ["question Waiting for input: Allow Bash? and 1 more"]);
  assert.deepEqual(p.pendingChanged(KEY, []), []);
  // Sent again after a daemon reconnect (same item): no second notice.
  assert.deepEqual(p.pendingChanged(KEY, [bash]), []);
  walk(p, ["running", "open-idle"], claudeDriven);
  walk(p, ["running"], claudeDriven);
  assert.deepEqual(brief(p.pendingChanged(KEY, [ask({ requestId: "r3", toolUseId: "t3", kind: "plan", toolName: "ExitPlanMode" })])), ["question Waiting for input: Approve the plan?"]);
  assert.deepEqual(p.pendingChanged("claude:acct:other", [color]), [], "not in the list");
});

test("questions open before a restart or before the status showed the turn are not notified again", () => {
  const p = new PushPolicy();
  const open = ask({ requestId: "r1", toolUseId: "t1" });
  const c = ctx({ drives: () => true, pending: () => [open] });
  walk(p, ["waiting-input"], c);
  assert.deepEqual(p.pendingChanged(KEY, [open]), [], "adopted with the run after a restart");
  // A question that came while the index still read closed (a just started process).
  const q = new PushPolicy();
  walk(q, ["closed"], claudeDriven);
  assert.equal(q.pendingChanged(KEY, [open]).length, 1);
  assert.deepEqual(walk(q, ["waiting-input"], c), []);
  assert.deepEqual(q.pendingChanged(KEY, [open, ask({ requestId: "r2", toolUseId: "t2" })]).length, 1, "only the new one");
});

test("a Claude turn this server runs ends through its result, which comes before the idle", () => {
  const notes: string[] = [];
  const p = new PushPolicy((key, why) => notes.push(why));
  walk(p, ["open-idle"], claudeDriven);
  walk(p, ["running"], claudeDriven);
  assert.deepEqual(p.turnEnded(KEY, { result: "failed", reason: "API Error: 529\n overloaded" }, claudeDriven), []);
  assert.deepEqual(walk(p, ["open-idle"], claudeDriven), ["turn.failed Ended with an error: API Error: 529 overloaded"]);
  // An interrupted turn: no notice, whoever stopped it is looking at it (user decision 2026-11-16).
  walk(p, ["running"], claudeDriven);
  p.turnEnded(KEY, { result: "interrupted" }, claudeDriven);
  assert.deepEqual(walk(p, ["open-idle"], claudeDriven), []);
  assert.equal(notes.pop(), "an interrupted turn: whoever stopped it is looking at it");
  walk(p, ["running"], claudeDriven);
  p.turnEnded(KEY, { result: "completed" }, claudeDriven);
  assert.deepEqual(walk(p, ["open-idle"], claudeDriven), ["turn.completed Response finished"]);
  // The process crashed, or the run ended while the host connection was down: no result, no notice.
  // Also for a run first seen running after a restart.
  const adopted = new PushPolicy((key, why) => notes.push(`adopted: ${why}`));
  walk(adopted, ["running"], claudeDriven);
  assert.deepEqual(walk(adopted, ["closed"], ctx()), []);
  assert.equal(notes.pop(), "adopted: this server's turn became closed without a report");
  walk(p, ["running"], claudeDriven);
  assert.deepEqual(walk(p, ["closed"], ctx()), [], "the run is gone from ClaudeRuns by the time the index reads closed");
  walk(p, ["running"], claudeDriven);
  assert.deepEqual(walk(p, ["open-idle"], claudeDriven), []);
  assert.deepEqual(notes, ["this server's turn became closed without a report", "this server's turn became open-idle without a report"]);
  // A report kept from before a question belongs to an earlier turn.
  walk(p, ["running"], claudeDriven);
  p.turnEnded(KEY, { result: "failed", reason: "old" }, claudeDriven);
  walk(p, ["waiting-input", "running"], claudeDriven);
  p.turnEnded(KEY, { result: "completed" }, claudeDriven);
  assert.deepEqual(walk(p, ["open-idle"], claudeDriven), ["turn.completed Response finished"]);
  // The error status takes the waiting failure's reason; a report with no turn says nothing.
  walk(p, ["running"], claudeDriven);
  p.turnEnded(KEY, { result: "failed", reason: "boom" }, claudeDriven);
  assert.deepEqual(walk(p, ["error"], claudeDriven), ["turn.failed Ended with an error: boom"]);
  assert.deepEqual(p.turnEnded(KEY, { result: "failed", reason: "late" }, claudeDriven), []);
  assert.equal(notes.at(-1), "a failed turn report with no turn under way");
});

test("a Claude process of this server that ends in an error mid-turn is a failure, before or after the status changes", () => {
  const p = new PushPolicy();
  walk(p, ["open-idle"], claudeDriven);
  // The exit comes first (ClaudeRuns tells the push before the index), then the index reads closed.
  walk(p, ["running"], claudeDriven);
  const crash = claudeExitOutcome({ code: "error", error: "Claude run failed" })!;
  assert.deepEqual(brief(p.turnEnded(KEY, crash, claudeDriven)), []);
  assert.deepEqual(walk(p, ["closed"], ctx()), ["turn.failed Ended with an error: Abnormal exit: Claude run failed"]);
  // The index reads the end first; the exit then sends it.
  walk(p, ["running"], claudeDriven);
  assert.deepEqual(walk(p, ["closed"], ctx()), []);
  const lost = claudeExitOutcome({ code: "error", error: "The Claude run ended while the connection to the session host was down" })!;
  assert.deepEqual(brief(p.turnEnded(KEY, lost, claudeDriven)), ["turn.failed Ended with an error: Abnormal exit: The Claude run ended while the connection to the session host was down"]);
  // A normal or interrupted exit ends no turn; an error exit while idle has no turn to fail.
  assert.equal(claudeExitOutcome({ code: "done" }), null);
  assert.equal(claudeExitOutcome({ code: "interrupted" }), null);
  walk(p, ["running"], claudeDriven);
  p.turnEnded(KEY, { result: "completed" }, claudeDriven);
  assert.deepEqual(walk(p, ["open-idle"], claudeDriven), ["turn.completed Response finished"]);
  assert.deepEqual(brief(p.turnEnded(KEY, claudeExitOutcome({ code: "error" })!, claudeDriven)), []);
  // The next turn's start forgets a wait that no report ended.
  walk(p, ["running"], claudeDriven);
  walk(p, ["closed"], ctx());
  walk(p, ["running"], claudeDriven);
  p.turnEnded(KEY, { result: "completed" }, claudeDriven);
  assert.deepEqual(walk(p, ["open-idle"], claudeDriven), ["turn.completed Response finished"]);
});

test("a Codex thread this server drives: driver status and report in the daemon's order, one notice of the right kind", () => {
  const p = new PushPolicy();
  walk(p, ["open-idle"], codexDriven, cx);
  // The daemon's order on one connection: active, turn/started, idle, turn/completed.
  const turn = (outcome: Parameters<PushPolicy["turnEnded"]>[1]) => [
    ...brief(p.driverStatus(CX, "running", codexDriven)),
    ...brief(p.driverStatus(CX, "open-idle", codexDriven)),
    ...brief(p.turnEnded(CX, outcome, codexDriven)),
  ];
  assert.deepEqual(turn({ result: "failed", reason: "stream disconnected" }), ["turn.failed Ended with an error: stream disconnected"]);
  assert.deepEqual(turn({ result: "interrupted" }), []);
  assert.deepEqual(turn({ result: "completed" }), ["turn.completed Response finished"]);
  // A goal's turns end while the thread stays active: the last report before the idle decides.
  p.driverStatus(CX, "running", codexDriven);
  p.turnEnded(CX, { result: "failed", reason: "first turn" }, codexDriven);
  p.turnEnded(CX, { result: "completed" }, codexDriven);
  assert.deepEqual(brief(p.driverStatus(CX, "open-idle", codexDriven)), ["turn.completed Response finished"]);
  // systemError does not wait; questions come from the pending list, not the status.
  p.driverStatus(CX, "running", codexDriven);
  assert.deepEqual(brief(p.driverStatus(CX, "waiting-input", codexDriven)), []);
  assert.deepEqual(brief(p.driverStatus(CX, "error", codexDriven)), ["turn.failed Ended with an error"]);
});

test("review R1 and R2: index statuses in any order around the driver's events change nothing", () => {
  // R1: the index reads idle, then the next turn running, before turn 1's report.
  {
    const p = new PushPolicy();
    walk(p, ["running"], codexDriven, cx);
    const out: string[] = [];
    out.push(...brief(p.driverStatus(CX, "running", codexDriven)));
    out.push(...walk(p, ["open-idle"], codexDriven, cx));
    out.push(...brief(p.driverStatus(CX, "open-idle", codexDriven)));
    out.push(...walk(p, ["running"], codexDriven, cx));
    out.push(...brief(p.turnEnded(CX, { result: "failed", reason: "turn1 boom" }, codexDriven)));
    out.push(...brief(p.driverStatus(CX, "running", codexDriven)));
    out.push(...walk(p, ["open-idle"], codexDriven, cx));
    out.push(...brief(p.driverStatus(CX, "open-idle", codexDriven)));
    out.push(...brief(p.turnEnded(CX, { result: "completed" }, codexDriven)));
    assert.deepEqual(out, ["turn.failed Ended with an error: turn1 boom", "turn.completed Response finished"]);
  }
  // R2: a short failing turn ends on the driver before the index ever shows it running.
  {
    const p = new PushPolicy();
    walk(p, ["open-idle"], codexDriven, cx);
    const out: string[] = [];
    out.push(...brief(p.driverStatus(CX, "running", codexDriven)));
    out.push(...brief(p.driverStatus(CX, "open-idle", codexDriven)));
    out.push(...brief(p.turnEnded(CX, { result: "failed", reason: "quota" }, codexDriven)));
    out.push(...walk(p, ["running", "open-idle"], codexDriven, cx));
    assert.deepEqual(out, ["turn.failed Ended with an error: quota"]);
  }
});

test("a thread this server lets go is the index's again; the index's late view of the driver's turn adds nothing", () => {
  const p = new PushPolicy();
  walk(p, ["open-idle"], codexDriven, cx);
  p.driverStatus(CX, "running", codexDriven);
  walk(p, ["running"], codexDriven, cx);
  p.driverStatus(CX, "open-idle", codexDriven);
  assert.deepEqual(brief(p.turnEnded(CX, { result: "interrupted" }, codexDriven)), []);
  // 닫기 lets the thread go; the index only now reads the end of that same turn.
  const free = ctx();
  assert.deepEqual(walk(p, ["open-idle"], free, cx), []);
  // A later turn of another client is the index's own.
  assert.deepEqual(walk(p, ["running", "open-idle"], free, cx), ["turn.completed Response finished"]);
});

test("subagent threads and sessions that left the list push nothing; one that comes back starts over", () => {
  const p = new PushPolicy();
  const child = { parentKey: KEY, key: `${KEY}-child` };
  assert.deepEqual([up(s("closed", child)), up(s("running", child)), up(s("open-idle", child))].flatMap((e) => p.observe(e, ctx())), []);
  walk(p, ["running"]);
  p.observe({ type: "remove", key: KEY }, ctx());
  assert.deepEqual(walk(p, ["open-idle"]), [], "first event again");
  assert.deepEqual(p.turnEnded(`${KEY}-child`, { result: "failed", reason: "x" }, ctx()), [], "not tracked");
  assert.deepEqual(p.driverStatus(`${KEY}-child`, "running", ctx()), []);
});

test("titles: the list's name rule; the brief form leaves out the first message and the variable text", () => {
  assert.equal(sessionTitle({ name: "이름", title: "제목", preview: "첫 메시지", id: "0123456789" }), "이름");
  assert.equal(sessionTitle({ name: null, title: "제목", preview: "첫 메시지", id: "0123456789" }), "제목");
  assert.equal(sessionTitle({ name: "", title: null, preview: "첫 메시지", id: "0123456789" }), "첫 메시지");
  assert.equal(sessionTitle({ name: null, title: null, preview: null, id: "0123456789" }), "01234567");
  const p = new PushPolicy();
  const long = (st: UnifiedStatus) => s(st, { name: null, preview: "아주 긴 첫 메시지" });
  // First seen running (a run adopted after a restart): its report still decides.
  walk(p, ["running"], claudeDriven, long);
  p.turnEnded(KEY, { result: "failed", reason: "boom" }, claudeDriven);
  const [n] = p.observe(up(long("open-idle")), claudeDriven);
  assert.deepEqual([n!.title, n!.body, n!.brief], ["아주 긴 첫 메시지", "Ended with an error: boom", { title: "aaaaaaaa", body: "Ended with an error (see the reason in the app)" }]);
});

test("Claude outcomes: an interrupt is no failure though is_error; an API error carries its text (CLI 2.1.325 shapes)", () => {
  assert.deepEqual(claudeOutcome({
    type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming",
    errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
  }), { result: "interrupted" });
  assert.deepEqual(claudeOutcome({ subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools" }), { result: "interrupted" });
  assert.deepEqual(claudeOutcome({
    type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", result: "Not logged in \u00b7 Please run /login",
  }), { result: "failed", reason: "Not logged in \u00b7 Please run /login" });
  assert.deepEqual(claudeOutcome({ subtype: "success", is_error: false, terminal_reason: "completed", result: "ok" }), { result: "completed" });
  assert.deepEqual(claudeOutcome({ subtype: "success" }), { result: "completed" }, "no is_error");
  assert.deepEqual(claudeOutcome({ subtype: "error_max_turns", is_error: true, terminal_reason: "max_turns", errors: [] }), {
    result: "failed", reason: "Hit the turn limit",
  });
  assert.deepEqual(claudeOutcome({
    subtype: "error_during_execution", is_error: true, terminal_reason: "model_error", errors: ["[ede_diagnostic] x", "socket hang up"],
  }), { result: "failed", reason: "socket hang up" });
  assert.deepEqual(claudeOutcome({ subtype: "success", is_error: true, result: "  " }), { result: "failed", reason: null });
});

test("Codex outcomes follow the turn status; Codex statuses map as the index maps them", () => {
  assert.deepEqual(codexOutcome({ status: "completed", error: null }), { result: "completed" });
  assert.deepEqual(codexOutcome({ status: "interrupted", error: null }), { result: "interrupted" });
  assert.deepEqual(codexOutcome({
    status: "failed", error: { message: " stream disconnected before completion ", codexErrorInfo: null, additionalDetails: null, misalignment: null },
  }), { result: "failed", reason: "stream disconnected before completion" });
  assert.deepEqual(codexOutcome({ status: "failed", error: null }), { result: "failed", reason: null });
  assert.equal(codexOutcome({ status: "inProgress", error: null }), null);
  assert.equal(codexStatus({ type: "notLoaded" }), "closed");
  assert.equal(codexStatus({ type: "idle" }), "open-idle");
  assert.equal(codexStatus({ type: "systemError" }), "error");
  assert.equal(codexStatus({ type: "active", activeFlags: [] }), "running");
  assert.equal(codexStatus({ type: "active", activeFlags: ["waitingOnApproval"] }), "waiting-input");
  assert.equal(codexStatus({ type: "active", activeFlags: ["waitingOnUserInput"] }), "waiting-input");
  assert.equal(codexStatus({ type: "someday" } as never), null);
});
