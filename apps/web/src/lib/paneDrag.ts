// What the split view's drags carry and how a drop on a pane reads (DESIGN.md 6k). Four things are
// dragged into panes: a session row of the sidebar, the sidebar's terminal row (a new shell), a shell
// row under it, and a pane by its header. Kept apart from the components (components/split/paneDnd.tsx) so the shapes
// and the on-screen check are testable without a page.
import type { SessionSummary } from "@maru/shared";

import { panesOf, type PaneLayout } from "./paneLayout.ts";

/** `active.data` of a pane dragged by its header. */
export interface PaneDragData {
  kind: "pane";
  paneId: string;
  sessionKey: string | null;
  shellId: string | null;
  title: string;
}

/** `active.data` of the sidebar's terminal row. A drop on a pane makes a new shell there. */
export interface NewShellDragData {
  kind: "shell-new";
}

/** `active.data` of a shell row in the sidebar's terminal group. A drop on a pane opens that shell there. */
export interface ShellDragData {
  kind: "shell";
  shellId: string;
  title: string;
}

/** `over.data` of a pane (paneId) or of the empty split view (paneId null). */
export interface PaneDropData {
  kind: "pane-target";
  paneId: string | null;
}

export type DragSource =
  | { kind: "pane"; paneId: string; sessionKey: string | null; shellId: string | null; title: string }
  | { kind: "session"; sessionKey: string; session: SessionSummary }
  | { kind: "shell-new" }
  | { kind: "shell"; shellId: string; title: string };

/**
 * What a drag carries, for the split view: a pane, a session row of the sidebar (its DragData is
 * `{ session, groupKey }`), the terminal row, or a shell row under it. Anything else is not the split view's.
 */
export function dragSourceOf(data: unknown): DragSource | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Partial<Omit<PaneDragData, "kind">> & { kind?: string; session?: Partial<SessionSummary> };
  if (d.kind === "pane" && typeof d.paneId === "string") {
    return {
      kind: "pane",
      paneId: d.paneId,
      sessionKey: d.sessionKey ?? null,
      shellId: typeof d.shellId === "string" ? d.shellId : null,
      title: d.title ?? "",
    };
  }
  if (d.kind === "shell-new") return { kind: "shell-new" };
  if (d.kind === "shell" && typeof d.shellId === "string") return { kind: "shell", shellId: d.shellId, title: d.title ?? "" };
  if (d.session && typeof d.session.key === "string") return { kind: "session", sessionKey: d.session.key, session: d.session as SessionSummary };
  return null;
}

export function paneTargetOf(data: unknown): PaneDropData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Partial<PaneDropData>;
  return d.kind === "pane-target" && (d.paneId === null || typeof d.paneId === "string") ? { kind: "pane-target", paneId: d.paneId } : null;
}

/**
 * The pane of `layout` the dragged thing already is: a pane's own, or the pane that shows the
 * dragged session or shell. A drop on it changes nothing. A new shell is on no pane yet.
 */
export function sourcePaneId(layout: PaneLayout, source: DragSource): string | null {
  if (source.kind === "pane") return source.paneId;
  if (source.kind === "shell-new") return null;
  if (source.kind === "shell") return panesOf(layout.root).find((p) => p.shellId === source.shellId)?.id ?? null;
  return panesOf(layout.root).find((p) => p.sessionKey === source.sessionKey)?.id ?? null;
}
