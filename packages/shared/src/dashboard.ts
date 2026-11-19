// The dashboard (DESIGN.md 6j): what needs the user, the work that runs, and how usage moved.
// The server reads it for every session on the list (DESIGN.md 6d) in one answer, so the page does
// not ask each session's 작업 list on its own.
//
//   GET /api/dashboard/work    -> DashboardWork
//   GET /api/usage/history     -> UsageHistory (the last 7 days of every account's windows)

import type { AgentAction, SessionAgentView } from "./agents.ts";
import type { AccountId, Owner, ProviderId, SessionSummary, UnifiedStatus } from "./index.ts";

/** The session a dashboard row belongs to: enough to name it and to open it (`?s=<key>`). */
export interface DashboardSessionRef {
  key: string;
  provider: ProviderId;
  account: AccountId;
  /** The name the user gave, else the generated title, else the first prompt, else the short id. */
  label: string;
  cwd: string | null;
  status: UnifiedStatus;
  owner: Owner;
}

/**
 * A session that needs the user.
 * question  a session this server drives waits on a question or an approval; the page answers it
 *           with the session's `session.pending` questions (lib/pending.ts)
 * waiting   a session waits for input that another client holds (a terminal, `codex agents`);
 *           it is answered there
 * error     the session's last turn ended on an error (Claude: an API error as the last message of
 *           the transcript; Codex: the thread's systemError). A message continues it.
 */
export type DashboardAttention =
  | {
      kind: "question";
      session: DashboardSessionRef;
      /** The session's index entry, for the composer that answers in place (the page prefers its /ws copy). */
      summary: SessionSummary;
      /** When the session began to wait, ms; null when it began before this server saw it. */
      since: number | null;
      /** The questions' titles, for the card before the questions themselves arrive over /ws. */
      titles: string[];
    }
  | { kind: "waiting"; session: DashboardSessionRef; since: number | null; reason: string }
  | {
      kind: "error";
      session: DashboardSessionRef;
      summary: SessionSummary;
      /** When the error was written, ms. */
      at: number | null;
      message: string;
      /** The provider's error code (Claude `rate_limit`, `server_error`, ...), when it gives one. */
      code: string | null;
      /** Sending a message to the session; disabled with the reason when a terminal holds it. */
      send: AgentAction;
    };

/** A turn in progress. 멈추기 interrupts it (`thread.interrupt` over /ws). */
export interface DashboardTurn {
  session: DashboardSessionRef;
  /** When the session began to run (running or waiting since), ms; null when unknown. */
  startedAt: number | null;
  stop: AgentAction;
}

/**
 * A subagent or workflow of a session on the list, with the actions of the 작업 tab (DESIGN.md
 * 6i): the running rows of every open session, and its workflows that stopped and can run again
 * (`resume` present). A workflow's phases and agents stay in the 작업 tab; the row carries how far
 * its agents got.
 */
export interface DashboardTask {
  session: DashboardSessionRef;
  agent: DashboardAgent;
}

export type DashboardAgent = Omit<SessionAgentView, "workflow"> & {
  /** A workflow's agents that finished, of all it has started; null for a subagent. */
  progress: { done: number; total: number } | null;
};

export interface DashboardWork {
  generatedAt: number;
  attention: DashboardAttention[];
  turns: DashboardTurn[];
  tasks: DashboardTask[];
  /**
   * What this answer cost: open sessions looked at, of them the ones whose files were read again
   * (running rows, or a change in the session or its folders) and the ones answered from the last
   * read, and the server time in ms.
   */
  stats: { open: number; reread: number; reused: number; tails: number; ms: number };
}

/** One recorded reading of a window: written when the value changed, so it holds until the next. */
export interface UsageHistoryPoint {
  /** When it was read, ms. */
  at: number;
  usedPercent: number;
  resetsAt: number | null;
}

/** One account's window over time, oldest first. */
export interface UsageHistorySeries {
  provider: ProviderId;
  account: AccountId;
  /** The window id (Claude five_hour, seven_day; Codex primary, secondary). */
  window: string;
  minutes: number | null;
  /** The last reading before `from` comes first when there is one, so the line starts at the left edge. */
  points: UsageHistoryPoint[];
}

export interface UsageHistory {
  from: number;
  to: number;
  series: UsageHistorySeries[];
}
