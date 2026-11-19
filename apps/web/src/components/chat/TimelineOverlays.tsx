// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/TimelineOverlays.tsx (ScrollToEndButton)
// Local changes: the workspace file drop overlay is gone (no composer), the label is Korean and
// the summary is set off with a comma instead of a middle dot.
import { ChevronDownIcon } from "lucide-react";

import { Button } from "../ui/button";

/**
 * Sits `bottom` pixels up from the timeline's bottom edge. The summary names what waits at the
 * end of the timeline, which is out of view while it shows.
 */
export function ScrollToEndButton(props: {
  readonly bottom: number;
  readonly summary: string | null;
  readonly onScrollToEnd: () => void;
}) {
  return (
    <div
      className="chat-scroll-to-bottom pointer-events-none absolute z-30 flex justify-center py-1.5"
      style={{ bottom: props.bottom }}
    >
      <Button
        data-scroll-to-end="true"
        onPointerDown={(event) => event.preventDefault()}
        onClick={props.onScrollToEnd}
        className="pointer-events-auto"
        size="xs"
        variant="glass"
      >
        <ChevronDownIcon className="size-3.5" />
        Jump to bottom
        {props.summary === null ? null : (
          <span className="text-muted-foreground">, {props.summary}</span>
        )}
      </Button>
    </div>
  );
}
