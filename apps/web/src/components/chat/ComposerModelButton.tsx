// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: components/chat/ProviderModelPicker.tsx and ComposerControl.tsx (the composer footer's
// model trigger: the model name and the effort word after it, in the "xs" control size). Local
// change: the trigger opens maru's own model picker above the input (SessionPicker.tsx, the same
// list, effort line and `thread.configure` as `/model`, DESIGN.md 6m) instead of T3's popover.
import { optionFor, type ProviderId, type ThreadProjectionState } from "@maru/shared";
import { ChevronUpIcon } from "lucide-react";

import { composerModelLabel } from "~/lib/modelLabel";
import { useCodexModelOptions } from "~/lib/modelOptionsCache";
import { currentEffort, currentModel } from "~/lib/sessionPicker.logic";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The button beside the send button: the session's model ("Opus 5.5") and, from the sm width up,
 * its effort word. It shrinks and truncates the model name before anything else in the row moves.
 */
export function ComposerModelButton(props: {
  state: ThreadProjectionState | null;
  provider: ProviderId;
  /** The session's key; a Codex session's account list gives the button its display name. */
  sessionKey: string;
  open: boolean;
  onToggle: () => void;
}) {
  const model = currentModel(props.state);
  const options = useCodexModelOptions(props.sessionKey, props.provider);
  // Codex: the daemon's display name ("GPT-6-Astra", as the picker rows); the id until the list is read.
  const label = (options && optionFor(options, model)?.label) || composerModelLabel(model) || "Model";
  const effort = currentEffort(props.state);
  const chosen = props.state?.chosen;
  const pendingChange = chosen?.pending === true && chosen.model !== undefined;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-composer-model-button=""
            aria-label={`Model ${label}${effort ? `, effort ${effort}` : ""}`}
            aria-haspopup="listbox"
            aria-expanded={props.open}
            // Keeps the focus (and the picker's keys) in the textarea.
            onMouseDown={(event) => event.preventDefault()}
            onClick={props.onToggle}
            className={cn(
              "relative inline-flex h-7 max-w-44 min-w-0 shrink cursor-pointer items-center gap-1 rounded-(--control-radius) border border-transparent px-1.75 text-sm font-normal whitespace-nowrap text-foreground/70 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:h-6 sm:text-xs dark:text-muted-foreground dark:hover:text-foreground",
              "pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11",
              props.open && "bg-accent text-accent-foreground",
            )}
          />
        }
      >
        <span className="min-w-0 truncate">{label}</span>
        {effort ? <span className="hidden shrink-0 text-muted-foreground sm:inline">{effort}</span> : null}
        <ChevronUpIcon aria-hidden className="-me-1 size-4 shrink-0 sm:size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {pendingChange ? `Choose model (applies ${props.provider === "codex" ? "from the next turn" : "from the next start"})` : "Choose model"}
      </TooltipPopup>
    </Tooltip>
  );
}
