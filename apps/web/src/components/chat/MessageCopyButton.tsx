// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/MessageCopyButton.tsx
// Local changes: a failed copy logs to the console instead of T3's anchored error toast, and
// extra clipboard flavors are gone. Labels are Korean.
import { CheckIcon, CopyIcon, type LucideIcon } from "lucide-react";
import { memo } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  label = "Copy message",
  icon: Icon = CopyIcon,
  size = "xs",
  variant = "outline",
  className,
}: {
  text: string;
  label?: string;
  icon?: LucideIcon;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
}) {
  // The hook logs a failed copy itself.
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={isCopied ? "Copied" : label}
            disabled={isCopied}
            onClick={() => copyToClipboard(text)}
            type="button"
            size={size}
            variant={variant === "ghost" ? "ghost-muted" : variant}
            className={className}
          />
        }
      >
        {isCopied ? <CheckIcon className="size-3 text-primary" /> : <Icon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{isCopied ? "Copied" : label}</p>
      </TooltipPopup>
    </Tooltip>
  );
});
