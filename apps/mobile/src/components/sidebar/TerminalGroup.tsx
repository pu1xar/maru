// The drawer's Terminal group (SessionSidebar.tsx TerminalGroup and ShellRow, DESIGN.md 6s), under
// the search row where the web's views menu has it: a head row "Terminal" that opens and closes the
// shell screen, a "+" that makes a shell, and a chevron that folds the list (the fold is kept with
// the folders' folds, under the key `view:terminal`, so the web's fold and the phone's are one);
// then one row per shell, named as the screen's tabs are, each with a "..." menu to end it. The web's
// drag onto a split view pane and "Open in split view" have no phone counterpart (no split view).
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../ui/Text.tsx";
import { ChevronDownIcon, MoreHorizontalIcon, PlusIcon, SquareTerminalIcon, TerminalIcon, XIcon } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ShellInfo } from "@maru/shared";
import { shellLabels } from "../../../../web/src/lib/shellTabs.ts";
import { usePalette } from "../../theme.ts";
import { type } from "../../typography.ts";
import { Press } from "../Press.tsx";
import { ui } from "../ui/metrics.ts";
import { useChrome } from "../ui/useChrome.ts";
import { useSidebarColors } from "./useSidebarColors.ts";

/** The list scrolls inside the group past this height (the web's max-h-48), so the session list below keeps its room. */
const LIST_MAX_HEIGHT = 192;

export interface TerminalGroupProps {
  /** Every shell the server has; null before the first read. */
  shells: readonly ShellInfo[] | null;
  /** The shell screen is showing. */
  screenOpen: boolean;
  /** The shell the screen shows (a row is selected only while the screen shows). */
  shown: string | null;
  folded: boolean;
  onToggleFold: () => void;
  /** The head: open the screen, or close it when it is open. */
  onToggleScreen: () => void;
  /** The "+": open the screen with a new shell. */
  onNewShell: () => void;
  onSelect: (id: string) => void;
  onEnd: (id: string) => void;
}

