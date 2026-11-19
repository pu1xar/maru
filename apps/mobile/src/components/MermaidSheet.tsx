// A sheet that draws one Mermaid diagram (DESIGN.md 7g). The diagram is drawn by Pele inside a
// WebView page that carries its own renderer (mermaid/page.ts), so it works offline and the
// conversation list holds no WebView: the sheet opens from a code block's "View diagram" button
// and is mounted only while open. This module is loaded the first time a button is pressed
// (Markdown.tsx), so the renderer's text stays out of the app's start.
import { useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { XIcon } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { mermaidFailureLine } from "../../../web/src/components/chat/MarkdownMermaid.logic.ts";
import { fonts, usePalette } from "../theme.ts";
import { type } from "../typography.ts";
import { mermaidPageHtml } from "../mermaid/page.ts";
import { parsePageMessage } from "../mermaid/model.ts";
import { Press } from "./Press.tsx";
import { Text } from "./ui/Text.tsx";
import { ui } from "./ui/metrics.ts";
import { useChrome } from "./ui/useChrome.ts";

export default function MermaidSheet(props: { source: string; onClose: () => void }) {
  const p = usePalette();
  const c = useChrome();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const html = useMemo(
    () => mermaidPageHtml(props.source, p),
    [props.source, p.bg, p.text, p.muted, p.accent, p.danger],
  );
  const [failure, setFailure] = useState<{ code: string; line: number; message: string } | null>(null);

  const onMessage = (event: WebViewMessageEvent) => {
    const message = parsePageMessage(event.nativeEvent.data);
    if (message?.t === "failed") setFailure(message);
  };
  const line = failure ? mermaidFailureLine(failure) : null;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={props.onClose}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: c.backdrop }]} onPress={props.onClose} accessibilityLabel="Close" />
      <View style={styles.wrap} pointerEvents="box-none">
        <View style={[styles.sheet, { backgroundColor: p.bg, borderTopColor: c.sheetBorder, height: height - 48 - insets.top }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: p.text }]} accessibilityRole="header">Mermaid diagram</Text>
            <Press
              onPress={props.onClose}
              accessibilityLabel="Close"
              hitSlop={4}
              android_ripple={{ color: c.accent, borderless: true, radius: 20 }}
              style={styles.close}
            >
              <XIcon size={18} color={p.muted} />
            </Press>
          </View>
          {line ? (
            <View style={[styles.fallback, { paddingBottom: 16 + insets.bottom }]}>
              <Text style={[ui.sm, { color: c.errorForeground }]} accessibilityRole="alert">{line.summary}</Text>
              <Text style={[ui.xs, { color: p.muted }]} selectable>{line.detail}</Text>
              <Text
                style={{ color: p.text, fontFamily: fonts.mono, fontSize: type.code.fontSize, lineHeight: type.code.lineHeight }}
                selectable
              >
                {props.source}
              </Text>
            </View>
          ) : (
            <WebView
              source={{ html }}
              originWhitelist={["about:blank"]}
              onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
              onMessage={onMessage}
              style={[styles.web, { backgroundColor: p.bg }]}
              containerStyle={{ backgroundColor: p.bg }}
              javaScriptEnabled
              domStorageEnabled={false}
              allowFileAccess={false}
              allowFileAccessFromFileURLs={false}
              allowUniversalAccessFromFileURLs={false}
              setSupportMultipleWindows={false}
              mixedContentMode="never"
              textZoom={100}
              overScrollMode="never"
              androidLayerType="hardware"
              accessibilityLabel="Mermaid diagram"
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "flex-end" },
  sheet: { borderTopWidth: 1, minHeight: 0 },
  header: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 8, minHeight: 52, justifyContent: "center" },
  title: { fontSize: 20, lineHeight: 27.5, fontWeight: "600" },
  close: { position: "absolute", top: 8, right: 8, width: 36, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  web: { flex: 1 },
  fallback: { paddingHorizontal: 24, paddingTop: 4, gap: 12 },
});
