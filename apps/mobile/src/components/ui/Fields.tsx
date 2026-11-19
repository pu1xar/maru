// The web's form parts at phone width: Label (ui/label.tsx), Input and Textarea (ui/input.tsx,
// textarea.tsx: border-input, the field fill, radius 8, text-base, focus border in the primary),
// Select (ui/select.tsx: a trigger with a chevron, a popup of --popover under it) and the segmented
// ToggleGroup (ui/toggle-group.tsx). The web's 3px focus ring and inner top highlight are left out.
import { useRef, useState, type ComponentRef, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View, type TextInputProps } from "react-native";
import { Text, TextInput } from "./Text.tsx";
import { ChevronDownIcon } from "lucide-react-native";
import { scaleAlpha } from "../../lib/chromeColors.ts";
import { usePalette } from "../../theme.ts";
import { Press } from "../Press.tsx";
import { CONTROL_RADIUS, ui } from "./metrics.ts";
import { useChrome } from "./useChrome.ts";

/** Label: text-base/4.5 on a phone, font-medium, the foreground. */
export function FieldLabel(props: { children: string }) {
  const p = usePalette();
  return <Text style={{ fontSize: 16, lineHeight: 18, fontWeight: "500", color: p.text }}>{props.children}</Text>;
}

/** A field's label over its control, gap-1.5 (the dialog's field group). */
export function Field(props: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <FieldLabel>{props.label}</FieldLabel>
      {props.children}
    </View>
  );
}

/** Input at size sm (32 with its border, px 9) or Textarea with `rows`. */
export function TextField(props: Omit<TextInputProps, "style"> & { rows?: number; mono?: boolean; numeric?: boolean }) {
  const p = usePalette();
  const c = useChrome();
  const [focused, setFocused] = useState(false);
  const { rows, mono, numeric, editable, ...rest } = props;
  const multiline = rows !== undefined;
  return (
    <TextInput
      {...rest}
      multiline={multiline}
      editable={editable}
      onFocus={(e) => {
        setFocused(true);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        props.onBlur?.(e);
      }}
      placeholderTextColor={p.muted}
      style={[
        styles.input,
        ui.base,
        {
          color: p.text,
          backgroundColor: c.inputFill,
          borderColor: focused ? p.accent : c.input,
          opacity: editable === false ? 0.64 : 1,
        },
        multiline
          ? // field-sizing: content, min-h = rows lines + 2 * (6 - 1), max-h-64, plus the border.
            { minHeight: rows * 24 + 10 + 2, maxHeight: 256, paddingHorizontal: 11, paddingVertical: 5, textAlignVertical: "top" }
          : { minHeight: 32, paddingHorizontal: 9, paddingVertical: 0 },
        mono ? { fontFamily: "monospace" } : null,
        numeric ? { textAlign: "center", minHeight: 44 } : null,
      ]}
    />
  );
}

