// The web's Empty (ui/empty.tsx): centered, 24 apart, 24 padding; a header of an optional icon (20,
// muted, 12 above the title), the title in font-semibold text-xl and a muted description 4 under
// it, then the content. `scale` says which text sizes: the conversation canvas scales them by the
// conversation text size, the page outside it does not (ui/metrics.ts).
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "./Text.tsx";
import { usePalette } from "../../theme.ts";
import { chat, ui } from "./metrics.ts";

export function EmptyState(props: { scale: "ui" | "chat"; icon?: ReactNode; title: string; description?: string | null; children?: ReactNode }) {
  const p = usePalette();
  const t = props.scale === "chat" ? chat : ui;
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        {props.icon ? <View style={{ marginBottom: 12 }}>{props.icon}</View> : null}
        <Text style={[styles.title, { color: p.text, fontSize: t.xl.fontSize, lineHeight: t.xl.lineHeight }]} accessibilityRole="header">{props.title}</Text>
        {props.description ? <Text selectable style={[props.scale === "chat" ? chat.sm : ui.sm, styles.description, { color: p.muted }]}>{props.description}</Text> : null}
      </View>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minWidth: 0, alignItems: "center", justifyContent: "center", gap: 24, padding: 24 },
  header: { maxWidth: 384, alignItems: "center" },
  title: { fontWeight: "600", textAlign: "center" },
  description: { marginTop: 4, textAlign: "center" },
});
