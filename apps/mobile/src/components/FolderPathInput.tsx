// A working folder typed as a path (DESIGN.md 6z), the web's FolderPathField.tsx for a phone: type
// `~/projects/` and the subfolders list right below; a tap on a row goes one folder in, and the
// Complete button fills in what Tab does on the web (the folders' shared start, or the one folder
// that matches). A path is taken only when the server reads it as a folder; why not is shown under
// the field. The folders come from `GET /api/fs-complete` (names only). What a typed text means is
// the web's own pure code (web/src/lib/folderInput.ts), so both clients behave alike. The web's
// Finder button has no counterpart here: that dialog opens on the Mac's screen.
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { CheckIcon, FolderIcon } from "lucide-react-native";

import { folderName } from "../../../web/src/lib/sessionMeta.ts";
import { folderFieldView, readFolders, tabComplete, withEntry, type FolderLookup } from "../../../web/src/lib/folderInput.ts";
import { shortPath } from "../../../web/src/model.ts";
import type { Pairing } from "../lib/api.ts";
import { fetchFolders } from "../lib/manageApi.ts";
import { usePalette } from "../theme.ts";
import { Press } from "./Press.tsx";
import { Btn } from "./ui/Btn.tsx";
import { TextField } from "./ui/Fields.tsx";
import { Text } from "./ui/Text.tsx";
import { ui } from "./ui/metrics.ts";
import { useChrome } from "./ui/useChrome.ts";

/** How long typing pauses before the folders are read (the web field's pause). */
const TYPING_PAUSE_MS = 130;

export function FolderPathInput(props: {
  pairing: Pairing;
  value: string;
  onValueChange: (value: string) => void;
  /** Absolute paths listed while the field is empty. */
  recent: readonly string[];
  /** The folder the text names (absolute, `~` resolved) once the server read it as a folder; null otherwise. */
  onResolved: (path: string | null) => void;
  /** A reason this folder is not wanted though it exists (the session's own folder, say). */
  reject?: (path: string) => string | null;
  editable?: boolean;
  autoFocus?: boolean;
}) {
  const p = usePalette();
  const c = useChrome();
  const { pairing, value, onValueChange, onResolved } = props;
  const [lookup, setLookup] = useState<FolderLookup | null>(null);
  const view = folderFieldView(value, lookup, props.recent, props.reject);
  const { kind, fresh, resolvedPath, rows, rowBase } = view;

  // Reads the folders a pause after the last key.
  useEffect(() => {
    if (kind !== "path") return;
    let live = true;
    const timer = setTimeout(() => {
      readFolders(value, (q) => fetchFolders(pairing, q)).then(
        (r) => live && setLookup({ key: value, list: r.list, check: r.check, error: null }),
        (e: unknown) => live && setLookup({ key: value, list: null, check: null, error: e instanceof Error ? e.message : String(e) }),
      );
    }, TYPING_PAUSE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [kind, value, pairing]);

  useEffect(() => {
    onResolved(resolvedPath);
  }, [resolvedPath, onResolved]);

  /** The text a row stands for: a recent folder as typed `~/...`, a subfolder after the text it was listed for. */
  const rowText = (dir: string): string => (kind === "empty" ? shortPath(dir) : withEntry(rowBase, dir));
  // What the Complete button fills in, from the answer for exactly this text.
  const completed = kind === "path" && fresh?.list ? tabComplete(value, fresh.list.dirs, -1) : null;
  const readError = fresh === null && lookup?.key === value ? lookup?.error : null;

  return (
    <View style={{ gap: 6 }}>
      <TextField
        mono
        value={value}
        onChangeText={onValueChange}
        autoFocus={props.autoFocus}
        editable={props.editable !== false}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="done"
        placeholder="~/projects/..."
        accessibilityLabel="Working folder"
      />
      {rows.length > 0 ? (
        <View style={[styles.list, { backgroundColor: p.surface, borderColor: p.border }]}>
          <ScrollView style={{ maxHeight: 208 }} contentContainerStyle={{ padding: 4 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {kind === "empty" ? <Text style={[ui.xs, { color: p.muted, paddingHorizontal: 8, paddingTop: 4, paddingBottom: 2 }]}>Recent folders</Text> : null}
            {rows.map((dir) => (
              <Press
                key={dir}
                onPress={() => onValueChange(`${rowText(dir)}/`)}
                disabled={props.editable === false}
                accessibilityRole="button"
                accessibilityLabel={`Open ${folderName(dir)}`}
                style={styles.folder}
              >
                <FolderIcon size={14} color={p.muted} />
                <Text
                  numberOfLines={1}
                  ellipsizeMode="middle"
                  style={[ui.xs, { color: p.text, fontFamily: "monospace", flex: 1 }]}
                >
                  {kind === "empty" ? shortPath(dir) : folderName(dir)}
                </Text>
              </Press>
            ))}
          </ScrollView>
        </View>
      ) : null}
      <View style={styles.status}>
        <View style={styles.statusText}>
          {kind === "empty" ? (
            <Text style={[ui.xs, { color: p.muted }]}>Enter a path starting with ~ or /, or pick a recent folder</Text>
          ) : readError ? (
            <Text style={[ui.xs, { color: c.errorForeground }]}>{readError}</Text>
          ) : view.reason ? (
            <Text style={[ui.xs, { color: rows.length > 0 ? p.muted : c.errorForeground }]}>{view.reason}</Text>
          ) : resolvedPath ? (
            <>
              <CheckIcon size={12} color={c.successForeground} />
              <Text numberOfLines={1} ellipsizeMode="head" style={[ui.xs, { color: p.muted, fontFamily: "monospace", flex: 1 }]}>{resolvedPath}</Text>
            </>
          ) : view.checking ? (
            <>
              <ActivityIndicator size="small" color={p.muted} />
              <Text style={[ui.xs, { color: p.muted }]}>Reading folder</Text>
            </>
          ) : null}
        </View>
        {completed !== null ? <Btn size="xs" variant="outline" label="Complete" onPress={() => onValueChange(completed)} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { borderWidth: 1, borderRadius: 6, overflow: "hidden" },
  folder: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, overflow: "hidden" },
  status: { minHeight: 28, flexDirection: "row", alignItems: "center", gap: 8 },
  statusText: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 },
});
