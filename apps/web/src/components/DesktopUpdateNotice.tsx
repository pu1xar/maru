// A pill at the foot of the session sidebar when the desktop app (DESIGN.md 2e) has downloaded a
// newer build of itself: pressing it asks to restart into it (the app's dialog). The build waits
// until then. Drawn like VersionNotice; nothing in a browser.
import { desktopBridge, useDesktopUpdate } from "~/lib/desktopBridge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function DesktopUpdateNotice() {
  const bridge = desktopBridge();
  const state = useDesktopUpdate();
  if (!bridge || state?.status !== "downloaded") return null;
  const title = `maru app ${state.version} downloaded, restart`;
  const detail = `This app is ${bridge.version}. Click to be asked whether to restart`;
  return (
    <div role="status" aria-live="polite" className="min-w-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`${title}, ${detail}`}
              onClick={() => void bridge.installUpdate()}
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
