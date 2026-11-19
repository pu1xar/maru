// The web dialog at phone width (ui/dialog.tsx with its mobile sheet classes): stuck to the bottom,
// full width, square corners and a top edge only, 48 below the top; a header of 24 padding with the
// title (text-xl, font-semibold) and a description (text-sm, muted); a panel of 24 padding with 16
// between fields; a footer band (border-top, --muted at 72%) with its buttons stacked, the primary
// first. The backdrop is the canvas at 60% and the sheet the canvas (the web adds a 12px blur
// behind both, which React Native has no form of).
import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { Text } from "./Text.tsx";
import { XIcon } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePalette } from "../../theme.ts";
import { Press } from "../Press.tsx";
import { ui } from "./metrics.ts";
import { useChrome } from "./useChrome.ts";

export function Sheet(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string | null;
  /** The corner X (the web dialog's default); the new session dialog leaves it out. */
  closeButton?: boolean;
  /** Under the header, above the scrolling panel (the web header's own notices). */
  headerExtra?: ReactNode;
  /** The footer band's buttons, the primary first. */
  footer?: ReactNode;
  /** Nothing for a sheet that is its header and footer only (a confirmation). */
  children?: ReactNode;
}) {
  const p = usePalette();
  const c = useChrome();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const closeButton = props.closeButton ?? true;
  return (
    <Modal visible={props.open} animationType="slide" transparent onRequestClose={props.onClose}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: c.backdrop }]} onPress={props.onClose} accessibilityLabel="Close" />
      <KeyboardAvoidingView behavior="height" style={styles.wrap} pointerEvents="box-none">
        <View style={[styles.sheet, { backgroundColor: p.bg, borderTopColor: c.sheetBorder, maxHeight: height - 48 - insets.top }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: p.text }]} accessibilityRole="header">{props.title}</Text>
            {props.description ? <Text style={[ui.sm, { color: p.muted }]}>{props.description}</Text> : null}
            {props.headerExtra}
          </View>
          {closeButton ? (
            <Press
              onPress={props.onClose}
              accessibilityLabel="Close"
              hitSlop={4}
              android_ripple={{ color: c.accent, borderless: true, radius: 20 }}
              style={styles.close}
            >
              <XIcon size={18} color={p.muted} />
            </Press>
          ) : null}
          {props.children ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={[styles.panel, { paddingBottom: props.footer ? 24 : 24 + insets.bottom }]}
              keyboardShouldPersistTaps="handled"
            >
              {props.children}
            </ScrollView>
          ) : null}
          {props.footer ? (
            <View style={[styles.footer, { backgroundColor: c.footerFill, borderTopColor: p.border, paddingBottom: 16 + insets.bottom }]}>{props.footer}</View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "flex-end" },
  sheet: { borderTopWidth: 1, minHeight: 0 },
  // p-6 with max-sm:pb-4, gap-2.
  header: { padding: 24, paddingBottom: 16, gap: 8 },
  title: { fontSize: 20, lineHeight: 27.5, fontWeight: "600" },
  // absolute end-2 top-2, a 36 icon button.
  close: { position: "absolute", top: 8, right: 8, width: 36, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  scroll: { flexGrow: 0 },
  // p-6, the header above takes the first 24 down to pt-1 (4), gap-4 between fields.
  panel: { paddingHorizontal: 24, paddingTop: 4, gap: 16 },
  // flex-col-reverse gap-2 px-6 py-4, border-t.
  footer: { borderTopWidth: 1, paddingHorizontal: 24, paddingTop: 16, gap: 8, flexDirection: "column-reverse" },
});
