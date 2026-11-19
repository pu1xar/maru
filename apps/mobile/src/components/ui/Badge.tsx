// The web's Badge at size sm (ui/badge.tsx: h-5, min-w-5, rounded-[.25rem], px-[3px], text-xs with no
// leading) in the tinted variants the sidebar uses (8% light, 16% dark fill, the -foreground text).
import { StyleSheet, View } from "react-native";
import { Text } from "./Text.tsx";
import type { BadgeVariant } from "../../lib/sidebarColors.ts";
import { useSidebarColors } from "../sidebar/useSidebarColors.ts";
import { ui } from "./metrics.ts";

export function Badge(props: { variant: BadgeVariant; label: string }) {
  const sc = useSidebarColors();
  const tone = sc.badge[props.variant];
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg }]}>
      <Text style={[ui.xs, { color: tone.fg, fontWeight: "500", lineHeight: 12 }]}>{props.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { height: 20, minWidth: 20, borderRadius: 4, paddingHorizontal: 3, alignItems: "center", justifyContent: "center", flexShrink: 0 },
});
