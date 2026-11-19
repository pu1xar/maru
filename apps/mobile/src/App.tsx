// maru for Android (DESIGN.md 2d): the pairing screen until this phone holds a device token, then
// the session drawer and conversation. A maru://pair link opened on the phone lands on pairing,
// which confirms the link's server before anything is claimed, also while paired.
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import * as Linking from "expo-linking";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { adoptPairing, forget, loadPairing, type Pairing } from "./lib/pairing.ts";
import { PairScreen } from "./screens/PairScreen.tsx";
import { MainScreen } from "./screens/MainScreen.tsx";
import { FilePairingCtx } from "./components/FileImage.tsx";
import { AppearanceProvider, useAppearance } from "./appearance.tsx";
import { usePalette } from "./theme.ts";

export default function App() {
  return (
    <SafeAreaProvider>
      <AppearanceProvider>
        <Root />
      </AppearanceProvider>
    </SafeAreaProvider>
  );
}

function Root() {
  const p = usePalette();
  const { ready } = useAppearance();
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const url = Linking.useLinkingURL();
  // A pairing link that arrived while the app runs; it stays on the pairing screen until it is
  // used or dismissed.
  const [usedLink, setUsedLink] = useState<string | null>(null);
  const pairLink = url?.startsWith("maru://pair") && url !== usedLink ? url : null;

  useEffect(() => {
    loadPairing().then(setPairing, () => setPairing(null));
  }, []);

  const revoked = useCallback(() => {
    void forget(pairing ?? null, { tellServer: false }).then(() => {
      setNotice("The server disconnected this device. Pair it again");
      setPairing(null);
    });
  }, [pairing]);
  const unpair = useCallback(() => {
    void forget(pairing ?? null, { tellServer: true }).then(() => setPairing(null));
  }, [pairing]);

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <StatusBar style="auto" />
      {pairing === undefined || !ready ? (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <ActivityIndicator color={p.muted} />
        </View>
      ) : pairing === null || pairLink ? (
        <PairScreen
          initialLink={pairLink}
          notice={notice}
          current={pairing}
          onPaired={async (next) => {
            // A failure surfaces on the pairing screen, which waits for this to settle.
            try {
              await adoptPairing(next, pairing);
            } catch (e) {
              throw new Error(`Could not save the device token: ${e instanceof Error ? e.message : String(e)}`);
            }
            setNotice(null);
            setUsedLink(pairLink);
            setPairing(next);
          }}
          {...(pairing ? { onCancel: () => setUsedLink(pairLink) } : {})}
        />
      ) : (
        <FilePairingCtx value={pairing}>
          <MainScreen key={pairing.device.id} pairing={pairing} onRevoked={revoked} onUnpair={unpair} />
        </FilePairingCtx>
      )}
    </View>
  );
}
