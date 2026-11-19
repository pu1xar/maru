// The prompt cache clock beside the composer's model button (DESIGN.md 6t): the minutes the
// Claude conversation's prompt cache has left, in the muted color throughout. The times
// come from `promptCacheView` (packages/shared/src/promptCache.ts); this draws them and repaints on a timer.
import { promptCacheView, type ThreadPromptCache } from "@maru/shared";
import { ClockIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { serverNow } from "~/lib/serverClock";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Repaint interval; the label moves by whole minutes and the expiry follows within this. */
const REPAINT_MS = 10_000;

function timeLabel(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? "" : t.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function ComposerCacheClock(props: { cache: ThreadPromptCache | null | undefined; running: boolean }) {
  const [, repaint] = useState(0);
  const active = props.cache != null && !props.running;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => repaint((n) => n + 1), REPAINT_MS);
    return () => clearInterval(id);
  }, [active]);
  const view = promptCacheView(props.cache, serverNow(), props.running, props.cache ? timeLabel(props.cache.at) : "");
  if (view === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-composer-cache-clock=""
            data-state={view.state}
            role="status"
            aria-label={`${view.label}. ${view.tooltip}`}
            className="inline-flex h-6 shrink-0 cursor-default items-center gap-1 rounded-(--control-radius) px-1.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
          />
        }
      >
        <ClockIcon aria-hidden className="size-3.5 shrink-0" />
        <span>{view.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{view.tooltip}</TooltipPopup>
    </Tooltip>
  );
}
