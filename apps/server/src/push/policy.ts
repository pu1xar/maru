// When the server pushes to the Android app and what the notification says (DESIGN.md 2d, 푸시 알림).
// Pure: it reads the list's events, the questions and turn ends of the sessions this server runs,
// and answers notices. Which devices get them is service.ts (recipients).
import type { IndexEvent, PendingQuestionView, PushKind, SessionSummary, UnifiedStatus } from "@maru/shared";
import { pendingSummary, sessionDisplayName } from "@maru/shared";

/** One notification decided on, before it goes to the devices. */
export interface PushNotice {
  kind: PushKind;
  sessionKey: string;
  title: string;
  body: string;
  /**
   * The same notice without the parts that can grow (the question, the error reason, a session
   * named by its first message), for a message FCM would refuse as too large (fcm.ts).
   */
  brief: { title: string; body: string };
}

/**
 * How a turn ended, as its provider reports it (outcome.ts): a Claude result message of a process
 * this server runs, a Codex turn/completed of a thread it drives.
 */
export type TurnOutcome =
  | { result: "completed" }
  | { result: "interrupted" }
  | { result: "failed"; reason: string | null };

/** What the policy asks about a session while it decides (service.ts wires it to the drivers). */
export interface PolicyContext {
  /** The session's open questions this server holds (ClaudeRuns.pendingOf, CodexRuns.pendingOf). */
  pending(key: string): readonly PendingQuestionView[];
  /**
   * This server runs the session (ClaudeRuns.isDriven, CodexRuns.isDriven): its questions come as
   * pending lists (`pendingChanged`) and its turns end with a report (`turnEnded`).
   */
  drives(key: string): boolean;
  /**
   * The session's status comes from the driver connection (`driverStatus`), not from the index:
   * Codex threads this server drives (CodexRuns.isDriven).
   */
  statusFromDriver(key: string): boolean;
}

interface Tracked {
  session: SessionSummary;
  /** The status the index gave last. */
  index: UnifiedStatus;
  /** The status the driver connection gave last while the thread is driven; null before one. */
  driver: UnifiedStatus | null;
  /** This server ran the turn under way when it started, so the turn ends with its report. */
  owned: boolean;
  /** The turn's report, when it came before the status change. */
  outcome: TurnOutcome | null;
  /** The status left running before the turn's report came: the report sends the notice. */
  awaiting: boolean;
  /** The turn got its turn.failed. */
  failed: boolean;
  /** Questions already notified (PendingQuestionView toolUseId, else requestId). */
  asked: Set<string>;
}

const inTurn = (s: UnifiedStatus | null) => s === "running" || s === "waiting-input";
const askId = (q: PendingQuestionView) => q.toolUseId || q.requestId;

/**
 * Notices for the list's sessions (VisibleIndex: chosen top-level sessions; subagent threads are
 * skipped):
 *   question        a session this server runs gained an open question (the body names it with
 *                   pendingSummary, as the web and the app word it); any other session's status
 *                   became waiting-input
 *   turn.completed  a turn ended: this server's report says so, or for a session it does not run,
 *                   running became open-idle. An interrupted turn gets none: whoever stopped it is
 *                   looking at it (user decision 2026-11-16)
 *   turn.failed     the report says the turn ended in an error, or the status became error (Codex
 *                   systemError), or this server's Claude process ended in an error mid-turn
 *                   (crash, the host connection dropped: "비정상 종료"); once per turn
 *
 * - A session's first event (the first sweep after a start, a session just added to the list) is
 *   only remembered, so a restart does not push for every session
 * - A turn this server ran ends with a notice only through a report: the result, or the process's
 *   exit in an error (ClaudeRuns.onRunExit, which can come before or after the status change). A
 *   turn that ended with neither gets none: how it ended is not known
 * - For a session this server does not run, running becoming closed is a process leaving mid-turn
 *   (a terminal quit, the Codex daemon went away and the index fell back to its database), never a
 *   turn that finished, so it gets none
 * - Order: Claude reports before the host's idle on one connection (host/core.ts sends
 *   run.message, then run.state), so a report waits for the status change. A Codex thread this
 *   server drives takes its status from the driver connection, where the daemon sends status
 *   active, turn/started, status idle, turn/completed (7 of 7 turns, measured 2026-11-16), so the
 *   status change waits for the report. The index connection keeps no such order with the driver's
 *   (its status came before the driver's report in 3 of 4 turns, and can come after)
 */
export class PushPolicy {
  private tracked = new Map<string, Tracked>();
  private note: (key: string, why: string) => void;

  /** `note` hears why a turn end got no notice. */
  constructor(note: (key: string, why: string) => void = () => {}) {
    this.note = note;
  }

  /** One event of the list. */
  observe(e: IndexEvent, ctx: PolicyContext): PushNotice[] {
    if (e.type === "remove") {
      this.tracked.delete(e.key);
      return [];
    }
    const s = e.session;
    if (s.parentKey) return [];
    const t = this.tracked.get(s.key);
    if (!t) {
      // A turn already under way (a run adopted after a restart) is this server's if it runs it.
      this.tracked.set(s.key, {
        session: s, index: s.status, driver: null, owned: inTurn(s.status) && ctx.drives(s.key), outcome: null, awaiting: false,
        failed: false, asked: new Set(ctx.pending(s.key).map(askId)),
      });
      return [];
    }
    const prev = t.index;
    t.session = s;
    t.index = s.status;
    if (ctx.statusFromDriver(s.key)) return [];
    if (t.driver !== null) {
      // CodexRuns let the thread go (a 닫기, another client's turn). The index may still be showing
      // the turn the driver already ended, so the turn stays this server's (no notice without its
      // report, which no longer comes) until the index shows a new turn start.
      t.driver = null;
      t.outcome = null;
      t.awaiting = false;
    }
    return this.step(t, prev, s.status, ctx.drives(s.key), ctx);
  }

