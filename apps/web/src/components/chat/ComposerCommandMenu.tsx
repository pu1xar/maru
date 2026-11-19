// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: apps/web/src/components/chat/ComposerCommandMenu.tsx (the drawer over the composer: rows
// of a name and a one-line description, a tooltip only for a description the row cuts off, the
// highlighted row scrolled into view, the loading and empty lines) with the item and list looks of
// components/ui/command.tsx and autocomplete.tsx. Local change: plain listbox elements instead of
// T3's base-ui Autocomplete (the textarea keeps the focus and moves the highlight, as T3's editor
// does), one item kind (SessionCommand) with its argument hint after the name and a "skill" badge
// for a Codex `$skill`, and Korean status lines.
import type { SessionCommand } from "@maru/shared";
import { memo, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function commandOptionId(listId: string, index: number): string {
  return `${listId}-${index}`;
}

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  listId: string;
  items: readonly SessionCommand[];
  isLoading: boolean;
  error: string | null;
  activeIndex: number;
  onHighlight: (index: number) => void;
  onSelect: (item: SessionCommand) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scrolls the highlighted row's DOM node into view.
  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(commandOptionId(props.listId, props.activeIndex))}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeIndex, props.listId, props.items]);

  const status = props.isLoading
    ? "Loading commands"
    : props.error
      ? `Could not load commands: ${props.error}`
      : "No matching commands";

  return (
    <div
      className="flex min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]"
      data-composer-command-drawer="true"
    >
      {props.items.length > 0 ? (
        <div
          ref={listRef}
          id={props.listId}
          role="listbox"
          aria-label="Commands"
          className="max-h-[min(18rem,45dvh)] min-h-0 scroll-py-2 overflow-y-auto p-2"
        >
          {props.items.map((item, index) => (
            <ComposerCommandMenuItem
              key={`${item.sigil}${item.name}`}
              optionId={commandOptionId(props.listId, index)}
              index={index}
              item={item}
              isActive={props.activeIndex === index}
              onHighlight={props.onHighlight}
              onSelect={props.onSelect}
            />
          ))}
        </div>
      ) : (
        <div className="px-5 pt-3.5 pb-3.5">
          <p className="text-secondary-label text-xs">{status}</p>
        </div>
      )}
      {props.items.length > 0 && props.error ? (
        <p className="border-t border-border px-4 py-1.5 text-secondary-label text-xs">{status}</p>
      ) : null}
    </div>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  optionId: string;
  index: number;
  item: SessionCommand;
  isActive: boolean;
  onHighlight: (index: number) => void;
  onSelect: (item: SessionCommand) => void;
}) {
  const { item } = props;
  const descriptionRef = useRef<HTMLSpanElement>(null);
  const [descriptionTruncated, setDescriptionTruncated] = useState(false);
  // Measures the rendered description so only cut-off text gets a tooltip.
  useLayoutEffect(() => {
    const description = descriptionRef.current;
    setDescriptionTruncated(props.isActive && !!description && description.scrollWidth > description.clientWidth);
  }, [props.isActive]);
  // A CLI screen maru does not have stays in the list, dimmed, and says why while highlighted.
  const unsupported = item.handling?.kind === "unsupported" ? item.handling.reason : null;

  return (
    <div
      id={props.optionId}
      role="option"
      aria-selected={props.isActive}
      aria-disabled={unsupported ? true : undefined}
      data-active={props.isActive || undefined}
      data-unsupported={unsupported ? "" : undefined}
      className={cn(
        "flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-base outline-none sm:min-h-7 sm:text-sm",
        props.isActive && "bg-accent text-accent-foreground",
        unsupported && "opacity-50",
      )}
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(props.index);
      }}
      // Keeps the focus in the textarea.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => props.onSelect(item)}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 max-w-[45%] shrink-0 truncate font-sans text-xs font-medium">
          {item.sigil}
          {item.name}
          {item.argumentHint ? <span className="font-normal text-secondary-label"> {item.argumentHint}</span> : null}
        </span>
        <Tooltip open={unsupported ? props.isActive : descriptionTruncated}>
          <TooltipTrigger
            tabIndex={-1}
            render={<span ref={descriptionRef} className="min-w-0 flex-1 truncate text-left text-secondary-label text-xs" />}
          >
            {item.description}
          </TooltipTrigger>
          <TooltipPopup className="max-w-[min(32rem,80vw)]">{unsupported ?? item.description}</TooltipPopup>
        </Tooltip>
        {item.sigil === "$" ? (
          <Badge className="ms-auto" variant="secondary">
            skill
          </Badge>
        ) : null}
      </span>
    </div>
  );
});
