// A lean window let go on this page puts its session back into the split view (DESIGN.md 6x). It
// draws nothing itself; the split view draws the drop preview (components/split/externalDrop.ts).
//
// Two ways reach the page, one for each shell because each can only do one of them:
//   desktop app  the window is an OS window moved by its header (a window drag region, so the page
//                never sees an HTML5 drag): the main process sends the cursor and the drop
//                (window.maruDesktop onSplitDrag / onSplitDrop).
//   browser      the popup's header is an HTML5 drag source (LeanApp), so the page gets dragover
//                and drop with the session key in the drag data; the popup learns the outcome over
//                the BroadcastChannel and closes itself.
import { useEffect } from "react";

import { desktopBridge } from "~/lib/desktopBridge";
import { SESSION_DRAG_TYPE } from "~/lib/leanWindow.logic";
import { announceSplitResult, onRemoteDrag, remoteDragKeyNow } from "~/lib/leanWindow";
import { placeExternalSession, setExternalDrag } from "./split/externalDrop";

function carriesSession(e: DragEvent): boolean {
  return !!e.dataTransfer && [...e.dataTransfer.types].includes(SESSION_DRAG_TYPE);
}

export function ExternalSessionDrop() {
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.onSplitDrag || !bridge.onSplitDrop) return;
    const offDrag = bridge.onSplitDrag((d) => setExternalDrag(d));
    const offDrop = bridge.onSplitDrop((d) => {
      void placeExternalSession(d.key, { x: d.x, y: d.y }).then(
        (outcome) => bridge.replySplitDrop?.(d.id, outcome),
        () => bridge.replySplitDrop?.(d.id, "none"),
      );
    });
    return () => {
      offDrag();
      offDrop();
      setExternalDrag(null);
    };
  }, []);

  useEffect(() => {
    if (desktopBridge()?.onSplitDrag) return;
    const onOver = (e: DragEvent) => {
      if (!carriesSession(e)) return;
      // The drag's data is hidden until the drop; the popup said which session it carries.
      const key = remoteDragKeyNow();
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      if (key) setExternalDrag({ key, x: e.clientX, y: e.clientY });
    };
    const onLeave = (e: DragEvent) => {
      // Leaving the page: the event's related target is null.
      if (carriesSession(e) && e.relatedTarget === null) setExternalDrag(null);
    };
    const onDrop = (e: DragEvent) => {
      if (!carriesSession(e)) return;
      e.preventDefault();
      const key = e.dataTransfer?.getData(SESSION_DRAG_TYPE) || remoteDragKeyNow();
      setExternalDrag(null);
      if (!key) return;
      void placeExternalSession(key, { x: e.clientX, y: e.clientY }).then((outcome) => {
        announceSplitResult(key, outcome);
        if (outcome === "placed" || outcome === "focused") window.focus();
      });
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    // The popup's drag ended (dropped elsewhere or cancelled): the preview goes.
    const off = onRemoteDrag((key) => {
      if (key === null) setExternalDrag(null);
    });
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      off();
    };
  }, []);

  return null;
}
