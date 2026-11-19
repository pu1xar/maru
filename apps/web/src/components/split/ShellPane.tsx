// A shell pane of the split view (DESIGN.md 6k, 6s): one shell terminal in a pane, with a header of
// the terminal icon, the tab's name (the foreground command, numbered when several shells run the
// same one, as the terminal screen's tabs are) and the shell's folder, then the pane's close button.
// Closing the pane only lets go of the shell; it keeps running and stays a tab of the terminal screen.
// A shell that ends (exit, closed elsewhere) closes its pane.
import type { ShellInfo } from "@maru/shared";
import { SquareTerminalIcon } from "lucide-react";
import { lazy, memo, Suspense, type MouseEventHandler } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import type { PaneLeaf } from "~/lib/paneLayout";
import { shellLabels } from "~/lib/shellTabs";
import { cn } from "~/lib/utils";
import { Spinner } from "../ui/spinner";
import { PaneHeader } from "../PaneHeader";
import { PaneControls } from "./PaneControls";
import { paneActions } from "./paneStore";

const ShellView = lazy(() => import("../shell/ShellView"));

export interface ShellPaneProps {
  pane: PaneLeaf;
  /** The pane's shell as the server lists it; null before the first read of the list. */
  shell: ShellInfo | null;
  /** The tab name the terminal screen would give this shell (shellLabels over every shell). */
  label: string | null;
  focused: boolean;
  /** Mouse-down on the header starts dragging the pane (dnd-kit activator listeners, filtered). */
  onHeaderMouseDown: MouseEventHandler<HTMLDivElement> | undefined;
}

/** The label of each shell, by id: the same names the terminal screen's tabs show. */
export function labelsOf(shells: readonly ShellInfo[] | null): Map<string, string> {
  return shellLabels(shells ?? []);
}

/** The last folder name of a path, for the header (the full path is the title). */
export function folderName(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return trimmed === "/" ? "/" : (trimmed.split("/").pop() ?? trimmed);
}

export const ShellPane = memo(function ShellPane({ pane, shell, label, focused, onHeaderMouseDown }: ShellPaneProps) {
  const coarse = useMediaQuery("(pointer: coarse)");
  const column = cn(
    "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background",
    // The header is the pane's drag handle; its buttons keep their own cursor.
    "[&>header]:cursor-grab",
    // The tab strip above the panes carries the floating sidebar toggle's room, so no pane header keeps it.
    "[&>header]:pl-(--workspace-gutter-start)!",
  );
  return (
    <div data-page-surface="" data-pane-column="" data-shell-pane={pane.shellId ?? undefined} className={column} onMouseDown={onHeaderMouseDown}>
      <PaneHeader className="border-b border-border" title={shell?.path}>
        <SquareTerminalIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm">
          <span data-shell-pane-label="" className="font-mono text-xs font-medium text-foreground">
            {label ?? shell?.command ?? "Shell"}
          </span>
          {shell ? <span className="ml-2 text-xs text-muted-foreground">{folderName(shell.path)}</span> : null}
        </span>
        <PaneControls paneId={pane.id} />
      </PaneHeader>
      <div className="relative min-h-0 min-w-0 flex-1">
        {pane.shellId ? (
          <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner className="size-4" /></div>}>
            <ShellView
              // Only the id matters to the terminal; the pane may draw before the list has been read.
              shell={shell ?? placeholder(pane.shellId)}
              active
              focusSeq={1}
              takeKeys={focused}
              keyBar={coarse}
              onGone={(id) => paneActions.shellEnded(id)}
            />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
});

function placeholder(id: string): ShellInfo {
  return { id, cwd: "", createdAt: 0, command: "", path: "", clients: 0 };
}
