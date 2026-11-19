// The 작업 tab's "완료 숨기기" (user request 2026-11-16, on by default; 중단됨 and 실패 hide too): which rows show, and the
// choice kept in this browser.

/**
 * A row that ended: completed, stopped or interrupted (중단됨), or failed (user requests). Running
 * rows stay in view.
 */
export function agentDone(a: { status: string; settling?: unknown }): boolean {
  return (a.status === "completed" || a.status === "cancelled" || a.status === "interrupted" || a.status === "failed") && a.settling === undefined;
}

/**
 * The agents to list: all, or without the finished ones. A finished agent stays when one of its
 * own subagents still shows, so that subagent keeps its place under it.
 */
export function visibleAgents<T extends { id: string; parentAgentId?: string | null; status: string; settling?: unknown }>(
  list: readonly T[],
  hideDone: boolean,
): { shown: T[]; hidden: number } {
  if (!hideDone) return { shown: [...list], hidden: 0 };
  const keep = new Set<string>();
  const byId = new Map(list.map((a) => [a.id, a]));
  for (const a of list) {
    if (agentDone(a)) continue;
    // Keep it and every ancestor up the chain.
    let cur: T | undefined = a;
    while (cur && !keep.has(cur.id)) {
      keep.add(cur.id);
      cur = cur.parentAgentId ? byId.get(cur.parentAgentId) : undefined;
    }
  }
  const shown = list.filter((a) => keep.has(a.id));
  return { shown, hidden: list.length - shown.length };
}

const KEY = "maru_agents_hide_done";

export function readHideDone(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeHideDone(on: boolean): void {
  try {
    if (on) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, "0");
  } catch {
    // Storage blocked: the choice lasts for this page.
  }
}
