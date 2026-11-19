// Pairing with a maru server: scan the QR from the web's Devices tab, paste its link, or open the link
// on this phone (a maru:// deep link brings it here). Every link, however it came, stops at the
// confirmation that names its server (DESIGN.md 2d, pairing confirmation): a link anyone can make decides
// where this app sends everything, so the user sees the host before the code is claimed.
import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Text, TextInput } from "../components/ui/Text.tsx";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { parsePairingLink, reviewPairing, type PairingTarget } from "../lib/pairingLink.ts";
import { claimPairing, type Pairing } from "../lib/pairing.ts";
import { usePalette, type Palette } from "../theme.ts";
import { type } from "../typography.ts";
import { Press } from "../components/Press.tsx";
import { MaruMark } from "../components/sidebar/MaruMark.tsx";
import { ui } from "../components/ui/metrics.ts";
import { useChrome } from "../components/ui/useChrome.ts";
import { VERSION_LABEL } from "../version.ts";

export function PairScreen(props: {
  initialLink: string | null;
  notice: string | null;
  /** The pairing this phone has now, when a link arrived while paired. */
  current: Pairing | null;
  /** Stores the claimed pairing; the confirmation stays busy until it settles and shows a failure. */
  onPaired: (p: Pairing) => Promise<void>;
  /** Back to the paired app without changing anything (a link arrived while paired). */
  onCancel?: () => void;
}) {
  const p = usePalette();
  const c = useChrome();
  const insets = useSafeAreaInsets();
  const [link, setLink] = useState(props.initialLink ?? "");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(props.notice);
  const [target, setTarget] = useState<PairingTarget | null>(null);
  // The confirm button arms a moment after a link appears or changes, so a tap meant for what was
  // on the screen before (another link arriving mid-review, the app opening under a finger)
  // cannot confirm the new server.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    if (!target) return;
    const t = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(t);
  }, [target]);
  const [permission, requestPermission] = useCameraPermissions();

  /** Reads a link and asks for confirmation; nothing goes to any server yet. */
  const review = (text: string) => {
    const parsed = parsePairingLink(text);
    if ("error" in parsed) {
      setError(parsed.error);
      setTarget(null);
      return;
    }
    setError(null);
    setTarget(parsed);
  };

  const confirm = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await props.onPaired(await claimPairing(target));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTarget(null);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setTarget(null);
    if (props.current && props.onCancel) props.onCancel();
  };

  useEffect(() => {
    if (props.notice) setError(props.notice);
  }, [props.notice]);

  useEffect(() => {
    // A link that arrives while a claim is under way waits; the claim decides what happens next.
    if (!props.initialLink || busy) return;
    setLink(props.initialLink);
    review(props.initialLink);
  }, [props.initialLink]);

  const startScan = async () => {
    if (!permission?.granted) {
      const r = await requestPermission();
      if (!r.granted) {
        setError("Camera permission is missing, so the QR cannot be read. Paste the link instead");
        return;
      }
    }
    setError(null);
    setScanning(true);
  };

  if (scanning) {
    return (
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={(r) => {
            setScanning(false);
            setLink(r.data);
            review(r.data);
          }}
        />
        <View style={[styles.frame, { borderColor: "#fff" }]} />
        <Press onPress={() => setScanning(false)} style={[styles.cancel, { bottom: 32 + insets.bottom }]}>
          <Text style={[type.body, { color: "#fff" }]}>Cancel</Text>
        </Press>
      </View>
    );
  }

  if (target) {
    return (
      <Confirm
        p={p}
        top={insets.top}
        bottom={insets.bottom}
        target={target}
        current={props.current}
        busy={busy}
        armed={armed}
        onConfirm={() => void confirm()}
        onCancel={cancel}
      />
    );
  }

  return (
    <Page p={p} top={insets.top} bottom={insets.bottom}>
      <MaruMark size={40} color={p.text} />
      <Text accessibilityRole="header" style={[styles.h1, { color: p.text }]}>Connect to maru</Text>
      <Text style={[ui.sm, { color: p.muted, lineHeight: 21 }]}>
        In maru web, open Settings, then Devices, and choose Connect Android. Scan its QR, or paste the link from that dialog and press Connect.
      </Text>
      <View style={styles.form}>
        <PairButton p={p} label="Scan QR" onPress={() => void startScan()} disabled={busy} />
        <View style={styles.field}>
          <Text style={[styles.label, { color: p.text }]}>Pairing link</Text>
          <TextInput
            value={link}
            onChangeText={setLink}
            placeholder="maru://pair?..."
            placeholderTextColor={p.muted}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            multiline
            style={[styles.input, { color: p.text, borderColor: p.border, backgroundColor: c.inputFill }]}
          />
        </View>
        <View style={styles.row}>
          <PairButton p={p} grow secondary label="Paste" onPress={() => void Clipboard.getStringAsync().then(setLink)} />
          <PairButton p={p} grow label="Connect" onPress={() => review(link)} disabled={busy || !link.trim()} />
        </View>
      </View>
      {props.current && props.onCancel ? <PairButton p={p} secondary label="Back" onPress={props.onCancel} /> : null}
      <Text accessibilityRole="alert" style={[ui.sm, { color: p.danger, minHeight: 21, lineHeight: 21 }]}>{error ?? ""}</Text>
    </Page>
  );
}

