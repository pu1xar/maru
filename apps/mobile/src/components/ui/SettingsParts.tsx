// The web's settings parts (components/settings/settingsLayout.tsx, after T3 Code): a section with
// its title (text-base, font-semibold, 12 in) and an action at the end, over a grouped card
// (rounded-xl, border-border/60, --card at 40%, its rows divided by border-border/50), and a row of
// a title (text-sm, font-medium) with a reset button after it, a description (text-xs, muted,
// relaxed lines), an optional status line, a control under them (at phone width the web stacks the
// control below the text, left-aligned) and children under the control (a preview).
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Undo2Icon } from "lucide-react-native";
import { usePalette } from "../../theme.ts";
import { Press } from "../Press.tsx";
import { Text } from "./Text.tsx";
import { ui } from "./metrics.ts";
import { useChrome } from "./useChrome.ts";

export function SettingsSection(props: { title: string; hideTitle?: boolean; headerAction?: ReactNode; children: ReactNode }) {
  const p = usePalette();
  const c = useChrome();
  const rows = Array.isArray(props.children) ? props.children.flat().filter(Boolean) : [props.children];
  return (
    <View style={{ gap: 10 }}>
      <View style={[styles.sectionHead, props.hideTitle ? { justifyContent: "flex-end" } : null]}>
        {props.hideTitle ? null : <Text accessibilityRole="header" style={[ui.base, { color: p.text, fontWeight: "600", flexShrink: 1 }]}>{props.title}</Text>}
        {props.headerAction ? <View style={styles.headerAction}>{props.headerAction}</View> : null}
      </View>
      <View style={[styles.group, { backgroundColor: c.groupFill, borderColor: c.groupBorder }]}>
        {rows.map((row, i) => (
          <View key={i} style={i > 0 ? { borderTopWidth: 1, borderTopColor: c.groupDivider } : null}>{row}</View>
        ))}
      </View>
    </View>
  );
}

export function SettingsRow(props: {
  title: ReactNode;
  description?: string | null;
  status?: string | null;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  const p = usePalette();
  return (
    <View style={[styles.row, props.children ? { paddingBottom: 4 } : null]}>
      <View style={{ gap: 4 }}>
        <View style={styles.titleLine}>
          {typeof props.title === "string" ? <Text style={[ui.sm, { color: p.text, fontWeight: "500", flexShrink: 1 }]}>{props.title}</Text> : props.title}
          <View style={styles.resetSlot}>{props.resetAction}</View>
        </View>
        {props.description ? <Text selectable style={[ui.xs, { color: p.muted, lineHeight: 18 }]}>{props.description}</Text> : null}
        {props.status ? <Text selectable style={[ui.xs, { color: p.muted, paddingTop: 2 }]}>{props.status}</Text> : null}
      </View>
      {props.control ? <View style={styles.control}>{props.control}</View> : null}
      {props.children}
    </View>
  );
}

/** The undo mark after a changed row's title (ui/button icon-micro with Undo2Icon): a 20 slot, a 44 touch area. */
export function SettingResetButton(props: { label: string; onPress: () => void }) {
  const p = usePalette();
  const c = useChrome();
  return (
    <Press
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={`Reset ${props.label} to default`}
      hitSlop={12}
      android_ripple={{ color: c.accent, borderless: true, radius: 12 }}
      style={styles.reset}
    >
      <Undo2Icon size={12} color={p.muted} />
    </Press>
  );
}

const styles = StyleSheet.create({
  // flex min-h-7 px-3 (sm:px-4), wrapping, 16 between the title and the action.
  sectionHead: { minHeight: 28, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: 16, rowGap: 8, paddingHorizontal: 12 },
  headerAction: { minHeight: 28, minWidth: 28, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 8 },
  // rounded-xl border border-border/60 bg-card/40.
  group: { borderWidth: 1, borderRadius: 12, overflow: "hidden" },
  // px-3 py-3, flex-col gap-3.
  row: { paddingHorizontal: 12, paddingVertical: 12, gap: 12 },
  titleLine: { minHeight: 20, flexDirection: "row", alignItems: "center", gap: 6 },
  resetSlot: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  reset: { width: 20, height: 20, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  control: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
});
