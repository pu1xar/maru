// The strips the web draws in the conversation: the Banner above the timeline (ThreadView.tsx: a row
// with a bottom edge, icon and text-xs in the tone's color) and, above the composer, the error
// box (rounded-lg, --error-surface, text-xs in --error-foreground, alert icon) and the notice box
// (--accent fill, --foreground text, an info icon and a close button) of ThreadComposer.tsx. They
// are inside the conversation, so their text-xs is the conversation's (ui/metrics.ts `chat`).
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "./Text.tsx";
import { CircleAlertIcon, InfoIcon, XIcon, type LucideIcon } from "lucide-react-native";
import { usePalette } from "../../theme.ts";
import { Press } from "../Press.tsx";
import { chat } from "./metrics.ts";
import { useChrome } from "./useChrome.ts";

export function Banner(props: { tone?: "info" | "warning" | "error"; icon: LucideIcon; children: ReactNode }) {
  const p = usePalette();
  const c = useChrome();
  const color = props.tone === "error" ? c.errorForeground : props.tone === "warning" ? c.warningForeground : p.muted;
  return (
    <View accessibilityRole="alert" style={[styles.banner, { borderBottomColor: p.border }]}>
      <View style={styles.bannerInner}>
        <props.icon size={14} color={color} />
        <Text style={[chat.xs, { color, flex: 1, minWidth: 0 }]}>{props.children}</Text>
      </View>
    </View>
  );
}

export function ErrorBox({ message }: { message: string }) {
  const c = useChrome();
  return (
    <View accessibilityRole="alert" style={[styles.box, { backgroundColor: c.errorSurface }]}>
      <CircleAlertIcon size={14} color={c.errorForeground} style={{ marginTop: 2 }} />
      <Text style={[chat.xs, { color: c.errorForeground, flex: 1 }]}>{message}</Text>
    </View>
  );
}

export function NoticeBox({ message, onClose, embedded }: { message: string; onClose: () => void; embedded?: boolean }) {
  const p = usePalette();
  const c = useChrome();
  return (
    <View accessibilityRole="summary" style={[styles.box, embedded ? styles.embedded : null, { backgroundColor: c.accent }]}>
      <InfoIcon size={14} color={p.muted} style={{ marginTop: 2 }} />
      <Text style={[chat.xs, { color: p.text, flex: 1 }]}>{message}</Text>
      <Press onPress={onClose} accessibilityLabel="Dismiss notice" hitSlop={12} style={styles.close}>
        <XIcon size={14} color={p.muted} />
      </Press>
    </View>
  );
}

const styles = StyleSheet.create({
  // chat-composer-lane (12 each side), border-b, py-1.5, gap-2.
  banner: { paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1 },
  bannerInner: { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: 736, width: "100%", alignSelf: "center" },
  // rounded-lg px-3 py-2 gap-2, in the composer lane.
  embedded: { marginHorizontal: 0, marginTop: 0, marginBottom: 0 },
  box: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginHorizontal: 12, marginTop: 6, marginBottom: 2, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  // -my-0.5 size-5 rounded-md.
  close: { width: 20, height: 20, borderRadius: 6, alignItems: "center", justifyContent: "center", marginVertical: -2 },
});
