// Drag and drop of the split view (DESIGN.md 6k). Three things are dragged into panes: a session
// row from the sidebar, the sidebar's terminal row, and a pane by its header (shapes: lib/paneDrag.ts).
// All must be one dnd-kit DndContext, so the context is not made here: the split view and the sidebar only register draggables and droppables and
// listen with useDndMonitor, and the page (App.tsx) wraps the sidebar and the main view in
// WorkspaceDndContext. Each part tells its own drags and drop targets by their data's shape.
import { DndContext, MouseSensor, pointerWithin, useSensor, useSensors } from "@dnd-kit/core";
import type { ReactNode } from "react";

/** T3's SIDEBAR_DRAG_DISTANCE: a press moves this many px before it becomes a drag (sidebar rows and pane headers alike). */
export const DRAG_DISTANCE = 6;

export { dragSourceOf, paneTargetOf, sourcePaneId } from "~/lib/paneDrag";
export type { DragSource, NewShellDragData, PaneDragData, PaneDropData, ShellDragData } from "~/lib/paneDrag";

/**
 * The page's one drag context: the sidebar's sensor (mouse, 6px) and collision detection (the
 * droppable under the pointer). Handlers live with the parts that own the drops (useDndMonitor).
 */
export function WorkspaceDndContext({ children }: { children: ReactNode }) {
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: DRAG_DISTANCE } }));
  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin}>
      {children}
    </DndContext>
  );
}
