// One shell's terminal on the phone (DESIGN.md 6s; the web's components/shell/ShellView.tsx). The
// terminal is xterm.js in a WebView page (shell/page.ts) that holds no socket: this component opens
// the shell's /shell socket with the device token (the web's own ShellConnection, so the attach,
// scrollback and reconnect rules are the web's), hands the page the output, and sends the page's
// keys and the key bar's keys back. The page reports its grid, which becomes the socket's cols and
// rows and follows rotation and the keyboard opening.
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import * as Clipboard from "expo-clipboard";
import type { ShellInfo, ShellServerFrame } from "@maru/shared";
import { ShellConnection, type ShellConnectionState, type ShellSocketLike } from "../../../../web/src/lib/shellConnection.ts";
import { authHeaders, type Pairing } from "../../lib/api.ts";
import { addToast } from "../../lib/toast.ts";
import { serverOrigin } from "../../shell/api.ts";
import { injection, OutputBatcher, parsePageMessage, type AppMessage } from "../../shell/bridge.ts";
import { applyLatches, barKeyData, isModifier, NO_LATCHES, type BarKeyId, type Latches } from "../../shell/keyBar.ts";
import { pageLook, type ShellLook } from "../../shell/look.ts";
import { shellPageHtml } from "../../shell/page.ts";
import { Banner } from "../ui/Notices.tsx";
import { Press } from "../Press.tsx";
import { Text } from "../ui/Text.tsx";
import { ui } from "../ui/metrics.ts";
import { ShellKeyBar } from "./ShellKeyBar.tsx";
import { CircleAlertIcon } from "lucide-react-native";

/** A resize goes to the shell once the box has settled (the web's RESIZE_SETTLE_MS). */
const RESIZE_SETTLE_MS = 120;

type RNWebSocketCtor = new (url: string, protocols?: string | string[] | null, options?: { headers: Record<string, string> }) => WebSocket;