export function TerminalGroup(props: TerminalGroupProps) {
  const p = usePalette();
  const sc = useSidebarColors();
  const shells = props.shells ?? [];
  const labels = shellLabels(shells);
  const [menu, setMenu] = useState<string | null>(null);
  const menuShell = menu ? shells.find((s) => s.id === menu) : undefined;
  return (
    <View style={styles.group}>
      <View style={[styles.head, props.screenOpen ? { backgroundColor: sc.rowActive } : null, props.screenOpen && sc.rowActiveRing ? { borderWidth: 1, borderColor: sc.rowActiveRing } : null]}>
        <Press
          onPress={props.onToggleScreen}
          accessibilityRole="button"
          accessibilityState={{ selected: props.screenOpen }}
          accessibilityLabel="Terminal"
          style={styles.headMain}
        >
          <SquareTerminalIcon size={16} color={p.muted} />
          <Text style={[type.sidebar, styles.headLabel, { color: p.text }]} numberOfLines={1}>
            Terminal
          </Text>
        </Press>
        {props.folded && shells.length > 0 ? <Text style={[type.small, styles.count, { color: p.muted }]}>{shells.length}</Text> : null}
        <Press onPress={props.onNewShell} hitSlop={6} accessibilityRole="button" accessibilityLabel="New shell" style={styles.iconButton}>
          <PlusIcon size={18} color={p.muted} />
        </Press>
        <Press
          onPress={props.onToggleFold}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityState={{ expanded: !props.folded }}
          accessibilityLabel={props.folded ? "Expand terminal list" : "Collapse terminal list"}
          style={styles.iconButton}
        >
          <ChevronDownIcon size={12} color={p.muted} style={props.folded ? styles.folded : undefined} />
        </Press>
      </View>
      {props.folded || shells.length === 0 ? null : (
        <ScrollView nestedScrollEnabled style={{ maxHeight: LIST_MAX_HEIGHT }} accessibilityLabel="Shells" keyboardShouldPersistTaps="handled">
          {shells.map((s) => {
            const label = labels.get(s.id) ?? s.command;
            const selected = props.screenOpen && props.shown === s.id;
            return (
              <View key={s.id} style={[styles.row, selected ? { backgroundColor: sc.rowActive } : null, selected && sc.rowActiveRing ? { borderWidth: 1, borderColor: sc.rowActiveRing } : null]}>
                <Press
                  onPress={() => props.onSelect(s.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={label}
                  style={styles.rowMain}
                >
                  <TerminalIcon size={14} color={p.muted} />
                  <Text style={[type.sidebar, styles.rowLabel, { color: p.text }]} numberOfLines={1}>
                    {label}
                  </Text>
                </Press>
                <Press onPress={() => setMenu(s.id)} hitSlop={6} accessibilityRole="button" accessibilityLabel={`${label} menu`} style={styles.iconButton}>
                  <MoreHorizontalIcon size={16} color={p.muted} />
                </Press>
              </View>
            );
          })}
        </ScrollView>
      )}
      <ShellMenuSheet
        shell={menuShell ?? null}
        label={menuShell ? (labels.get(menuShell.id) ?? menuShell.command) : ""}
        onClose={() => setMenu(null)}
        onEnd={(id) => {
          setMenu(null);
          props.onEnd(id);
        }}
      />
    </View>
  );
}

/**
 * The row's menu (the web's ShellActionMenu), as a bottom sheet because a phone has no anchor to open
 * a menu at. Its one item ends the shell, with no confirmation, as the web's does. The shell's
 * current folder heads it as a menu group label does.
 */
function ShellMenuSheet(props: { shell: ShellInfo | null; label: string; onClose: () => void; onEnd: (id: string) => void }) {
  const p = usePalette();
  const c = useChrome();
  const insets = useSafeAreaInsets();
  const { shell } = props;
  return (
    <Modal visible={shell !== null} animationType="slide" transparent onRequestClose={props.onClose}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: c.backdrop }]} onPress={props.onClose} accessibilityLabel="Close" />
      <View style={styles.sheetWrap} pointerEvents="box-none">
        <View style={[styles.sheet, { backgroundColor: p.bg, borderTopColor: c.sheetBorder, paddingBottom: 4 + insets.bottom }]}>
          {shell ? (
            <Text numberOfLines={2} style={[ui.xs, { color: p.muted, fontWeight: "500", paddingHorizontal: 8, paddingVertical: 6 }]}>
              {`${props.label}\n${shell.path}`}
            </Text>
          ) : null}
          <Press
            onPress={() => shell && props.onEnd(shell.id)}
            accessibilityRole="button"
            accessibilityLabel="End shell"
            android_ripple={{ color: c.accent, foreground: true }}
            style={styles.item}
          >
            <XIcon size={18} color={c.errorForeground} style={{ opacity: 0.8 }} />
            <Text style={[ui.base, { color: c.errorForeground, flex: 1 }]}>End shell</Text>
          </Press>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  group: { marginTop: 4 },
  // h-8, gap-2.5, the row content inset of 10 (a view row of the web's views menu).
  head: { flexDirection: "row", alignItems: "center", minHeight: 32, borderRadius: 8, paddingRight: 4 },
  headMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10, minHeight: 32, paddingLeft: 10 },
  headLabel: { flex: 1, minWidth: 0, fontWeight: "500", opacity: 0.9 },
  count: { fontVariant: ["tabular-nums"], paddingHorizontal: 4 },
  iconButton: { width: 28, height: 28, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  folded: { transform: [{ rotate: "-90deg" }] },
  // The shell rows are a session row's shape (h-8, ps-9 so the mark starts in the head label's column).
  row: { flexDirection: "row", alignItems: "center", minHeight: 32, borderRadius: 6, paddingRight: 4, marginTop: 1 },
  rowMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10, minHeight: 32, paddingLeft: 36 },
  rowLabel: { flex: 1, minWidth: 0, fontWeight: "500" },
  sheetWrap: { flex: 1, justifyContent: "flex-end" },
  sheet: { borderTopWidth: 1, padding: 4 },
  item: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, overflow: "hidden" },
});
