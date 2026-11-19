// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/ProposedPlanCard.tsx and the collapsed preview builder of
// apps/web/src/proposedPlan.ts.
// Local changes: the action menu holds copy only (download and save to workspace are gone in this
// read-only viewer), a failed copy only logs, and find integration is gone. UI text is Korean.
import { EllipsisIcon } from "lucide-react";
import { memo, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "../../t3-shared/proposedPlanText.ts";
import ChatMarkdown from "../ChatMarkdown";
import { buildCollapsedProposedPlanPreviewMarkdown } from "./ProposedPlanCard.logic.ts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  cwd,
}: {
  planMarkdown: string;
  cwd: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ target: "plan" });
  const title = proposedPlanTitle(planMarkdown) ?? "Proposed plan";
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;
  const isCollapsed = canCollapse && !expanded;

  return (
    <div className="rounded-2xl border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Plan</Badge>
          <h3 className="truncate text-sm font-medium text-foreground">{title}</h3>
        </div>
        <Menu>
          <MenuTrigger render={<Button aria-label="Plan actions" size="icon-xs" variant="outline" />}>
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => copyToClipboard(`${planMarkdown.trimEnd()}\n`)}>
              {isCopied ? "Copied" : "Copy to clipboard"}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="mt-4">
        <div className={cn("relative", isCollapsed && "max-h-104 overflow-hidden")}>
          <ChatMarkdown
            text={isCollapsed ? (collapsedPreview ?? "") : displayedPlanMarkdown}
            cwd={cwd}
            isStreaming={false}
            headingLevelOffset={3}
          />
          {isCollapsed ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Collapse plan" : "Expand plan"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
});
