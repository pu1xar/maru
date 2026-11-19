// Small pieces the dashboard's sections share (DESIGN.md 6j): the session's name line, a ticking
// elapsed time, the open button, the loading and empty rows. Sections are the settings screen's
// SettingsSection (T3 Code's settings group), so the two screens read alike.
import type { ProviderId } from "@maru/shared";
import { ArrowUpRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { formatElapsed } from "~/lib/dashboardModel";
import { tickTextContent } from "~/lib/tickTextContent";
import { cn } from "~/lib/utils";
import { ClaudeAI, OpenAI } from "../Icons";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The provider mark as the sidebar draws it: Claude in its orange, Codex in the text color. */
export function ProviderMark({ provider, className }: { provider: ProviderId; className?: string }) {
  return provider === "claude" ? (
    <ClaudeAI aria-label="Claude" className={cn("size-3.5 shrink-0", className)} />
  ) : (
    <OpenAI aria-label="Codex" className={cn("size-3.5 shrink-0 text-foreground", className)} />
  );
}

/** The time since `since`, rewritten every second while `live`. */
export function Elapsed({ since, live = true, className }: { since: number; live?: boolean; className?: string }) {
  return <span ref={tickTextContent((now) => formatElapsed(now - since), live)} className={cn("tabular-nums", className)} />;
}

/** Opens the session in the conversation view. */
export function OpenSessionButton({ onOpen, label = "Open conversation" }: { onOpen: () => void; label?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={label}
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          />
        }
      >
        <ArrowUpRightIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** A row in a section group: loading, or nothing to show. */
export function QuietRow({ loading, children }: { loading?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground sm:px-4" role={loading ? "status" : undefined}>
      {loading ? <Spinner className="size-3.5" aria-hidden /> : null}
      {children}
    </div>
  );
}

/** A section's count beside its title. */
export function CountBadge({ n }: { n: number }) {
  return <span className="min-w-5 rounded-full bg-foreground/8 px-1.5 text-center text-xs font-medium text-muted-foreground tabular-nums">{n}</span>;
}
