// The Appearance rows that take a number (DESIGN.md 6g, "입력 컨트롤"): a whole number typed or
// stepped, and a size that can follow the conversation's. The ranges are the rows' own
// (lib/settingControl.logic.ts rangeOfSteps over the wheel's steps).
import { useEffect, useState } from "react";

import { clampInt, type IntRange } from "~/lib/settingControl.logic";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Switch } from "../ui/switch";

/**
 * A whole number typed or stepped: Up and Down move by one, Enter or leaving the field applies it,
 * and a number outside the range, a decimal or an empty field becomes the nearest allowed number
 * (or the value it had) and shows that. The unit sits after the field.
 */
export function NumberSetting(props: {
  label: string;
  value: number;
  range: IntRange;
  unit: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(props.value);
  // The value moves from outside too (a reset, the wheel, another tab).
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = (typed: number | null) => {
    if (typed === null || !Number.isFinite(typed)) {
      setDraft(props.value);
      return;
    }
    const next = clampInt(typed, props.range);
    setDraft(next);
    if (next !== props.value) props.onChange(next);
  };
  return (
    <div className="flex items-center gap-1.5">
      <NumberField
        size="sm"
        className="w-28 shrink-0"
        value={draft}
        min={props.range.min}
        max={props.range.max}
        step={1}
        disabled={props.disabled}
        format={{ maximumFractionDigits: 0, useGrouping: false }}
        onValueChange={(next) => setDraft(next)}
        onValueCommitted={commit}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label={`Decrease ${props.label}`} />
          <NumberFieldInput
            aria-label={props.label}
            inputMode="numeric"
            onKeyDown={(event) => {
              // Enter applies what is typed and leaves the field, which then shows the applied number
              // (the field applies on blur and on a step by itself).
              if (event.key === "Enter") {
                commit(draft);
                event.currentTarget.blur();
              }
            }}
          />
          <NumberFieldIncrement aria-label={`Increase ${props.label}`} />
        </NumberFieldGroup>
      </NumberField>
      <span aria-hidden className="w-6 text-xs text-muted-foreground">
        {props.unit}
      </span>
    </div>
  );
}

/**
 * A size that can follow the conversation's: a switch for "Same as conversation" and the number
 * beside it, dimmed while the switch is on. Turning the switch off starts from the conversation's size.
 */
export function FollowableNumberSetting(props: {
  label: string;
  /** Null follows the conversation. */
  value: number | null;
  conversationValue: number;
  range: IntRange;
  unit: string;
  onChange: (value: number | null) => void;
}) {
  const follows = props.value === null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <Switch
          size="sm"
          aria-label={`${props.label}: same as conversation`}
          checked={follows}
          onCheckedChange={(checked) => props.onChange(checked ? null : props.conversationValue)}
        />
        Same as conversation
      </label>
      <NumberSetting
        label={props.label}
        value={props.value ?? props.conversationValue}
        range={props.range}
        unit={props.unit}
        disabled={follows}
        onChange={(next) => props.onChange(next)}
      />
    </div>
  );
}
