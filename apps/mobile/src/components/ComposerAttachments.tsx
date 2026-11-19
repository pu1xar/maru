// The attachments of the input (DESIGN.md 6n), as the web's strip and file button: pictures as 64
// tiles with a remove button in the corner, then one row per file with its size, inside the box above
// the text (ComposerAttachmentStrip). A touch screen has no tooltip, so a failed upload or a picture
// sent by path only says why in a line under the strip, and a failed one retries on a tap. The menu
// the clip button opens (gallery, camera, files) replaces the browser's file chooser.
import { useChrome } from "./ui/useChrome.ts";
import { Image, Modal, Pressable, StyleSheet, View } from "react-native";
import { Text } from "./ui/Text.tsx";
import { CameraIcon, CircleAlertIcon, FileIcon, ImageIcon, XIcon, type LucideIcon } from "lucide-react-native";
import { formatBytes } from "../../../web/src/lib/composerAttachments.logic.ts";
import type { WaitingAttachment } from "../lib/composerAttachments.logic.ts";
import { scaleAlpha } from "../lib/composerColors.ts";
import { usePalette } from "../theme.ts";
import { type } from "../typography.ts";
import { Press } from "./Press.tsx";
import { useComposerColors } from "./useComposerColors.ts";

/** The web's progressLabel: the share uploaded, capped at 99 until the server answers. */
export function progressLabel(a: WaitingAttachment): string {
  const total = a.sizeBytes ?? 0;
  if (total <= 0) return "Uploading";
  return `${Math.min(99, Math.floor((a.sentBytes / total) * 100))}%`;
}

export function AttachmentStrip(props: {
  items: readonly WaitingAttachment[];
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  const p = usePalette();
  const c = useComposerColors();
  if (props.items.length === 0) return null;
  const pictures = props.items.filter((a) => a.image && a.uri !== "");
  const files = props.items.filter((a) => !pictures.includes(a));
  const why = props.items.filter((a) => a.status === "failed" || a.uploaded?.notice);
  return (
    <View style={styles.strip}>
      {pictures.length > 0 ? (
        <View style={styles.tiles}>
          {pictures.map((a) => (
            <Press
              key={a.localId}
              onPress={a.status === "failed" ? () => props.onRetry(a.localId) : undefined}
              disabled={a.status !== "failed"}
              accessibilityLabel={a.status === "failed" ? `Retry upload of ${a.name}` : a.name}
              style={[styles.tile, { backgroundColor: p.bg, borderColor: scaleAlpha(p.border, 0.8) }]}
            >
              <Image source={{ uri: a.uri }} style={styles.image} accessibilityIgnoresInvertColors />
              {a.status === "uploading" ? (
                <View style={[styles.progress, { backgroundColor: scaleAlpha(p.bg, 0.85) }]}>
                  <Text style={[type.tiny, { color: p.text, textAlign: "center" }]}>{progressLabel(a)}</Text>
                </View>
              ) : null}
              <StateMark item={a} style={styles.tileState} />
              <Press
                onPress={() => props.onRemove(a.localId)}
                hitSlop={8}
                accessibilityLabel={`Remove ${a.name}`}
                style={[styles.mediaClose, { backgroundColor: c.mediaFill, borderColor: c.mediaRing }]}
              >
                <XIcon size={16} color={c.mediaIcon} />
              </Press>
            </Press>
          ))}
        </View>
      ) : null}
      {files.length > 0 ? (
        <View style={styles.rows}>
          {files.map((a) => (
            <View key={a.localId} style={styles.row}>
              {a.image ? <ImageIcon size={16} color={p.muted} /> : <FileIcon size={16} color={p.muted} />}
              <Text style={[type.row, { color: p.text, flex: 1 }]} numberOfLines={1}>{a.name}</Text>
              <Text style={[type.small, { color: p.muted }]}>
                {a.status === "uploading" ? progressLabel(a) : a.sizeBytes === null ? "" : formatBytes(a.sizeBytes)}
              </Text>
              <StateMark item={a} />
              <Press onPress={() => props.onRemove(a.localId)} hitSlop={8} accessibilityLabel={`Remove ${a.name}`} style={styles.ghost}>
                <XIcon size={16} color={p.text} />
              </Press>
            </View>
          ))}
        </View>
      ) : null}
      {why.map((a) => (
        <Press
          key={`why-${a.localId}`}
          onPress={a.status === "failed" ? () => props.onRetry(a.localId) : undefined}
          disabled={a.status !== "failed"}
          accessibilityLabel={a.status === "failed" ? `Retry upload of ${a.name}` : undefined}
        >
          <Text style={[type.small, { color: a.status === "failed" ? c.errorText : c.warnText }]}>
            {`${a.name}: ${a.status === "failed" ? (a.error ?? "Upload failed") : a.uploaded?.notice}${a.status === "failed" && a.uri !== "" ? " (tap to retry)" : ""}`}
          </Text>
        </Press>
      ))}
    </View>
  );
}

/** The web's AttachmentState: an alert mark on a failed upload, or on a picture the server sends by path only. */
function StateMark(props: { item: WaitingAttachment; style?: object }) {
  const p = usePalette();
  const c = useComposerColors();
  const { item } = props;
  if (item.status !== "failed" && !item.uploaded?.notice) return null;
  return (
    <View style={[styles.state, { backgroundColor: scaleAlpha(p.bg, 0.85) }, props.style]} accessibilityElementsHidden>
      <CircleAlertIcon size={14} color={item.status === "failed" ? p.danger : c.warnText} />
    </View>
  );
}

export type AttachChoice = "photos" | "camera" | "files";

const CHOICES: ReadonlyArray<{ id: AttachChoice; label: string; icon: LucideIcon }> = [
  { id: "photos", label: "Photos", icon: ImageIcon },
  { id: "camera", label: "Camera", icon: CameraIcon },
  { id: "files", label: "Files", icon: FileIcon },
];

/** The menu over the clip button: a sheet from the bottom, as the app's other pickers. */
export function AttachMenu(props: { open: boolean; onChoose: (choice: AttachChoice) => void; onClose: () => void }) {
  const p = usePalette();
  const chrome = useChrome();
  return (
    <Modal visible={props.open} animationType="fade" transparent onRequestClose={props.onClose}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: chrome.backdrop }]} onPress={props.onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { backgroundColor: p.bg, borderColor: p.border }]}>
        {CHOICES.map((c) => (
          <Press key={c.id} onPress={() => props.onChoose(c.id)} style={styles.choice} accessibilityRole="button">
            <c.icon size={22} color={p.text} />
            <Text style={[type.body, { color: p.text }]}>{c.label}</Text>
          </Press>
        ))}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // web: flex-col gap-2; tiles flex-wrap gap-2; file rows flex-col gap-1
  strip: { gap: 8 },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: { width: 64, height: 64, borderRadius: 8, borderWidth: 1, overflow: "hidden" },
  image: { width: "100%", height: "100%" },
  progress: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 4 },
  tileState: { position: "absolute", left: 4, bottom: 4 },
  state: { borderRadius: 4, padding: 2, alignItems: "center", justifyContent: "center" },
  // web variant media-close, size icon-xs (size-7 below the sm width), at right-1 top-1
  mediaClose: { position: "absolute", right: 4, top: 4, width: 28, height: 28, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  rows: { gap: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  ghost: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 8, paddingBottom: 24 },
  choice: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 24, paddingVertical: 16 },
});
