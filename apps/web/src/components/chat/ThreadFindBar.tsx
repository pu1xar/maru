// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/ThreadFindBar.tsx
// Local changes: Korean text; ArrowUp and ArrowDown step too, Esc closes; the count comes from
// the server's matches over the whole thread (DESIGN.md 6u); the bar sits in the conversation
// canvas's top right (maru has no details card). InputGroup has no addon slot here, so the
// buttons follow the input.
import { useEffect, useRef, type KeyboardEvent } from "react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { formatFindCount } from "@maru/shared";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { InputGroup, InputGroupInput } from "../ui/input-group";

export interface ThreadFindBarProps {
  readonly query: string;
  readonly total: number;
  readonly index: number;
  /** searching: a search for the current query is on its way; error: it failed (`error` says why). */
  readonly status: "idle" | "searching" | "error";
  readonly error: string | null;
  /** The current occurrence is not in the thread any more (rewritten since the search). */
  readonly missing: boolean;
  /** Bumped by each find shortcut, so an open bar takes the keyboard again and selects its query. */
  readonly focusSeq: number;
  readonly onQueryChange: (query: string) => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly onClose: () => void;
}

export function ThreadFindBar(props: ThreadFindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [props.focusSeq]);

  const hasQuery = props.query.trim().length > 0;
  let label = "";
  if (hasQuery) label = props.status === "searching" ? "Searching" : props.status === "error" ? "Not found" : formatFindCount(props.index, props.total);
  const noResults = hasQuery && props.status === "idle" && props.total === 0;
  const stepDisabled = props.total === 0 || props.status !== "idle";

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // A Korean syllable still being composed: its Enter ends the composition, not a step.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    const previous = (event.key === "Enter" && event.shiftKey) || event.key === "ArrowUp";
    const next = (event.key === "Enter" && !event.shiftKey) || event.key === "ArrowDown";
    if (!previous && !next) return;
    event.preventDefault();
    event.stopPropagation();
    if (stepDisabled) return;
    if (previous) props.onPrevious();
    else props.onNext();
  };

  return (
    <div data-thread-find-bar="" className="absolute top-3 right-3 z-40 w-[min(22rem,calc(100%-1.5rem))]">
      <InputGroup
        variant="popover"
        size="lg"
        role="search"
        aria-label="Find in conversation"
        aria-busy={props.status === "searching"}
        className="w-full gap-0.5 pe-1"
      >
        <InputGroupInput
          ref={inputRef}
          type="search"
          size="sm"
          value={props.query}
          aria-label="Find in conversation"
          placeholder="Find in conversation"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => props.onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <span aria-live="polite" className="sr-only">
          {props.missing ? "This location is not in the conversation" : props.status === "error" ? (props.error ?? label) : label}
        </span>
        <span
          aria-hidden
          title={props.status === "error" ? (props.error ?? undefined) : props.missing ? "This location is not in the conversation" : undefined}
          data-thread-find-count=""
          className={cn(
            "min-w-10 shrink-0 text-center text-xs tabular-nums",
            noResults || props.status === "error" || props.missing ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
        <Button size="icon-xs" variant="ghost" aria-label="Previous result" title="Previous result (Shift+Enter)" disabled={stepDisabled} onClick={props.onPrevious}>
          <ChevronUpIcon />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Next result" title="Next result (Enter)" disabled={stepDisabled} onClick={props.onNext}>
          <ChevronDownIcon />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Close find" title="Close (Esc)" onClick={props.onClose}>
          <XIcon />
        </Button>
      </InputGroup>
    </div>
  );
}
