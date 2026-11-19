// The terminal mode's agent panel (DESIGN.md 6i, ↓ 작업 목록): the rows Claude Code 2.1.325 draws
// under the input's footer while background agents and workflows run, and the ↓ / Enter / x keys
// that move through them (measured: tmux captures of the CLI, and its bundle's footer code).
//
// Rows come from the session's agent list (GET /api/session-agents, lib/sessionAgents.ts). That
// hook is read in one place, useTerminalTasks.ts; this file holds the pure rules.
import type { SessionAgentView } from "@maru/shared";

import { agentRowActive, agentStatusLabel } from "../../lib/agentActions.ts";

/** Agent rows drawn at once; the rest fold into "↑ N more" / "↓ N more" (bundle `IY=5`). */
export const PANEL_ROWS = 5;
/** An ended row stays this long with its end color before it leaves (measured 20 to 25 s). */
export const ENDED_ROW_MS = 25_000;
/** Cells of a workflow's progress bar (measured: 20). */
export const WORKFLOW_BAR = 20;

export type TaskGlyphTone = "viewing" | "idle" | "stopped" | "done";

export interface TaskRow {
  /** "main" for the session's own conversation, else the agent row's key. */
  key: string;
  kind: "main" | "agent" | "workflow";
  /** Thread to open with Enter (main: the session; an agent: its transcript). */
  threadId: string | null;
  /** ⏺ for the conversation on screen, ◯ for the others. */
  glyph: "⏺" | "◯";
  tone: TaskGlyphTone;
  name: string;
  detail: string;
  /** The right-aligned part: time and tokens, or a workflow's bar and counts. */
  right: string;
  bar?: { done: number; total: number };
  agent?: SessionAgentView;
}

/** "11s", "1m21s", "1h02m" as the panel counts (bundle `vlt`). */
export function panelElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`;
}

function compactTokens(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1, minimumFractionDigits: n >= 1000 ? 1 : 0 }).format(n).toLowerCase();
}

/** Whether a row is listed: active (running, waiting, a stop or resume on its way), or ended within ENDED_ROW_MS. */
function listed(a: SessionAgentView, now: number): boolean {
  if (agentRowActive(a)) return true;
  const ended = Date.parse(a.completedAt ?? a.updatedAt ?? "");
  return Number.isFinite(ended) && now - ended <= ENDED_ROW_MS;
}

/**
 * The panel's rows: "main" first, then the agents and workflows that run or just ended, in their
 * list order. Empty when nothing runs (the CLI shows no panel then). The row whose thread is on
 * screen gets ⏺; an ended agent's ◯ turns red (stopped) or green (completed), as measured.
 */
export function taskRows(agents: ReadonlyArray<SessionAgentView>, now: number, sessionKey: string, viewingThreadId: string): TaskRow[] {
  // The list also holds background shell commands and Monitors (the 작업 tab's rows); the CLI's
  // agent panel is agents and workflows.
  const shown = agents.filter((a) => (a.kind === "agent" || a.kind === "workflow") && a.parentAgentId === null && listed(a, now));
  if (shown.length === 0) return [];
  const rows: TaskRow[] = [
    { key: "main", kind: "main", threadId: sessionKey, glyph: viewingThreadId === sessionKey ? "⏺" : "◯", tone: viewingThreadId === sessionKey ? "viewing" : "idle", name: "main", detail: "", right: "" },
  ];
  for (const a of shown) {
    const viewing = a.childThreadId !== null && a.childThreadId === viewingThreadId;
    const ended = !agentRowActive(a);
    const tone: TaskGlyphTone = viewing ? "viewing" : !ended ? "idle" : a.status === "completed" ? "done" : "stopped";
    const started = Date.parse(a.startedAt ?? "");
    // A stopped agent's files stop at its last write, not at the stop: no time for it.
    const until = !ended ? now : a.status === "completed" ? Date.parse(a.completedAt ?? a.updatedAt ?? "") : NaN;
    const elapsed = Number.isFinite(started) && Number.isFinite(until) ? panelElapsed(until - started) : "";
    // A stop or resume on its way shows in place of the time (the 작업 tab's words).
    const settling = a.settling ? agentStatusLabel(a) : null;
    if (a.kind === "workflow") {
      const total = a.workflow?.agents.length ?? 0;
      const done = a.workflow?.agents.filter((x) => x.state === "completed").length ?? 0;
      const tokens = typeof a.workflow?.totalTokens === "number" ? `↓ ${compactTokens(a.workflow.totalTokens)} tokens` : "";
      const right = settling ?? [`${done}/${total}`, elapsed, tokens].filter(Boolean).join("  ");
      rows.push({ key: `workflow:${a.id}`, kind: "workflow", threadId: a.childThreadId, glyph: viewing ? "⏺" : "◯", tone, name: a.workflow?.name || a.title, detail: "", right, bar: { done, total }, agent: a });
    } else {
      const right = settling ?? elapsed;
      rows.push({ key: `agent:${a.id}`, kind: "agent", threadId: a.childThreadId, glyph: viewing ? "⏺" : "◯", tone, name: a.agentType || "agent", detail: a.title, right, agent: a });
    }
  }
  return rows;
}

/** The bar's cells: ▰ for the done share, ▱ for the rest. */
export function workflowBar(done: number, total: number): { filled: string; empty: string } {
  const n = total > 0 ? Math.round((done / total) * WORKFLOW_BAR) : 0;
  return { filled: "▰".repeat(n), empty: "▱".repeat(WORKFLOW_BAR - n) };
}

/** The window of agent rows (after "main") that keeps the selection in view. */
export function panelWindow(count: number, selected: number | null): { start: number; end: number } {
  if (count <= PANEL_ROWS) return { start: 0, end: count };
  const at = selected === null ? 0 : Math.max(0, selected - 1);
  const start = Math.max(0, Math.min(at - PANEL_ROWS + 1, count - PANEL_ROWS));
  return { start, end: start + PANEL_ROWS };
}

/**
 * The footer line while a row is selected (measured): what Enter and x do there. The CLI joins
 * the parts with middle dots; this app uses two spaces.
 */
export function selectionHint(row: TaskRow, viewingThreadId: string): string {
  if (row.kind === "main") return row.threadId === viewingThreadId ? "↑/↓ to select" : "↑/↓ to select  Enter to view";
  if (row.threadId !== null && row.threadId === viewingThreadId) return "↑/↓ to select";
  const parts: string[] = [];
  if (row.threadId) parts.push("Enter to view");
  if (row.agent?.stop?.enabled) parts.push("x to stop");
  if (row.agent?.resume?.enabled) parts.push("r to resume");
  return parts.length > 0 ? parts.join("  ") : "↑/↓ to select";
}
