// A notice at the foot of the session sidebar while the Claude session host (DESIGN.md 2b) is not
// up: down means Claude sessions cannot be started, sent to, answered or closed; draining means
// it waits for running work before a restart and starts no new Claude process. Codex is not
// affected. Hidden while the host is up or the page has no server connection (the header dot
// shows that). Drawn as T3's warning pill (sidebar/SidebarProviderUpdatePill.tsx): one line, the
// rest in its tooltip, which focus opens as well as hover.
import { useSessionHost } from "~/lib/sessionHost";
import { useConnection } from "~/useSessions";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function SessionHostNotice() {
  const host = useSessionHost();
  const connection = useConnection();
  if (!host || host.state === "up" || connection !== "open") return null;
  const down = host.state === "down";
  const title = down ? "Claude session host is down" : "Claude session host restart pending";
  const detail = down
    ? "Cannot start or send Claude sessions, waiting to reconnect"
    : "Restarts when running Claude work finishes, no new Claude runs until then";
  return (
    <div role="status" aria-live="polite" className="min-w-0">
      <Tooltip>
        <TooltipTrigger
          render={
            // An image with its words as the label, like the usage lines below it, so focus can
            // open the tooltip and the status region reads the detail too.
            <div
              role="img"
              tabIndex={0}
              aria-label={`${title}, ${detail}`}
              className="flex min-h-7 w-full min-w-0 items-center gap-2 rounded-lg bg-warning/12 px-2 py-1.5 text-2xs leading-4 font-medium text-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
          <span className="min-w-0 truncate">{title}</span>
        </TooltipTrigger>
        <TooltipPopup side="right" align="end" className="max-w-80">
          <div className="flex flex-col gap-1 py-0.5 text-xs">
            <div>{detail}</div>
            {down ? (
              <div className="break-all text-muted-foreground">{host.error ?? "Unknown connection error"}</div>
            ) : host.waitingFor.length ? (
              <>
                <div className="font-medium">Waiting on</div>
                {host.waitingFor.map((w) => (
                  <div key={w} className="break-all">{w}</div>
                ))}
              </>
            ) : (
              <div className="text-muted-foreground">Nothing waiting</div>
            )}
          </div>
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
