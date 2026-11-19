// The picker maru opens for /model, /effort, /permissions, /mcp, /output-style and /fast
// (DESIGN.md 6m), in the place of the `/` menu above the composer and with its looks
// (ComposerCommandMenu.tsx, from T3 Code). The rows follow Claude Code 2.1.325's own screens: a
// title with the current value, the list with the current row checked, and for /model an effort
// strip under it (the levels as buttons, the current one raised) that ← and → step and a click or
// tap picks at once (a phone has no arrow keys).
// The state and keys are lib/sessionPicker.ts.
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import type { SessionPicker as Picker } from "~/lib/sessionPicker";
import { effortDetail, effortSegments } from "~/lib/sessionPicker.logic";
import { cn } from "~/lib/utils";
import type { ModelOption, ProviderId } from "@maru/shared";
import { Badge } from "../ui/badge";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function pickerOptionId(listId: string, index: number): string {
  return `${listId}-p${index}`;
}

export function SessionPicker(props: { picker: Picker; provider: ProviderId; listId: string }) {
  const { picker, provider, listId } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const rows = picker.list?.rows ?? [];

  // Keeps the highlighted row in view.
  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(pickerOptionId(listId, picker.active))}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [picker.active, listId, rows]);

  const option = picker.kind === "model" ? picker.list?.rows[picker.active]?.option : undefined;
  // Codex's model rows are stacked as ChatGPT's (the display name, its description under it).
  const stacked = provider === "codex" && picker.kind === "model";
  const title = picker.list?.title ?? picker.view?.title ?? "";

  return (
    <div
      className="flex min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]"
      data-session-picker={picker.kind ?? ""}
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-border px-4 py-2">
        <span className="shrink-0 font-medium text-xs">{title}</span>
        {picker.view?.current && picker.list?.title === picker.view.title ? (
          <span className="min-w-0 truncate text-secondary-label text-xs">{picker.view.current}</span>
        ) : null}
        {picker.view?.pending && picker.list?.title === picker.view.title ? (
          // Claude keeps it for the session's next start, Codex for this server's next turn/start.
          <Badge variant="secondary" className="ms-auto shrink-0">{provider === "codex" ? "Next turn" : "Next start"}</Badge>
        ) : null}
      </div>
      {picker.loading ? (
        <div className="flex items-center gap-2 px-4 py-3 text-secondary-label text-xs">
          <Spinner size="sm" aria-hidden />
          <span>Loading</span>
        </div>
      ) : picker.error ? (
        <p role="alert" className="px-4 py-3 text-error-foreground text-xs">{picker.error}</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-3 text-secondary-label text-xs">{picker.kind === "mcp" ? "No MCP servers" : "Nothing to choose"}</p>
      ) : (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={title}
          className="max-h-[min(20rem,50dvh)] min-h-0 scroll-py-2 overflow-y-auto p-2"
          // The pointer leaving puts the highlight back on the current model, so the effort strip
          // below acts on the model the session runs.
          onMouseLeave={() => picker.highlight(-1)}
        >
          {rows.map((row, index) => {
            const isActive = picker.active === index;
            const item = (
              <div
                id={pickerOptionId(listId, index)}
                role="option"
                aria-selected={isActive}
                aria-disabled={row.disabled ? true : undefined}
                data-active={isActive || undefined}
                data-current={row.current || undefined}
                className={cn(
                  "flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-base outline-none sm:min-h-7 sm:text-sm",
                  isActive && "bg-accent text-accent-foreground",
                  row.disabled && "cursor-default opacity-50",
                )}
                onMouseMove={() => {
                  if (!isActive) picker.highlight(index);
                }}
                // Keeps the focus in the composer's textarea.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => picker.pick(index)}
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-foreground">
                  {row.current ? <CheckIcon aria-label="Current" className="size-3.5" /> : null}
                </span>
                {stacked ? (
                  // ChatGPT's menu row: the name, the one-line description under it.
                  <span className="flex min-w-0 flex-1 flex-col" data-model-row-text="">
                    <span className="truncate font-medium text-sm">{row.label}</span>
                    {row.description ? <span className="truncate text-secondary-label text-xs">{row.description}</span> : null}
                  </span>
                ) : (
                  <>
                    <span className="min-w-0 max-w-[45%] shrink-0 truncate font-medium text-xs">{row.label}</span>
                    <span className="min-w-0 flex-1 truncate text-secondary-label text-xs">{row.description}</span>
                  </>
                )}
                {row.next ? <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /> : null}
              </div>
            );
            return row.disabled ? (
              <Tooltip key={row.id}>
                <TooltipTrigger render={item} />
                <TooltipPopup side="right">{row.disabled}</TooltipPopup>
              </Tooltip>
            ) : (
              <div key={row.id}>{item}</div>
            );
          })}
        </div>
      )}
      {picker.kind === "model" && option && !picker.loading ? (
        <EffortStrip picker={picker} provider={provider} option={option} />
      ) : null}
    </div>
  );
}

/**
 * The model picker's effort strip: "Effort" and the highlighted model's levels as a row of
 * buttons (Claude: auto and the named levels, the ones the model does not take dimmed with the
 * reason on hover; Codex: the model's own levels), the current one raised, and under the title
 * that level's meaning. A click or tap applies the model with that level; ← and → move the choice
 * and Enter applies it.
 */
function EffortStrip(props: { picker: Picker; provider: ProviderId; option: ModelOption }) {
  const { picker, provider, option } = props;
  const segments = effortSegments(provider, option, picker.effortStep);
  const detail = effortDetail(provider, option, picker.effortStep);
  return (
    <div className="flex flex-col gap-1.5 border-t border-border px-4 py-2" data-effort-strip="">
      <div className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className="shrink-0 font-medium">Effort</span>
        <span className="min-w-0 flex-1 truncate text-secondary-label" data-effort-detail="">{detail}</span>
      </div>
      {segments.length > 0 ? (
        <div role="radiogroup" aria-label="Effort" className="flex gap-0.5 rounded-lg bg-muted p-0.5" data-effort-segments="">
          {segments.map((seg) => {
            const button = (
              <button
                type="button"
                role="radio"
                aria-checked={seg.selected}
                aria-disabled={seg.disabled ? true : undefined}
                data-effort-level={seg.level}
                data-selected={seg.selected || undefined}
                // Keeps the focus (and the picker) in the composer's textarea, also for a tap.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!seg.disabled) picker.pickEffort(seg.level);
                }}
                className={cn(
                  "flex h-8 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-md px-1 text-xs outline-none sm:h-6",
                  seg.selected
                    ? "bg-background font-medium text-foreground shadow-xs/5 ring-1 ring-border"
                    : "text-secondary-label hover:text-foreground",
                  seg.disabled && "cursor-default opacity-40 hover:text-secondary-label",
                )}
              >
                <span className="truncate">{seg.level}</span>
              </button>
            );
            return seg.disabled ? (
              <Tooltip key={seg.level}>
                <TooltipTrigger render={button} />
                <TooltipPopup side="top">{seg.disabled}</TooltipPopup>
              </Tooltip>
            ) : (
              <span key={seg.level} className="flex min-w-0 flex-1">{button}</span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
