// The conversation's find bar (DESIGN.md 6u), the web's ThreadFindBar: a popover-colored group of
// 36 with a 16 radius floating at the canvas's top right (12 from the top and the sides, up to 22rem
// wide), holding the query, the count ("3/12", destructive when nothing is found), previous, next
// and close as 28 ghost buttons. Its text is the conversation's text-base, as the web's bar sits in
// the conversation canvas. What the web leaves to a screen reader and a tooltip (why a find failed,
// that the place is gone) is the count's accessibility label.
import { useEffect, useRef, type ComponentRef } from "react";
import { StyleSheet, View } from "react-native";
import { Text, TextInput } from "./ui/Text.tsx";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react-native";
import type { FindBarState } from "../lib/useThreadFind.ts";
import { findHasNoResult, findLabel, findStepDisabled } from "../lib/threadFind.ts";
import { usePalette } from "../theme.ts";
import { Press } from "./Press.tsx";
import { chat } from "./ui/metrics.ts";
import { useChrome } from "./ui/useChrome.ts";

export function FindBar({ bar }: { bar: FindBarState }) {
  const p = usePalette();
  const c = useChrome();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  useEffect(() => {
    input.current?.focus();
  }, [bar.focusSeq]);
  const label = findLabel(bar.query, bar.status, bar.index, bar.total);
  const none = findHasNoResult(bar.query, bar.status, bar.total);
  const disabled = findStepDisabled(bar.status, bar.total);
  const failed = bar.status === "error" || bar.missing;
  const why = bar.missing ? "This spot is not in the conversation" : bar.status === "error" ? (bar.error ?? label) : label;
  const ripple = { color: c.accent, borderless: true, radius: 18 } as const;
  return (
    <View pointerEvents="box-none" style={styles.place}>
      <View
        style={[styles.bar, { backgroundColor: p.surface, borderColor: c.popupBorder }]}
        accessibilityRole="search"
        accessibilityLabel="Find in conversation"
        accessibilityState={{ busy: bar.status === "searching" }}
      >
        <TextInput
          ref={input}
          value={bar.query}
          onChangeText={bar.onQueryChange}
          onSubmitEditing={() => {
            if (!disabled) bar.onNext();
          }}
          blurOnSubmit={false}
          returnKeyType="search"
          placeholder="Find in conversation"
          placeholderTextColor={p.muted}
          accessibilityLabel="Find in conversation"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          style={[styles.input, chat.base, { color: p.text }]}
        />
        <Text
          accessibilityLiveRegion="polite"
          accessibilityLabel={why}
          style={[chat.xs, styles.count, { color: failed || none ? c.errorForeground : p.muted, fontVariant: ["tabular-nums"] }]}
        >
          {label}
        </Text>
        <Press onPress={bar.onPrevious} disabled={disabled} hitSlop={8} accessibilityLabel="Previous result" style={[styles.button, disabled ? styles.off : null]} android_ripple={ripple}>
          <ChevronUpIcon size={16} color={p.muted} />
        </Press>
        <Press onPress={bar.onNext} disabled={disabled} hitSlop={8} accessibilityLabel="Next result" style={[styles.button, disabled ? styles.off : null]} android_ripple={ripple}>
          <ChevronDownIcon size={16} color={p.muted} />
        </Press>
        <Press onPress={bar.onClose} hitSlop={8} accessibilityLabel="Close find" style={styles.button} android_ripple={ripple}>
          <XIcon size={16} color={p.muted} />
        </Press>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // absolute top-3 right-3, w-[min(22rem,calc(100%-1.5rem))].
  place: { position: "absolute", top: 12, left: 12, right: 12, zIndex: 40, alignItems: "flex-end" },
  // InputGroup popover, size lg (h-9), pe-1, gap-0.5, rounded-2xl.
  bar: { width: "100%", maxWidth: 352, minHeight: 36, flexDirection: "row", alignItems: "center", gap: 2, paddingEnd: 4, borderWidth: 1, borderRadius: 16 },
  // InputGroupInput size sm: h-7.5, px-[calc(2.5*4-1)].
  input: { flex: 1, minWidth: 0, height: 30, paddingHorizontal: 9, paddingVertical: 0 },
  count: { minWidth: 40, textAlign: "center" },
  // icon-xs (size-7) ghost.
  button: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  off: { opacity: 0.64 },
});
