// The keys a touch keyboard lacks, in two rows under the shell (DESIGN.md 6s; the key list and
// what each sends are shell/keyBar.ts). It looks as the web's key bar does: the terminal's own
// surface darkened (black at 40%), a faint top line, keys of white at 10% (25% pressed, 30% latched)
// with white text. A press never takes the focus from the terminal, so the keyboard stays up.
// The arrows, Page up and Page down repeat while held.
import { useEffect, useRef, createElement } from "react";
import { StyleSheet, View } from "react-native";
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, type LucideIcon } from "lucide-react-native";
import { Text } from "../ui/Text.tsx";
import { Press } from "../Press.tsx";
import { BAR_ROWS, isModifier, type BarKey, type BarKeyId, type Latches } from "../../shell/keyBar.ts";

/** Held keys repeat after this pause, then at this interval (milliseconds). */
const REPEAT_AFTER_MS = 400;
const REPEAT_EVERY_MS = 70;
const REPEATING = new Set<BarKeyId>(["left", "down", "up", "right", "pgup", "pgdn"]);

const KEY_TEXT = "rgba(255,255,255,0.85)";

const ARROW_ICON: Record<NonNullable<BarKey["icon"]>, LucideIcon> = {
  "arrow-left": ArrowLeftIcon,
  "arrow-down": ArrowDownIcon,
  "arrow-up": ArrowUpIcon,
  "arrow-right": ArrowRightIcon,
};

export function ShellKeyBar(props: { latches: Latches; onKey: (id: BarKeyId) => void }) {
  const { onKey } = props;
  const timers = useRef<{ after: ReturnType<typeof setTimeout> | null; every: ReturnType<typeof setInterval> | null }>({ after: null, every: null });
  const stop = () => {
    if (timers.current.after) clearTimeout(timers.current.after);
    if (timers.current.every) clearInterval(timers.current.every);
    timers.current = { after: null, every: null };
  };
  useEffect(() => stop, []);
  const down = (id: BarKeyId) => {
    stop();
    onKey(id);
    if (!REPEATING.has(id)) return;
    timers.current.after = setTimeout(() => {
      timers.current.every = setInterval(() => onKey(id), REPEAT_EVERY_MS);
    }, REPEAT_AFTER_MS);
  };
  return (
    <View accessibilityRole="toolbar" accessibilityLabel="Terminal keys" style={styles.bar}>
      {BAR_ROWS.map((row, i) => (
        <View key={i} style={styles.row}>
          {row.map((k) => (
            <KeyButton key={k.id} k={k} latched={isModifier(k.id) ? props.latches[k.id] : false} onDown={down} onUp={stop} />
          ))}
        </View>
      ))}
    </View>
  );
}

function KeyButton(props: { k: BarKey; latched: boolean; onDown: (id: BarKeyId) => void; onUp: () => void }) {
  const { k } = props;
  const modifier = isModifier(k.id);
  // A touch sends on the finger's arrival (and repeats while held); the click a screen reader's
  // double tap makes arrives with no touch before it and sends once.
  const touched = useRef(false);
  return (
    <Press
      // The terminal keeps the focus (and the phone its keyboard).
      focusable={false}
      accessibilityRole={modifier ? "togglebutton" : "button"}
      accessibilityLabel={k.name}
      accessibilityState={modifier ? { checked: props.latched } : undefined}
      onPressIn={() => {
        touched.current = true;
        props.onDown(k.id);
      }}
      onPressOut={() => {
        props.onUp();
        setTimeout(() => {
          touched.current = false;
        }, 0);
      }}
      onPress={() => {
        if (touched.current) touched.current = false;
        else props.onDown(k.id);
      }}
      style={({ pressed }: { pressed: boolean }) => [
        styles.key,
        { flexGrow: k.weight ?? 1, backgroundColor: props.latched ? "rgba(255,255,255,0.30)" : pressed ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.10)" },
      ]}
    >
      {k.icon ? (
        createElement(ARROW_ICON[k.icon], { size: 16, color: KEY_TEXT })
      ) : (
        <Text numberOfLines={1} style={[styles.label, { color: KEY_TEXT }]}>
          {k.label}
        </Text>
      )}
    </Press>
  );
}

const styles = StyleSheet.create({
  // border-t border-white/10 bg-black/40 px-2 py-1, a gap of 4 between keys and rows.
  bar: { backgroundColor: "rgba(0,0,0,0.4)", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(255,255,255,0.1)", paddingHorizontal: 4, paddingVertical: 4, gap: 4 },
  row: { flexDirection: "row", gap: 4 },
  // 42 high; ten keys across a 360 dp phone are about 31 dp wide each.
  key: { flexBasis: 0, minWidth: 0, height: 42, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  // font-mono, one step under the web's text-xs so "PgUp" fits a 31 dp key.
  label: { fontFamily: "monospace", fontSize: 11, lineHeight: 16 },
});
