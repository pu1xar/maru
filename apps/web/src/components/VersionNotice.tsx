// A pill at the foot of the session sidebar when the server runs another maru version than this
// page was built for (lib/pageVersion.ts): after a deploy or a rollback the open page keeps its old
// code until it reloads. Pressing it reloads. Drawn like SessionHostNotice, in the info color.
import { PAGE_VERSION, reloadSuggested } from "~/lib/pageVersion";
import { useServerVersion } from "~/lib/serverVersion";
import { useConnection } from "~/useSessions";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function VersionNotice() {
  const hello = useServerVersion();
  const connection = useConnection();
  if (connection !== "open" || !reloadSuggested(PAGE_VERSION, hello)) return null;
  const server = hello?.version ?? null;
  const title = server ? `maru ${server} deployed, reload` : "Server version changed, reload";
  const detail = `This page is ${PAGE_VERSION}${server ? `, server is ${server}` : ""}`;
  return (
    <div role="status" aria-live="polite" className="min-w-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`${title}, ${detail}`}
              onClick={() => window.location.reload()}
              className="flex min-h-7 w-full min-w-0 items-center gap-2 rounded-lg bg-info/12 px-2 py-1.5 text-start text-2xs leading-4 font-medium text-info-foreground outline-none hover:bg-info/18 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
          <span className="min-w-0 truncate">{title}</span>
        </TooltipTrigger>
        <TooltipPopup side="right" align="end" className="max-w-80">
          <div className="py-0.5 text-xs">{detail}</div>
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
