// The web's toasts (components/ui/toast.tsx) as an overlay of the main screen: top right, 16 in from
// the edges and 16 under the header, a popover card (radius 8, the popup outline) with the type's
// icon, the title in font-medium and the description muted (text-sm), a copy button on an error that
// has a description, and the corner dismiss orb. Each closes after 5 seconds (lib/toast.ts). The web
// puts them above its dialogs; a React Native Modal is a window of its own, so a toast that arrives
// while a sheet is open shows when the sheet closes.
import { useState, useSyncExternalStore, createElement } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Text } from "./Text.tsx";
import { CheckIcon, CircleAlertIcon, CircleCheckIcon, CopyIcon, InfoIcon, TriangleAlertIcon, XIcon, type LucideIcon } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { closeToast, subscribeToasts, toasts, type ToastItem, type ToastType } from "../../lib/toast.ts";
import { usePalette } from "../../theme.ts";
import { HEADER_HEIGHT } from "../ScreenHeader.tsx";
import { Press } from "../Press.tsx";
import { ui } from "./metrics.ts";
import { useChrome } from "./useChrome.ts";

/** The web's TOAST_ICONS (lucide). */
const ICON: Record<Exclude<ToastType, "loading">, LucideIcon> = {
  error: CircleAlertIcon,
  success: CircleCheckIcon,
  info: InfoIcon,
  warning: TriangleAlertIcon,
};

export function ToastHost() {
  const items = useSyncExternalStore(subscribeToasts, toasts, toasts);
  const insets = useSafeAreaInsets();
  if (items.length === 0) return null;
  return (
    <View pointerEvents="box-none" style={[styles.host, { top: insets.top + HEADER_HEIGHT + 16 }]}>
      {items.map((t) => (
        <Toast key={t.id} toast={t} />
      ))}
    </View>
  );
}

function Toast({ toast }: { toast: ToastItem }) {
  const p = usePalette();
  const c = useChrome();
  const [copied, setCopied] = useState(false);
  const copyable = toast.type === "error" && toast.description !== null;
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.card, { backgroundColor: p.surface, borderColor: c.popupBorder }]}>
      <View style={[styles.content, { paddingRight: copyable ? 24 : 14 }]}>
        <View style={styles.body}>
          <View style={styles.titleRow}>
            <View style={styles.icon}>
              {toast.type === "loading" ? (
                <ActivityIndicator size="small" color={p.muted} style={{ transform: [{ scale: 0.7 }] }} />
              ) : (
                createElement(ICON[toast.type], { size: 16, color: c.toastIcon[toast.type] })
              )}
            </View>
            <Text style={[ui.sm, styles.title, { color: p.text }]}>{toast.title}</Text>
          </View>
          {toast.description ? (
            <Text selectable numberOfLines={toast.type === "error" && toast.description.length >= 180 ? 4 : undefined} style={[ui.sm, { color: p.muted }]}>
              {toast.description}
            </Text>
          ) : null}
        </View>
        {copyable ? (
          <Press
            onPress={() => {
              void Clipboard.setStringAsync(toast.description ?? "").then(() => setCopied(true));
            }}
            accessibilityLabel={copied ? "Copied" : "Copy error"}
            hitSlop={10}
            style={styles.copy}
          >
            {copied ? <CheckIcon size={12} color={p.accent} /> : <CopyIcon size={12} color={p.muted} />}
          </Press>
        ) : null}
      </View>
      <Press
        onPress={() => closeToast(toast.id)}
        accessibilityLabel="Dismiss notification"
        hitSlop={10}
        style={[styles.orb, { borderColor: c.groupBorder, backgroundColor: p.surface }]}
      >
        <XIcon size={12} color={p.muted} strokeWidth={2.25} />
      </Press>
    </View>
  );
}

const styles = StyleSheet.create({
  // fixed, z-100, inset 16, max-w-90 (360), right-anchored.
  host: { position: "absolute", left: 16, right: 16, alignItems: "flex-end", gap: 12, zIndex: 100 },
  card: { width: "100%", maxWidth: 360, borderWidth: 1, borderRadius: 8, elevation: 8 },
  // pl-3.5 py-3, inline row gap-1.5.
  content: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 14, paddingVertical: 12 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: "row", gap: 8 },
  icon: { width: 16, height: 20, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, minWidth: 0, fontWeight: "500" },
  copy: { position: "absolute", right: 8, top: 12, width: 16, height: 20, alignItems: "center", justifyContent: "center" },
  // size-6, -top-1.5 -right-1.5, border-border/60.
  orb: { position: "absolute", top: -6, right: -6, width: 24, height: 24, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
});
