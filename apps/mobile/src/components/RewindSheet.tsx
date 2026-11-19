// The rewind sheet (DESIGN.md 6o, 2d): the web RewindDialog's confirm step at phone width
// (components/ui/Sheet.tsx). It opens at the message the user pressed: the quoted message, the two
// effect lines (conversation, code), the options with the reason under each one that cannot run,
// the warning while the code can go back. The web runs an option the moment it is clicked; here a
// tap picks it and the footer's button runs it, because a finger on a destructive option is less
// exact than a pointer (this is the one difference from the dialog). The words and rules are the
// web's (lib/rewind.logic.ts); the state is lib/rewindFlow.ts.
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Text } from "./ui/Text.tsx";
import { CircleAlertIcon, TriangleAlertIcon } from "lucide-react-native";
import { ageText, choiceEffect, restoreFilesText, restoreShown, RESTORE_WARNING } from "../../../web/src/lib/rewind.logic.ts";
import { runnableMode, type RewindFlow } from "../lib/rewindFlow.ts";
import type { ChromeColors } from "../lib/chromeColors.ts";
import { usePalette, type Palette } from "../theme.ts";
import { Press } from "./Press.tsx";
import { Btn } from "./ui/Btn.tsx";
import { ui } from "./ui/metrics.ts";
import { Sheet } from "./ui/Sheet.tsx";
import { useChrome } from "./ui/useChrome.ts";

/** "+N -M", each part only when not zero (web Stats). */
function Stats({ c, insertions, deletions }: { c: ChromeColors; insertions: number; deletions: number }) {
  return (
    <Text style={{ fontVariant: ["tabular-nums"] }}>
      {insertions > 0 ? <Text style={{ color: c.successForeground }}>{`+${insertions}`}</Text> : null}
      {insertions > 0 && deletions > 0 ? " " : null}
      {deletions > 0 ? <Text style={{ color: c.errorForeground }}>{`-${deletions}`}</Text> : null}
    </Text>
  );
}

/** The two lines under the quoted message: whether the conversation goes back, and what happens to the code (web ConfirmStep). */
function Effects({ p, c, flow }: { p: Palette; c: ChromeColors; flow: RewindFlow }) {
  const t = flow.target!;
  const effect = choiceEffect(t, flow.choice ?? "nevermind", flow.options);
  const shown = restoreShown(t, flow.preview);
  const line = [ui.xs, { color: p.muted }] as const;
  return (
    <View style={{ gap: 2 }}>
      <Text style={line}>{effect.goesBack ? "The conversation goes back to before this message was sent" : "The conversation stays as it is"}</Text>
      {effect.code === "restore" && shown ? (
        shown.files.length === 0 ? (
          <Text style={line}>{shown.exact ? "No code changed, so there is nothing to restore" : "Could not find files edited after this message in the transcript (files are checked when rewinding)"}</Text>
        ) : shown.exact ? (
          <Text style={line}>
            {"Code is restored: "}
            <Stats c={c} insertions={shown.insertions} deletions={shown.deletions} />
            {` ${restoreFilesText(shown.files)}`}
          </Text>
        ) : (
          // No process to ask for the dry run: the files edited after the message, without counts.
          <Text style={line}>{`Files edited after this message are restored: ${restoreFilesText(shown.files)}`}</Text>
        )
      ) : effect.code === "unchanged" ? (
        <Text style={line}>Code stays as it is</Text>
      ) : null}
    </View>
  );
}

export function RewindSheet(props: { flow: RewindFlow; onClose: () => void; onChoose: (value: "both" | "conversation" | "code") => void; onRun: () => void }) {
  const p = usePalette();
  const c = useChrome();
  const { flow } = props;
  const mode = runnableMode(flow);
  const t = flow.target;
  const age = t ? ageText(t.createdAt, Date.now()) : null;
  const codeCanGoBack = flow.options.some((o) => (o.value === "both" || o.value === "code") && o.enabled);
  return (
    <Sheet
      open={flow.open}
      onClose={props.onClose}
      title="Rewind"
      description="Rewind to before this message was sent"
      headerExtra={
        <>
          {flow.list?.blocked ? (
            <View accessibilityRole="alert" style={[styles.blocked, { backgroundColor: c.warningNotice }]}>
              <CircleAlertIcon size={14} color={c.warningForeground} style={{ marginTop: 1 }} />
              <Text style={[ui.xs, { color: c.warningForeground, flex: 1 }]}>{flow.list.blocked}</Text>
            </View>
          ) : null}
          {flow.list?.codeNote ? <Text style={[ui.xs, { color: p.muted }]}>{flow.list.codeNote}</Text> : null}
        </>
      }
      footer={
        <>
          <Btn variant="outline" label="Cancel" fill disabled={flow.running !== null} onPress={props.onClose} />
          <Btn label="Rewind" fill busy={flow.running !== null} disabled={mode === null} onPress={props.onRun} />
        </>
      }
    >
      <View style={{ gap: 0, minHeight: 128 - 48 }}>
        {flow.error ? (
          <View accessibilityRole="alert" style={styles.error}>
            <CircleAlertIcon size={14} color={c.errorForeground} style={{ marginTop: 2 }} />
            <Text style={[ui.sm, { color: c.errorForeground, flex: 1 }]}>{flow.error}</Text>
          </View>
        ) : null}
        {flow.loading ? (
          <View style={styles.loading}>
            <ActivityIndicator size="small" color={p.muted} style={{ transform: [{ scale: 0.8 }] }} />
            <Text style={[ui.sm, { color: p.muted }]}>Reading messages</Text>
          </View>
        ) : null}
        {t ? (
          <View style={{ gap: 12 }}>
            <View style={[styles.quote, { borderLeftColor: p.border }]}>
              <Text numberOfLines={4} style={[ui.sm, { color: p.text }]}>{t.text}</Text>
              {age ? <Text style={[ui.xs, { color: p.muted }]}>{age}</Text> : null}
            </View>
            <Effects p={p} c={c} flow={flow} />
            <View accessibilityRole="radiogroup" style={{ gap: 4 }}>
              {flow.options.map((o) => {
                const on = o.value === flow.choice;
                return (
                  <Press
                    key={o.value}
                    onPress={() => props.onChoose(o.value as "both" | "conversation" | "code")}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on, disabled: !o.enabled }}
                    style={[styles.option, { borderColor: on ? p.border : "transparent", backgroundColor: on ? c.accent : "transparent" }]}
                  >
                    <Text style={[ui.sm, { color: o.enabled ? p.text : p.muted, fontWeight: "500" }]}>{o.label}</Text>
                    {o.reason ? <Text style={[ui.xs, { color: p.muted }]}>{o.reason}</Text> : null}
                  </Press>
                );
              })}
            </View>
            {codeCanGoBack ? (
              <View style={styles.warning}>
                <TriangleAlertIcon size={12} color={c.warningForeground} style={{ marginTop: 1 }} />
                <Text style={[ui.xs, { color: p.muted, flex: 1 }]}>{RESTORE_WARNING}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // rounded-lg px-3 py-2 gap-1.5, text-xs.
  blocked: { flexDirection: "row", alignItems: "flex-start", gap: 6, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  error: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginBottom: 8 },
  // px-2 py-3 gap-2.
  loading: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingVertical: 12 },
  // border-s-2 border-border ps-3.
  quote: { borderLeftWidth: 2, paddingLeft: 12 },
  // rounded-lg border px-3 py-2.
  option: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, overflow: "hidden" },
  warning: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
});
