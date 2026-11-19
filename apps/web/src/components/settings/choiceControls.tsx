// The controls of the Appearance rows that are not a select (DESIGN.md 6g, "입력 컨트롤"): a segmented
// line for a few labeled choices and a radio group of swatches for colors. Both pick one value and
// are keyboard operable: the segmented line is T3's ToggleGroup (Tab to it, Tab or arrows between
// items, Space or Enter picks); the swatches are Base UI's RadioGroup (one tab stop, arrows move
// and pick, role radiogroup and radio).
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { CSSProperties, ReactNode } from "react";

import { pickedValue } from "~/lib/settingControl.logic";
import { cn } from "~/lib/utils";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ChoiceOption {
  value: string;
  label: string;
}

/** A few labeled choices on one line, one pressed at a time (pressing the pressed one again keeps it). */
export function SegmentedChoice(props: {
  label: string;
  value: string;
  options: ReadonlyArray<ChoiceOption>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const values = props.options.map((o) => o.value);
  return (
    <ToggleGroup
      aria-label={props.label}
      value={[props.value]}
      disabled={props.disabled}
      onValueChange={(pressed: unknown[]) => {
        const next = pickedValue(pressed, values);
        if (next !== null && next !== props.value) props.onChange(next);
      }}
    >
      {props.options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value}>
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export interface SwatchOption {
  value: string;
  /** The name: the tooltip and the accessible name. */
  label: string;
  /** A CSS background for the round swatch. */
  background?: string;
  /** Painted over the circle (a plus on the custom swatch). */
  mark?: ReactNode;
}

/**
 * Colors as swatches in a radio group. A circle is painted with the color it stands for (a CSS
 * value, so a token shows this theme's color); the chosen one has a ring. The name is the tooltip
 * and the accessible name.
 */
export function SwatchChoice(props: {
  label: string;
  value: string;
  options: ReadonlyArray<SwatchOption>;
  disabled?: boolean;
  className?: string;
  onChange: (value: string) => void;
}) {
  const values = props.options.map((o) => o.value);
  return (
    <RadioGroup
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      onValueChange={(next) => {
        if (typeof next === "string" && values.includes(next)) props.onChange(next);
      }}
      className={cn("flex min-w-0 flex-wrap items-center gap-2.5", props.className)}
    >
      {props.options.map((o) => (
        <Tooltip key={o.value}>
          <TooltipTrigger
            render={
              <Radio.Root
                value={o.value}
                aria-label={o.label}
                data-swatch={o.value}
                className={cn(
                  "relative inline-flex shrink-0 cursor-pointer items-center justify-center outline-none transition-shadow",
                  "ring-offset-2 ring-offset-background data-checked:ring-2 data-checked:ring-primary focus-visible:ring-2 focus-visible:ring-ring",
                  "pointer-coarse:after:absolute pointer-coarse:after:size-11 data-disabled:cursor-not-allowed data-disabled:opacity-64",
                  "size-6 rounded-full border border-foreground/25",
                )}
                style={o.background ? ({ background: o.background } as CSSProperties) : undefined}
              />
            }
          >
            {o.mark}
          </TooltipTrigger>
          <TooltipPopup side="top">
            <span className="block">{o.label}</span>
          </TooltipPopup>
        </Tooltip>
      ))}
    </RadioGroup>
  );
}
