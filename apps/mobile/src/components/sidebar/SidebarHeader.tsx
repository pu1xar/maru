// The drawer's head (SessionSidebar.tsx SidebarChromeHeader): the maru mark (a press goes home), the
// server connection's dot, and on the right the counts of what asks for attention or is at work.
import { StyleSheet, View } from "react-native";
import { Text } from "../ui/Text.tsx";
import type { ConnectionState } from "../../lib/connection.ts";
import { ACTIVITY_LABEL } from "../../../../web/src/components/sessionActivity.logic.ts";
import type { HeaderBadge } from "../../lib/sidebarModel.ts";
import { usePalette } from "../../theme.ts";
import { type } from "../../typography.ts";
import { Press } from "../Press.tsx";
import { ActivityMark } from "./ActivityMark.tsx";
import { MaruMark } from "./MaruMark.tsx";
import { useSidebarColors } from "./useSidebarColors.ts";

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  open: "Connected to server",
  connecting: "Connecting to server",
  offline: "Disconnected from server, waiting to reconnect",
  revoked: "This device was disconnected",
};

/** The topbar's height (--workspace-topbar-height: 2.75rem). */
export const HEADER_HEIGHT = 44;

export function SidebarHeader(props: { connection: ConnectionState; badges: HeaderBadge[]; topInset: number; onHome: () => void }) {
  const p = usePalette();
  const sc = useSidebarColors();
  const dot = props.connection === "open" ? p.ok : props.connection === "connecting" ? p.warn : p.danger;
  const label = CONNECTION_LABEL[props.connection];
  return (
    <View style={[styles.head, { paddingTop: props.topInset, height: HEADER_HEIGHT + props.topInset }]}>
      {/* The mark is the link home (T3 SidebarBrand); it lines up with the folder icons below it. */}
      <Press onPress={props.onHome} hitSlop={10} accessibilityRole="link" accessibilityLabel="maru" style={styles.brand}>
        <MaruMark size={20} color={p.text} />
      </Press>
      <View accessible accessibilityRole="image" accessibilityLabel={label} style={styles.dotBox}>
        <View style={[styles.dot, { backgroundColor: dot }]} />
      </View>
      <View style={{ flex: 1 }} />
      <View style={styles.badges}>
        {props.badges.map((b) => (
          <View
            key={b.activity}
            accessible
            accessibilityLabel={`${ACTIVITY_LABEL[b.activity]}: ${b.count}`}
            style={[styles.badge, { backgroundColor: sc.badge[b.variant].bg }]}
          >
            <ActivityMark mark={b.mark} size={12} />
            <Text style={[type.tiny, styles.count, { color: sc.badge[b.variant].fg }]}>{b.count}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 18, paddingRight: 12 },
  brand: { height: 28, justifyContent: "center", borderRadius: 6 },
  dotBox: { width: 12, height: 12, alignItems: "center", justifyContent: "center" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  badges: { flexDirection: "row", alignItems: "center", gap: 4 },
  badge: { flexDirection: "row", alignItems: "center", gap: 4, height: 18, minWidth: 18, paddingHorizontal: 3, borderRadius: 4, justifyContent: "center" },
  count: { fontWeight: "500", fontVariant: ["tabular-nums"] },
});
