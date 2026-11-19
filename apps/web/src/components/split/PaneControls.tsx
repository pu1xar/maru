// The controls every pane header ends with (DESIGN.md 6k): whatever the pane puts first, then the
// close button. Splitting is done by dropping onto a pane (paneDnd.tsx), and by the keys.
import { XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { paneKeyLabels } from "~/lib/paneKeys";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { paneActions } from "./paneStore";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const KEYS = paneKeyLabels(IS_MAC);

export function PaneControls({ paneId, children }: { paneId: string; children?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {children}
      <IconAction label="Close pane" hint={`Close pane (${KEYS.close})`} onClick={() => paneActions.closeByUser(paneId)}>
        <XIcon />
      </IconAction>
    </div>
  );
}

export function IconAction(props: {
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={props.label}
            // aria-disabled keeps the tooltip's hover, so the reason shows.
            aria-disabled={props.disabled || undefined}
            className={props.disabled ? "opacity-50" : undefined}
            onClick={() => {
              if (!props.disabled) props.onClick();
            }}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.hint ?? props.label}</TooltipPopup>
    </Tooltip>
  );
}
