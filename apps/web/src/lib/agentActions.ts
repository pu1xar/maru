// What a row of the 작업 tab offers (DESIGN.md 6i): the server marks each row's actions and why one
// cannot run now; these helpers turn that into the menu's entries, the buttons' tooltips and the
// words for a row's state.
import type { AgentAction, OrchestrationV2WorkflowAgent, SessionAgentView } from "@maru/shared";

/** Something the row's right-click menu can do. */
export type AgentMenuItem = "stop" | "resume" | "open";

/** The menu's entries for a row, in order; empty when the row offers nothing (the browser's menu stays). */
export function agentMenuItems(a: SessionAgentView): AgentMenuItem[] {
  const out: AgentMenuItem[] = [];
  if (a.stop) out.push("stop");
  if (a.resume) out.push("resume");
  if (a.childThreadId) out.push("open");
  return out;
}

/** The tooltip of an action's button or menu entry: its name, or why it cannot run now. */
export function actionTooltip(label: string, action: AgentAction): string {
  return action.enabled ? label : (action.reason ?? label);
}

/** The key that tells rows apart (an agent and a workflow never share one). */
export function agentRowKey(a: Pick<SessionAgentView, "kind" | "id">): string {
  return `${a.kind}:${a.id}`;
}

/**
 * A row's state in words. A subagent the user stopped and one its process left unfinished are both
 * 중단됨, as the conversation's subagent card calls them.
 */
export const AGENT_STATUS_LABEL: Record<SessionAgentView["status"], string> = {
  running: "Running",
  pending: "Pending",
  waiting: "Waiting for input",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  idle: "Idle",
};

const SETTLING_LABEL: Record<NonNullable<SessionAgentView["settling"]>, string> = {
  stopping: "Stopping",
  resuming: "Resuming",
};

/** The row's state, or the action on its way (중단하는 중, 이어서 실행 중). */
export function agentStatusLabel(a: Pick<SessionAgentView, "status" | "settling">): string {
  return a.settling ? SETTLING_LABEL[a.settling] : AGENT_STATUS_LABEL[a.status];
}

/** A row's state counts as active: it runs, waits, or an action on it is on its way. */
export function agentRowActive(a: Pick<SessionAgentView, "status" | "settling">): boolean {
  return a.settling !== undefined || a.status === "running" || a.status === "pending" || a.status === "waiting";
}

export const WORKFLOW_AGENT_STATE_LABEL: Record<OrchestrationV2WorkflowAgent["state"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

/**
 * A workflow agent's state for display. Once the workflow no longer runs, an agent its records
 * still show as running or queued ended with it: it takes the workflow's state.
 */
export function workflowAgentState(
  a: Pick<OrchestrationV2WorkflowAgent, "state">,
  endedAs: SessionAgentView["status"] | null,
): { status: string; label: string } {
  return endedAs && (a.state === "running" || a.state === "queued")
    ? { status: endedAs, label: AGENT_STATUS_LABEL[endedAs] }
    : { status: a.state, label: WORKFLOW_AGENT_STATE_LABEL[a.state] };
}