export function ShellView(props: {
  pairing: Pairing;
  shell: ShellInfo;
  look: ShellLook;
  /** Space under the key bar for the gesture bar; it takes the terminal's color. */
  bottomInset: number;
  /** The shell is over (exited, closed elsewhere, gone). */
  onGone: (id: string, reason: "exited" | "closed" | "missing") => void;
}) {
  const { pairing, shell, look } = props;
  const web = useRef<ComponentRef<typeof WebView>>(null);
  const [state, setState] = useState<ShellConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  /** Bumped by the Reconnect button: a new socket for the same page. */
  const [attempt, setAttempt] = useState(0);
  /** Bumped each time the page says it is ready (the first load, and a reload after its process died). */
  const [pageReady, setPageReady] = useState(0);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [latches, setLatchesState] = useState<Latches>(NO_LATCHES);
  const latchRef = useRef<Latches>(NO_LATCHES);
  const grid = useRef<{ cols: number; rows: number } | null>(null);
  const conn = useRef<ShellConnection | null>(null);
  const appCursor = useRef(false);
  const focused = useRef(false);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onGone = useRef(props.onGone);
  onGone.current = props.onGone;

  // The page of the look this view opened with; a later change arrives as a `look` message.
  const html = useMemo(() => shellPageHtml(pageLook(look)), []);
  const tell = useCallback((message: AppMessage) => web.current?.injectJavaScript(injection(message)), []);
  const setLatches = (next: Latches) => {
    latchRef.current = next;
    setLatchesState(next);
  };

  // The socket is held while the app is on the screen: in the background it is let go, and the
  // attach on return sends the scrollback and the screen again (nothing is lost, tmux has it).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setForeground(s === "active"));
    return () => sub.remove();
  }, []);

  // A change of font, size or colors reaches the open page.
  useEffect(() => {
    if (pageReady > 0) tell({ t: "look", look: pageLook(look) });
  }, [look, pageReady, tell]);

  useEffect(() => {
    const size = grid.current;
    if (pageReady === 0 || !foreground || !size) return;
    const origin = serverOrigin(pairing.server);
    if (!origin) {
      setError(`Cannot open a shell on ${pairing.server}`);
      return;
    }
    const batcher = new OutputBatcher({ send: (b) => tell({ t: "out", b }) });
    const c = new ShellConnection({
      id: shell.id,
      origin,
      grid: () => grid.current ?? size,
      open: (url) => new (WebSocket as unknown as RNWebSocketCtor)(url, null, { headers: authHeaders(pairing) }) as unknown as ShellSocketLike,
      onAttached: () => {
        // The server sends the scrollback and the screen again on every attach.
        batcher.clear();
        tell({ t: "reset" });
        setError(null);
        // The first attach of this view asks for the keyboard (the web's terminal takes it on open); a return from the background does not.
        if (!focused.current) {
          focused.current = true;
          tell({ t: "focus" });
        }
      },
      onOutput: (data) => batcher.push(data),
      onEnded: (frame: Extract<ShellServerFrame, { type: "ended" }>) => {
        if (frame.reason === "error") setError(frame.message ?? "Could not attach to the shell");
        else onGone.current(shell.id, frame.reason);
      },
      onState: setState,
    });
    conn.current = c;
    return () => {
      batcher.clear();
      c.dispose();
      if (conn.current === c) conn.current = null;
    };
  }, [pairing, shell.id, attempt, pageReady, foreground, tell]);

  useEffect(() => () => clearTimeout(resizeTimer.current), []);

  const onMessage = (event: WebViewMessageEvent) => {
    const m = parsePageMessage(event.nativeEvent.data);
    if (!m) return;
    switch (m.t) {
      case "ready":
        grid.current = { cols: m.cols, rows: m.rows };
        setPageReady((n) => n + 1);
        break;
      case "resize":
        grid.current = { cols: m.cols, rows: m.rows };
        clearTimeout(resizeTimer.current);
        resizeTimer.current = setTimeout(() => conn.current?.resize(m.cols, m.rows), RESIZE_SETTLE_MS);
        break;
      case "in": {
        // A latched Ctrl or Alt applies to the next key typed, from the keyboard or the bar.
        const l = latchRef.current;
        if (l.ctrl || l.alt) {
          setLatches(NO_LATCHES);
          conn.current?.input(applyLatches(m.d, l));
        } else {
          conn.current?.input(m.d);
        }
        break;
      }
      case "bin":
        conn.current?.inputBinary(m.d);
        break;
      case "mode":
        appCursor.current = m.appCursor;
        break;
      case "error":
        setError(`Terminal page failed: ${m.message}`);
        break;
    }
  };

  const pressKey = (id: BarKeyId) => {
    if (isModifier(id)) {
      setLatches({ ...latchRef.current, [id]: !latchRef.current[id] });
      return;
    }
    if (id === "paste") {
      Clipboard.getStringAsync().then(
        (text) => {
          if (text) tell({ t: "paste", text });
        },
        () => addToast({ type: "error", title: "Could not read the clipboard" }),
      );
      return;
    }
    const data = barKeyData(id, latchRef.current, appCursor.current);
    if (data === null) return;
    if (latchRef.current.ctrl || latchRef.current.alt) setLatches(NO_LATCHES);
    conn.current?.input(data);
  };

  const background = pageLook(look).theme.background;
  return (
    <View style={[styles.fill, { backgroundColor: background, paddingBottom: props.bottomInset }]} testID={`shell-view-${shell.id}`}>
      <View style={styles.fill}>
        <WebView
          ref={web}
          source={{ html }}
          style={[styles.fill, { backgroundColor: background }]}
          containerStyle={{ backgroundColor: background }}
          onMessage={onMessage}
          onRenderProcessGone={() => web.current?.reload()}
          javaScriptEnabled
          domStorageEnabled={false}
          allowFileAccess={false}
          setSupportMultipleWindows={false}
          mixedContentMode="never"
          textZoom={100}
          scrollEnabled={false}
          overScrollMode="never"
          androidLayerType="hardware"
          accessibilityLabel={`Shell ${shell.command}`}
        />
        {state === "reconnecting" ? (
          <View pointerEvents="none" accessibilityRole="alert" style={styles.reconnecting}>
            <Text style={[ui.xs, { color: "rgba(255,255,255,0.8)" }]}>Reconnecting</Text>
          </View>
        ) : null}
        {error ? (
          <View style={styles.error}>
            <Banner tone="error" icon={CircleAlertIcon}>
              {error}
            </Banner>
            <Press onPress={() => setAttempt((n) => n + 1)} accessibilityRole="button" accessibilityLabel="Reconnect" style={styles.reconnect}>
              <Text style={[ui.sm, { color: "rgba(255,255,255,0.85)", fontWeight: "500" }]}>Reconnect</Text>
            </Press>
          </View>
        ) : null}
      </View>
      <ShellKeyBar latches={latches} onKey={pressKey} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // absolute top-1.5 right-3, a pill of black at 60%.
  reconnecting: { position: "absolute", top: 6, right: 12, borderRadius: 6, backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 2 },
  // Over the terminal's lower edge, above the key bar.
  error: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.75)" },
  reconnect: { alignSelf: "flex-start", marginHorizontal: 12, marginBottom: 8, minHeight: 32, paddingHorizontal: 12, justifyContent: "center", borderRadius: 6, backgroundColor: "rgba(255,255,255,0.12)" },
});
