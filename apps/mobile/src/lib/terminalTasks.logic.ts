// The terminal mode's agent panel on the phone (the web's terminalTasks.ts rules over its
// useSessionAgents list). The web reads GET /api/session-agents every few seconds; a device token may
// read that list but not its count, so the phone would pull the whole list again and again. The
// thread snapshot already carries the same agents and workflows as subagent records (kept live by
// the /ws stream), so the panel's rows are built from those: the same rows, with the web's own
// taskRows rules, and no stop or resume (those routes are not open to a device token).
import type { OrchestrationV2Subagent, SessionAgentView } from "@maru/shared";

/** A subagent record as the panel's list row. */
export function agentViewOf(s: OrchestrationV2Subagent): SessionAgentView {
  return {
    id: s.id,
    kind: s.workflow ? "workflow" : "agent",
    title: s.title ?? "",
    status: s.status,
    agentType: s.agentType ?? null,
    model: s.modelResolved ?? s.model,
    parentAgentId: null,
    childThreadId: s.childThreadId,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    completedAt: s.completedAt,
    ...(s.workflow ? { workflow: s.workflow } : {}),
  };
}

export function agentViewsOf(subagents: ReadonlyArray<OrchestrationV2Subagent>): SessionAgentView[] {
  return subagents.map(agentViewOf);
}