/** Select at size sm: a trigger showing the value, and a popup list of the options under it. */
export function SelectField(props: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  empty?: string;
  /** Only the trigger, for a settings row whose title is the label (the web's min-w-40 trigger). */
  bare?: boolean;
  onChange: (value: string) => void;
}) {
  const p = usePalette();
  const c = useChrome();
  const trigger = useRef<ComponentRef<typeof View>>(null);
  const [at, setAt] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const shown = props.options.find((o) => o.value === props.value)?.label ?? props.value;
  const open = () => {
    trigger.current?.measureInWindow((x, y, w, h) => setAt({ x, y, w, h }));
  };
  return (
    <View style={{ gap: 6, minWidth: 0 }}>
      {props.bare ? null : <FieldLabel>{props.label}</FieldLabel>}
      <View ref={trigger} collapsable={false}>
        <Press
          onPress={open}
          accessibilityRole="combobox"
          accessibilityLabel={props.label}
          accessibilityValue={{ text: shown }}
          hitSlop={6}
          style={[styles.trigger, props.bare ? { minWidth: 160 } : null, { backgroundColor: c.inputFill, borderColor: c.input }]}
        >
          <Text style={[ui.base, styles.triggerText, { color: p.text }]} numberOfLines={1}>{shown}</Text>
          <ChevronDownIcon size={14} color={p.muted} style={{ opacity: 0.7 }} />
        </Press>
      </View>
      <Modal visible={at !== null} transparent animationType="fade" onRequestClose={() => setAt(null)}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setAt(null)} accessibilityLabel="Close" />
        {at ? (
          <View
            style={[
              styles.popup,
              { top: at.y + at.h + 4, left: at.x, minWidth: at.w, backgroundColor: p.surface, borderColor: c.popupBorder },
            ]}
          >
            <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ padding: 4 }}>
              {props.options.length === 0 && props.empty ? <Text style={[ui.xs, { color: p.muted, padding: 8 }]}>{props.empty}</Text> : null}
              {props.options.map((o) => {
                const on = o.value === props.value;
                return (
                  <Press
                    key={o.value || "-"}
                    onPress={() => {
                      setAt(null);
                      props.onChange(o.value);
                    }}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected: on }}
                    style={[styles.item, on ? { backgroundColor: scaleAlpha(p.text, 0.08) } : null]}
                  >
                    <Text style={[ui.base, { color: p.text }]} numberOfLines={1}>{o.label}</Text>
                  </Press>
                );
              })}
            </ScrollView>
          </View>
        ) : null}
      </Modal>
    </View>
  );
}

/** The segmented ToggleGroup: a --input at 40% track with 2 around, items of 24 with the pressed one on the canvas color. */
export function Segmented(props: {
  label: string;
  items: readonly { value: string; label: string; icon?: ReactNode }[];
  value: string;
  onPick: (value: string) => void;
  /** One row that scrolls sideways (chips with 44 tall tap targets) instead of the fixed track. */
  scroll?: boolean;
}) {
  const p = usePalette();
  const c = useChrome();
  if (props.scroll) {
    // A row that scrolls sideways when its items do not fit: each tap target is 44 tall, the pill inside is 30.
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="radiogroup" accessibilityLabel={props.label} contentContainerStyle={styles.chips}>
        {props.items.map((it) => {
          const on = it.value === props.value;
          return (
            <Press key={it.value} onPress={() => props.onPick(it.value)} accessibilityRole="radio" accessibilityState={{ checked: on }} style={styles.chipHit}>
              <View style={[styles.chip, on ? { backgroundColor: c.segmentTrack } : null]}>
                {it.icon}
                <Text style={[ui.sm, { color: on ? p.text : p.muted, fontWeight: "500" }]}>{it.label}</Text>
              </View>
            </Press>
          );
        })}
      </ScrollView>
    );
  }
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={props.label}
      style={[styles.segTrack, { backgroundColor: c.segmentTrack }]}
    >
      {props.items.map((it) => {
        const on = it.value === props.value;
        return (
          <Press
            key={it.value}
            onPress={() => props.onPick(it.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            hitSlop={{ top: 10, bottom: 10 }}
            style={[styles.segItem, on ? { backgroundColor: p.bg } : null]}
          >
            {it.icon}
            <Text style={[ui.xs, { color: on ? p.text : p.muted, fontWeight: "500" }]}>{it.label}</Text>
          </Press>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderRadius: CONTROL_RADIUS, width: "100%" },
  trigger: { minHeight: 32, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6, borderWidth: 1, borderRadius: CONTROL_RADIUS, paddingHorizontal: 9, overflow: "hidden" },
  triggerText: { flex: 1, minWidth: 0 },
  popup: { position: "absolute", borderWidth: 1, borderRadius: CONTROL_RADIUS, elevation: 8, maxWidth: "92%" },
  item: { minHeight: 32, justifyContent: "center", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 },
  chips: { flexDirection: "row", alignItems: "center", gap: 4 },
  chipHit: { height: 44, justifyContent: "center" },
  chip: { height: 30, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, borderRadius: 15 },
  segTrack: { flexDirection: "row", alignSelf: "flex-start", gap: 2, padding: 2, borderRadius: CONTROL_RADIUS },
  segItem: { height: 24, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, borderRadius: 6 },
});
