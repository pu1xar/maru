// What the dashboard's running rows do (DESIGN.md 6j), in one place: a turn's 멈추기 goes over /ws
// like the composer's (`thread.interrupt`), a subagent's or workflow's 중단 and 이어서 실행 go to
// the 작업 tab's routes (DESIGN.md 6i). The rows' state and actions come from the server's
// SessionAgentView (DashboardAgent), read through taskActions only, so a change to that row shape
// (the 작업 tab's own state fields) lands here.
import type { AgentAction, DashboardAgent, DashboardTask, ResumeSessionWorkflowResult } from "@maru/shared";
import { useSyncExternalStore } from "react";

import { resumeSessionWorkflow, stopSessionAgent } from "~/projectsApi";
import { taskKey } from "./dashboardModel";
import { socketHub } from "./socket";

/** A row's 중단 and 이어서 실행, as the server offers them (absent: the row has none). */
export function taskActions(agent: DashboardAgent): { stop?: AgentAction; resume?: AgentAction } {
  return { ...(agent.stop ? { stop: agent.stop } : {}), ...(agent.resume ? { resume: agent.resume } : {}) };
}

/** Rows stopped from this page (taskKey), kept in the list so 이어서 실행 stays at hand. */
let stoppedHere: ReadonlySet<string> = new Set();
const stoppedListeners = new Set<() => void>();

function setStoppedHere(next: ReadonlySet<string>): void {
  stoppedHere = next;
  for (const l of [...stoppedListeners]) l();
}

export function useStoppedHere(): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      stoppedListeners.add(l);
      return () => void stoppedListeners.delete(l);
    },
    () => stoppedHere,
    () => stoppedHere,
  );
}

/** Lets go of the rows the server no longer lists (finished, or the session closed). */
export function keepStoppedHere(present: ReadonlySet<string>): void {
  const kept = new Set([...stoppedHere].filter((k) => present.has(k)));
  if (kept.size !== stoppedHere.size) setStoppedHere(kept);
}

export async function stopTask(t: DashboardTask): Promise<void> {
  await stopSessionAgent({ key: t.session.key, kind: t.agent.kind, id: t.agent.id });
  setStoppedHere(new Set(stoppedHere).add(taskKey(t)));
}

export function resumeTask(t: DashboardTask): Promise<ResumeSessionWorkflowResult> {
  return resumeSessionWorkflow({ key: t.session.key, id: t.agent.id });
}

/** reqIds of the interrupts sent from here, so a `command.error` that answers one shows. */
const sent = new Map<string, (error: string) => void>();
let listening = false;
let seq = 0;

/**
 * Interrupts the session's turn. Returns false when the socket is down. A refusal from the server
 * comes back later as `command.error` and goes to `onError`.
 */
export function interruptTurn(sessionKey: string, onError: (error: string) => void): boolean {
  if (!listening) {
    listening = true;
    socketHub().onMessage((msg) => {
      if (msg.type !== "command.error" || !msg.reqId) return;
      const report = sent.get(msg.reqId);
      if (!report) return;
      sent.delete(msg.reqId);
      report(msg.error);
    });
  }
  seq += 1;
  const reqId = `dashboard-${Date.now().toString(36)}-${seq}`;
  if (!socketHub().send({ type: "thread.interrupt", threadId: sessionKey, reqId })) return false;
  sent.set(reqId, onError);
  return true;
}
