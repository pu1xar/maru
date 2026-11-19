// A picture a message names by file path (DESIGN.md 2d, 6e): a small preview under its paragraph,
// and a tap opens it full screen. The bytes come from the paired server's GET /api/file/raw with
// the device token in the request headers. The same preview draws the pictures an agent opened with
// a tool (ViewedImagePreview): the transcript's copy from GET /api/file/blob first, the file second. The size is read first (Image.getSizeWithHeaders), so a
// missing or unreadable file draws nothing instead of a broken box, and a picture takes the room it
// needs. Only the rows the timeline list has mounted hold a preview, which is the app's lazy load.
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Image, Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Text } from "./ui/Text.tsx";
import { XIcon } from "lucide-react-native";
import { fileRawUrl } from "../../../../packages/shared/src/files.ts";
import { fitPreview, pictureSource } from "../lib/fileImage.ts";
import type { FileImageRef } from "../lib/markdownFiles.ts";
import type { Pairing } from "../lib/pairing.ts";
import { usePalette } from "../theme.ts";
import { type } from "../typography.ts";
import { Press } from "./Press.tsx";

/** The pairing the pictures load with; null outside a paired session view (no preview then). */
export const FilePairingCtx = createContext<Pairing | null>(null);

/** The widest and tallest a preview draws (the web's 20rem by 12rem), further limited by the screen. */
const PREVIEW_MAX_WIDTH = 320;
const PREVIEW_MAX_HEIGHT = 192;
/** Width taken by the conversation's side padding and the message column. */
const SCREEN_MARGIN = 48;

export function FileImagePreview({ image }: { image: FileImageRef }) {
  const urls = useMemo(() => [fileRawUrl(image.path)], [image.path]);
  return <PicturePreview urls={urls} name={image.name} />;
}

/** The picture an agent opened with a tool; `urls` are the server-relative sources in the order tried (viewedImageUrls). */
export function PicturePreview({ urls, name }: { urls: readonly string[]; name: string }) {
  const pairing = useContext(FilePairingCtx);
  const p = usePalette();
  const { width: screenWidth } = useWindowDimensions();
  // The next source is tried when one cannot be read; the last failure draws nothing.
  const [attempt, setAttempt] = useState(0);
  const urlsKey = urls.join("\n");
  useEffect(() => setAttempt(0), [urlsKey]);
  const url = urls[attempt];
  const source = useMemo(() => (pairing && url !== undefined ? pictureSource(pairing, url) : null), [pairing, url]);
  const [size, setSize] = useState<{ width: number; height: number } | "failed" | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!source) return;
    let live = true;
    setSize(null);
    Image.getSizeWithHeaders(
      source.uri,
      source.headers,
      (width, height) => live && setSize({ width, height }),
      () => {
        if (!live) return;
        setSize("failed");
        setAttempt((n) => n + 1);
      },
    );
    return () => {
      live = false;
    };
  }, [source]);
  if (!source || size === null || size === "failed") return null;
  const box = fitPreview(size.width, size.height, Math.min(PREVIEW_MAX_WIDTH, screenWidth - SCREEN_MARGIN), PREVIEW_MAX_HEIGHT);
  if (box.width === 0) return null;
  return (
    <View style={styles.wrap}>
      <Press
        onPress={() => setOpen(true)}
        accessibilityRole="imagebutton"
        accessibilityLabel={`View ${name} larger`}
        style={[styles.thumb, { width: box.width, height: box.height, borderColor: p.border }]}
      >
        <Image source={source} style={{ width: box.width, height: box.height }} resizeMode="contain" accessibilityIgnoresInvertColors />
      </Press>
      {open ? <FullScreenImage source={source} name={name} onClose={() => setOpen(false)} /> : null}
    </View>
  );
}

function FullScreenImage(props: { source: { uri: string; headers: Record<string, string> }; name: string; onClose: () => void }) {
  const [failed, setFailed] = useState(false);
  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={props.onClose}>
      <View style={styles.full}>
        <Pressable style={StyleSheet.absoluteFill} onPress={props.onClose} accessibilityLabel="Close" />
        {failed ? (
          <Text style={[type.body, styles.failed]}>Could not load the image. The file may have been moved or deleted</Text>
        ) : (
          <Image
            source={props.source}
            style={styles.fullImage}
            resizeMode="contain"
            onError={() => setFailed(true)}
            pointerEvents="none"
            accessibilityIgnoresInvertColors
          />
        )}
        <Text style={[type.tiny, styles.name]} numberOfLines={1}>
          {props.name}
        </Text>
        <Press onPress={props.onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close" style={styles.close}>
          <XIcon size={22} color="#ffffff" />
        </Press>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 8, alignItems: "flex-start" },
  thumb: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  full: { flex: 1, backgroundColor: "rgba(0,0,0,0.94)", justifyContent: "center", paddingTop: 48, paddingBottom: 56 },
  fullImage: { flex: 1, width: "100%" },
  failed: { color: "#ffffff", textAlign: "center", paddingHorizontal: 32 },
  name: { position: "absolute", left: 16, right: 16, bottom: 24, color: "rgba(255,255,255,0.8)", textAlign: "center" },
  close: { position: "absolute", top: 40, right: 16, width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.16)" },
});