  /** A status of a Codex thread this server drives, from the driver connection (CodexRuns.onThreadStatus). */
  driverStatus(key: string, status: UnifiedStatus, ctx: PolicyContext): PushNotice[] {
    const t = this.tracked.get(key);
    if (!t) return [];
    const prev = t.driver;
    t.driver = status;
    if (prev === null) {
      if (inTurn(status)) this.startTurn(t, true, ctx);
      return [];
    }
    return this.step(t, prev, status, true, ctx);
  }

  /** The open questions this server holds for the session changed (a `session.pending`). */
  pendingChanged(key: string, questions: readonly PendingQuestionView[]): PushNotice[] {
    const t = this.tracked.get(key);
    if (!t) return [];
    const fresh = questions.filter((q) => !t.asked.has(askId(q)));
    for (const q of questions) t.asked.add(askId(q));
    const first = fresh[0];
    if (!first) return [];
    return [questionNotice(t.session, [first, ...questions.filter((q) => q !== first)])];
  }

  /** A turn of the session ended as its provider reports (outcome.ts). */
  turnEnded(key: string, outcome: TurnOutcome, ctx: PolicyContext): PushNotice[] {
    const t = this.tracked.get(key);
    if (!t) return [];
    if (t.awaiting) {
      t.awaiting = false;
      return this.ended(t, outcome);
    }
    if (inTurn(ctx.statusFromDriver(key) ? t.driver : t.index)) {
      t.outcome = outcome;
      return [];
    }
    this.note(key, `a ${outcome.result} turn report with no turn under way`);
    return [];
  }

  private step(t: Tracked, prev: UnifiedStatus, next: UnifiedStatus, drives: boolean, ctx: PolicyContext): PushNotice[] {
    if (prev === next) return [];
    if (inTurn(next)) {
      if (!inTurn(prev)) this.startTurn(t, drives, ctx);
      // A question: a report kept from before belongs to an earlier turn.
      else if (next === "waiting-input") t.outcome = null;
      return next === "waiting-input" && !t.owned ? [questionNotice(t.session, [])] : [];
    }
    if (next === "error") {
      const o = take(t);
      t.awaiting = false;
      if (t.failed) return [];
      t.failed = true;
      return [failedNotice(t.session, o?.result === "failed" ? o.reason : null)];
    }
    if (prev !== "running") {
      t.outcome = null;
      t.awaiting = false;
      return [];
    }
    const o = take(t);
    if (o) return this.ended(t, o);
    if (t.owned) {
      // The driver connection sends the report right after the status (see the class comment); a
      // Claude process that ended in an error reports its exit after the status may have changed.
      t.awaiting = true;
      if (!ctx.statusFromDriver(t.session.key)) this.note(t.session.key, `this server's turn became ${next} without a report`);
      return [];
    }
    if (next === "closed") {
      this.note(t.session.key, "running became closed: the process or the daemon went away");
      return [];
    }
    return [completedNotice(t.session)];
  }

  private startTurn(t: Tracked, owned: boolean, ctx: PolicyContext): void {
    t.owned = owned;
    t.outcome = null;
    t.awaiting = false;
    t.failed = false;
    // Questions already open (asked before the status showed the turn) were notified then.
    t.asked = new Set(ctx.pending(t.session.key).map(askId));
  }

  private ended(t: Tracked, o: TurnOutcome): PushNotice[] {
    t.outcome = null;
    if (o.result === "interrupted") {
      this.note(t.session.key, "an interrupted turn: whoever stopped it is looking at it");
      return [];
    }
    if (o.result === "completed") return [completedNotice(t.session)];
    t.failed = true;
    return [failedNotice(t.session, o.reason)];
  }
}

function take(t: Tracked): TurnOutcome | null {
  const o = t.outcome;
  t.outcome = null;
  return o;
}

/** The title of a brief notice: the name rule without the first message. */
function briefTitle(s: SessionSummary): string {
  return s.name || s.title || s.id.slice(0, 8);
}

/** `pending[0]` is the question the body names; the rest are counted. */
export function questionNotice(s: SessionSummary, pending: readonly PendingQuestionView[]): PushNotice {
  const first = pending[0];
  const more = pending.length > 1 ? ` and ${pending.length - 1} more` : "";
  const body = first ? `Waiting for input: ${pendingSummary(first)}${more}` : "Waiting for input";
  return {
    kind: "question", sessionKey: s.key, title: sessionDisplayName(s), body,
    brief: { title: briefTitle(s), body: first ? "Waiting for input (see the question in the app)" : body },
  };
}

export function completedNotice(s: SessionSummary): PushNotice {
  const body = "Response finished";
  return { kind: "turn.completed", sessionKey: s.key, title: sessionDisplayName(s), body, brief: { title: briefTitle(s), body } };
}

export function failedNotice(s: SessionSummary, reason: string | null): PushNotice {
  const why = reason?.replace(/\s+/g, " ").trim();
  return {
    kind: "turn.failed", sessionKey: s.key, title: sessionDisplayName(s), body: why ? `Ended with an error: ${why}` : "Ended with an error",
    brief: { title: briefTitle(s), body: why ? "Ended with an error (see the reason in the app)" : "Ended with an error" },
  };
}
