// The Appearance rows' controls that are not a select (the web's settings/choiceControls.tsx and
// numberControls.tsx at phone size): colors as circles in a radio group, a whole number typed on
// the number keypad or stepped with minus and plus, and a size that can follow the conversation's.
// Every touch target is 44dp.
import { useEffect, useState } from "react";
import { StyleSheet, Switch, View } from "react-native";
import { MinusIcon, PlusIcon } from "lucide-react-native";
import type { IntRange } from "../../../../web/src/lib/settingControl.logic.ts";
import { appliedNumber, steppedNumber, type Swatch } from "../../lib/settingsDisplay.logic.ts";
import { scaleAlpha } from "../../lib/chromeColors.ts";
import { usePalette } from "../../theme.ts";
import { Press } from "../Press.tsx";
import { TextField } from "./Fields.tsx";
import { Text } from "./Text.tsx";
import { ui } from "./metrics.ts";
import { useChrome } from "./useChrome.ts";

/**
 * Colors as circles. Each is painted with the color it stands for in this theme, the chosen one has
 * a ring in the accent, and the name is the accessible name. `custom` adds a last circle with a plus
 * (a color typed as hex; the platform has no gradient to paint a rainbow with).
 */
export function SwatchField(props: {
  label: string;
  value: string;
  swatches: readonly Swatch[];
  custom?: { value: string; label: string; color: string | null };
  onChange: (value: string) => void;
}) {
  const p = usePalette();
  const all = [...props.swatches, ...(props.custom ? [{ ...props.custom, plus: true }] : [])];
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={props.label} style={styles.swatches}>
      {all.map((s) => {
        const on = s.value === props.value;
        const plus = "plus" in s;
        return (
          <Press
            key={s.value}
            onPress={() => props.onChange(s.value)}
            accessibilityRole="radio"
            accessibilityLabel={s.label}
            accessibilityState={{ checked: on }}
            android_ripple={{ color: p.border, borderless: true, radius: 22 }}
            style={[styles.swatchRing, { borderColor: on ? p.accent : "transparent" }]}
          >
            <View
              style={[
                styles.swatchDot,
                { backgroundColor: s.color ?? "transparent", borderColor: scaleAlpha(p.text, 0.25) },
              ]}
            >
              {plus ? <PlusIcon size={18} color={s.color ? "#ffffff" : p.muted} /> : null}
            </View>
          </Press>
        );
      })}
    </View>
  );
}

/**
 * A whole number: type it on the number keypad (applied on done or when the field loses focus; a
 * number outside the range becomes the nearest allowed one and shows that, a field with no number
 * goes back to the value it had) or step it with minus and plus. The unit follows the field.
 */
export function NumberField(props: {
  label: string;
  value: number;
  range: IntRange;
  unit: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const p = usePalette();
  const c = useChrome();
  const [draft, setDraft] = useState<string | null>(null);
  // The value moves from outside too (a reset, another tab), so a draft does not outlive a change.
  useEffect(() => setDraft(null), [props.value]);
  const apply = (text: string) => {
    setDraft(null);
    const next = appliedNumber(text, props.range, props.value);
    if (next !== props.value) props.onChange(next);
  };
  const step = (direction: 1 | -1) => {
    setDraft(null);
    const next = steppedNumber(props.value, direction, props.range);
    if (next !== props.value) props.onChange(next);
  };
  const stepper = (direction: 1 | -1) => {
    const atEnd = direction === 1 ? props.value >= props.range.max : props.value <= props.range.min;
    return (
      <Press
        onPress={() => step(direction)}
        disabled={props.disabled || atEnd}
        accessibilityRole="button"
        accessibilityLabel={`${direction === 1 ? "Increase" : "Decrease"} ${props.label}`}
        android_ripple={{ color: p.border, borderless: true, radius: 22 }}
        style={styles.stepTouch}
      >
        <View style={[styles.stepBox, { backgroundColor: c.outlineFill, borderColor: c.input, opacity: props.disabled || atEnd ? 0.4 : 1 }]}>
          {direction === 1 ? <PlusIcon size={16} color={p.text} /> : <MinusIcon size={16} color={p.text} />}
        </View>
      </Press>
    );
  };
  return (
    <View style={[styles.number, props.disabled ? { opacity: 0.5 } : null]}>
      {stepper(-1)}
      <View style={{ width: 64 }}>
        <TextField
          accessibilityLabel={props.label}
          keyboardType="number-pad"
          returnKeyType="done"
          maxLength={4}
          editable={!props.disabled}
          selectTextOnFocus
          value={draft ?? String(props.value)}
          onChangeText={setDraft}
          onBlur={() => {
            if (draft !== null) apply(draft);
          }}
          onSubmitEditing={() => {
            if (draft !== null) apply(draft);
          }}
          numeric
        />
      </View>
      {stepper(1)}
      <Text style={[ui.xs, { color: p.muted, minWidth: 20 }]}>{props.unit}</Text>
    </View>
  );
}

/**
 * A size that can follow the conversation's: a switch for "Same as conversation" and the number
 * under it, dimmed while the switch is on. Turning the switch off starts from the conversation's size.
 */
export function FollowableNumberField(props: {
  label: string;
  /** Null follows the conversation. */
  value: number | null;
  conversationValue: number;
  range: IntRange;
  unit: string;
  onChange: (value: number | null) => void;
}) {
  const p = usePalette();
  const follows = props.value === null;
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.followRow}>
        <Switch
          accessibilityLabel={`${props.label}: same as conversation`}
          value={follows}
          onValueChange={(on) => props.onChange(on ? null : props.conversationValue)}
          trackColor={{ false: scaleAlpha(p.text, 0.2), true: p.accent }}
          thumbColor="#ffffff"
        />
        <Text style={[ui.sm, { color: p.muted, flexShrink: 1 }]}>Same as conversation</Text>
      </View>
      <NumberField
        label={props.label}
        value={props.value ?? props.conversationValue}
        range={props.range}
        unit={props.unit}
        disabled={follows}
        onChange={(next) => props.onChange(next)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  swatches: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 },
  // A 44 touch target: the ring (2) around a 30 circle with 3 between.
  swatchRing: { width: 44, height: 44, borderRadius: 22, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  swatchDot: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  number: { flexDirection: "row", alignItems: "center", gap: 2 },
  stepTouch: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  stepBox: { width: 32, height: 32, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  followRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 },
});