/**
 * The desktop app's pairing page (apps/desktop/src/pages/pair.html and shell.css) on the phone: its
 * column of 420 at most with 14 between parts, the mark above the title, the version at the foot.
 */
function Page(props: { p: Palette; top: number; bottom: number; children: ReactNode }) {
  const { p } = props;
  return (
    <View style={{ flex: 1, backgroundColor: p.bg, paddingTop: props.top + 24, paddingBottom: props.bottom + 12, paddingHorizontal: 16 }}>
      <View style={styles.center}>
        <View style={styles.main}>{props.children}</View>
      </View>
      <Text style={[ui.xs, { color: p.muted, textAlign: "center" }]}>{VERSION_LABEL}</Text>
    </View>
  );
}

/** The desktop page's button: 36 high, radius 8, the primary with white text in font-semibold, or transparent with the border. */
function PairButton(props: { p: Palette; label: string; grow?: boolean; secondary?: boolean; busy?: boolean; armed?: boolean; disabled?: boolean; onPress: () => void }) {
  const { p } = props;
  const off = props.disabled || props.busy || props.armed === false;
  return (
    <Press
      onPress={props.onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off }}
      style={[
        styles.button,
        props.grow ? { flex: 1 } : null,
        props.secondary ? { borderColor: p.border } : { backgroundColor: p.accent, borderColor: "transparent" },
        { opacity: off ? 0.55 : 1 },
      ]}
    >
      {props.busy ? (
        <ActivityIndicator size="small" color={p.onAccent} />
      ) : (
        <Text style={[ui.sm, { color: props.secondary ? p.text : p.onAccent, fontWeight: props.secondary ? "500" : "600" }]}>{props.label}</Text>
      )}
    </Press>
  );
}

/** "Connect to this server?": the link's host, large, and what connecting replaces. The server box is the web's pairing dialog box (rounded-xl, border, a muted label over a mono value). */
function Confirm(props: {
  p: Palette;
  top: number;
  bottom: number;
  target: PairingTarget;
  current: Pairing | null;
  busy: boolean;
  armed: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { p } = props;
  const r = reviewPairing(props.target, props.current?.server ?? null);
  return (
    <Page p={p} top={props.top} bottom={props.bottom}>
      <Text accessibilityRole="header" style={[styles.h1, { color: p.text }]}>Connect to this server?</Text>
      <View style={[styles.serverBox, { borderColor: p.border }]}>
        <Text style={[ui.xs, { color: p.muted }]}>Server address</Text>
        <Text style={{ fontFamily: "monospace", fontSize: 24, lineHeight: 32, letterSpacing: 1.2, color: p.text }} selectable>{r.host}</Text>
        <Text style={{ fontFamily: "monospace", fontSize: 14, lineHeight: 20, color: p.muted }} selectable>{r.origin}</Text>
        {r.loopback ? <Text style={[ui.xs, { color: p.muted }]}>This is the phone's loopback address (a test server)</Text> : null}
      </View>
      <Text style={[ui.sm, { color: p.muted, lineHeight: 21 }]}>
        Connecting sends all of this app's conversations and commands to this server. Do not connect unless you opened this link yourself from the Devices screen of your own maru web.
      </Text>
      {r.replaces === "other-server" ? (
        <Text style={[ui.sm, { color: p.warn, lineHeight: 21 }]}>
          {`This is a different server from the connected ${r.currentHost ?? "server"}. Connecting disconnects the current one.`}
        </Text>
      ) : r.replaces === "same-server" ? (
        <Text style={[ui.sm, { color: p.muted, lineHeight: 21 }]}>This is the connected server. It reconnects with a new token.</Text>
      ) : null}
      <View style={styles.row}>
        <PairButton p={p} grow secondary label="Cancel" onPress={props.onCancel} disabled={props.busy} />
        <PairButton p={p} grow label="Connect" onPress={props.onConfirm} busy={props.busy} armed={props.armed} />
      </View>
    </Page>
  );
}

const ARM_MS = 800;

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  // main: width 100%, max-width 420, gap 14.
  main: { width: "100%", maxWidth: 420, gap: 14 },
  h1: { fontSize: 22, lineHeight: 33, fontWeight: "600", letterSpacing: -0.22 },
  form: { gap: 12 },
  field: { gap: 6 },
  label: { fontSize: 13, lineHeight: 19.5, fontWeight: "500" },
  row: { flexDirection: "row", gap: 8 },
  // input: 36 high (this one holds a link, so it grows), radius 8, 13 mono.
  input: { minHeight: 72, borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8, fontFamily: "monospace", fontSize: 13, lineHeight: 19.5, textAlignVertical: "top" },
  button: { minHeight: 36, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 14, overflow: "hidden" },
  frame: { position: "absolute", alignSelf: "center", top: "28%", width: 240, height: 240, borderWidth: 2, borderRadius: 18 },
  cancel: { position: "absolute", alignSelf: "center", paddingHorizontal: 24, paddingVertical: 12 },
  serverBox: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 12, gap: 4 },
});
