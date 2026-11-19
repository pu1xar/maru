// Messages sent to the session that the model has not taken in yet, under the last turn (DESIGN.md
// 4.4), as the web's QueuedMessages draws them: the user's bubble faded with a dashed edge (its fill
// at 60%, the whole bubble at 70% while it waits). Left of it, icons only (no state icon: a failed message turns the bubble red and a tap on it says
// why, user request 2026-11-18): Take back as an X for a message that can still go back into the input (its attachments too, DESIGN.md
// 6n; a failed message leaves the list this way), and Send now as the curved arrow for a message the CLI holds (as the web's, DESIGN.md 4.4).
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Text } from "./ui/Text.tsx";
import { FileIcon, ImageOffIcon, Undo2Icon, XIcon } from "lucide-react-native";
import { withAlpha, type PendingSend } from "@maru/shared";
import { queuedStateLabel } from "../../../web/src/lib/queuedMessages.logic.ts";
import { scaleAlpha } from "../lib/composerColors.ts";
import { addToast } from "../lib/toast.ts";
import { usePalette } from "../theme.ts";
import { type } from "../typography.ts";
import { Press } from "./Press.tsx";

/** The conversation lane's side padding (the sent bubbles' column, components/timeline/TimelineRowView.tsx). */
const LANE = 12;
/** web text-sm without leading-relaxed (the queued bubble sets none): 15pt at 1.43. */
const BUBBLE_TEXT = { fontSize: type.body.fontSize, lineHeight: 21 } as const;

export function QueuedRows(props: {
  sends: readonly PendingSend[];
  busy: ReadonlySet<string>;
  /** Send now for the waiting messages; null where the session cannot (web canSendNow). */
  sendNow: { busy: boolean; onSend: () => void } | null;
  onRecall: (id: string) => void;
}) {
  const p = usePalette();
  if (props.sends.length === 0) return null;
  return (
    <View style={styles.list} accessibilityLabel={`Queued messages: ${props.sends.length}`}>
      {props.sends.map((s) => {
        const busy = props.busy.has(s.id);
        const failed = s.state === "failed";
        return (
          <View key={s.id} style={styles.row}>
            {/* A message the model took has no controls: its conversation row replaces the bubble. */}
            {s.state === "taken" ? null : (
              <View style={styles.meta}>
                {props.sendNow && s.state === "queued" ? (
                  <Press
                    onPress={props.sendNow.onSend}
                    disabled={props.sendNow.busy}
                    hitSlop={8}
                    accessibilityLabel="Send now"
                    style={[styles.iconButton, props.sendNow.busy ? styles.dim : null]}
                  >
                    {props.sendNow.busy ? <ActivityIndicator size="small" color={p.muted} style={styles.spinnerIcon} /> : <Undo2Icon size={16} color={p.muted} />}
                  </Press>
                ) : null}
                <Press
                  onPress={() => props.onRecall(s.id)}
                  disabled={!s.recall.enabled || busy}
                  hitSlop={6}
                  accessibilityLabel="Move back to input"
                  style={[styles.iconButton, !s.recall.enabled || busy ? styles.dim : null]}
                >
                  {busy ? <ActivityIndicator size="small" color={p.muted} style={styles.spinnerIcon} /> : <XIcon size={16} color={p.muted} />}
                </Press>
              </View>
            )}
            {/* Dashed and faded: a message the model has not read yet. A failed one turns red at full strength.
                A tap takes it back into the input (user request 2026-11-18), as the X does; a long press on a failed one says why. */}
            <Press
              onPress={s.state !== "taken" && s.recall.enabled && !busy ? () => props.onRecall(s.id) : undefined}
              onLongPress={failed ? () => addToast({ type: "error", title: queuedStateLabel(s), description: s.error }) : undefined}
              disabled={s.state === "taken" || (!s.recall.enabled && !failed) || busy}
              accessibilityLabel={failed ? `${queuedStateLabel(s)}${s.error ? `: ${s.error}` : ""}` : "Queued message"}
              accessibilityHint={s.recall.enabled ? "Moves the message back to the input" : undefined}
              style={[
                styles.bubble,
                {
                  backgroundColor: failed ? withAlpha(p.danger, 0.2) : scaleAlpha(p.userBubble, 0.6),
                  borderColor: failed ? withAlpha(p.danger, 0.6) : withAlpha(p.text, 0.25),
                  opacity: failed ? 1 : 0.7,
                },
              ]}
            >
              {s.attachments.length > 0 ? (
                <View style={[styles.files, s.text.trim() === "" ? null : { marginBottom: 8 }]}>
                  {s.attachments.map((a) => (
                    <View key={a.id} style={styles.file}>
                      {a.kind === "image" ? <ImageOffIcon size={16} color={p.muted} /> : <FileIcon size={16} color={p.muted} />}
                      <Text style={[BUBBLE_TEXT, { color: p.text, flex: 1 }]} numberOfLines={1}>{a.name}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              {s.text ? <Text style={[BUBBLE_TEXT, { color: p.text }]}>{s.text}</Text> : null}
            </Press>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // web: section pt-2 pb-2, the items gap-3 and right-aligned
  list: { gap: 12, paddingTop: 8, paddingBottom: 8 },
  // web: li flex items-center justify-end gap-1 (the icons left of the bubble)
  row: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", paddingHorizontal: LANE, gap: 4 },
  bubble: { maxWidth: "80%", flexShrink: 1, borderRadius: 16, borderWidth: 1, borderStyle: "dashed", padding: 12 },
  files: { gap: 4 },
  file: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  // web: flex shrink-0 items-center gap-0.5
  meta: { flexDirection: "row", alignItems: "center", gap: 2 },
  spinnerIcon: { width: 16, height: 16, transform: [{ scale: 0.8 }] },
  // web: Button size icon-xs (size-7 below the sm width), ghost-muted; hitSlop brings the touch area to 44dp (28 + 2 x 8)
  iconButton: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  // web: disabled:opacity-64
  dim: { opacity: 0.64 },
});
