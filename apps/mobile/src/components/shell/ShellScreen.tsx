// The shell screen (DESIGN.md 6s; the web's components/shell/ShellScreen.tsx): a tab strip of every
// shell under the screen header's place, and the shown shell's terminal below it. The shells are
// the server's (the same ones the web lists) and belong to no session. Closing the screen keeps
// the shells running; a tab's X ends its shell, and ending the last one closes the screen. A
// phone shows one terminal at a time: the other tabs hold no WebView, and a tab shown again
// attaches and gets the scrollback and screen from tmux, so nothing is lost.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, BackHandler, ScrollView, StyleSheet, View } from "react-native";
import { PanelLeftIcon, PlusIcon, XIcon } from "lucide-react-native";
import type { ShellInfo } from "@maru/shared";
import { lastActiveShell, onActiveShellChange, pickActive, shellLabels } from "../../../../web/src/lib/shellTabs.ts";
import type { Pairing } from "../../lib/api.ts";
import { endShell, shellGone, showShell } from "../../shell/actions.ts";
import type { Shells } from "../../shell/useShells.ts";
import { useShellLook } from "../../shell/useShellLook.ts";
import { usePalette } from "../../theme.ts";
import { Press } from "../Press.tsx";
import { useSidebarColors } from "../sidebar/useSidebarColors.ts";
import { Btn } from "../ui/Btn.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { ErrorBox } from "../ui/Notices.tsx";
import { Text } from "../ui/Text.tsx";
import { ui } from "../ui/metrics.ts";
import { useChrome } from "../ui/useChrome.ts";
import { ShellView } from "./ShellView.tsx";

/** The strip's height (--workspace-topbar-height, 2.75rem). */
const BAR_HEIGHT = 44;

export function ShellScreen(props: {
  pairing: Pairing;
  shells: Shells;
  /** The folder of the session the screen covers; a new shell starts there. */
  sessionCwd: string | null;
  topInset: number;
  /** The gesture bar's height under the screen (zero while the keyboard is up). */
  bottomInset: number;
  /** Bumps when Settings closes, so a changed terminal size or color set shows. */
  lookKey: number;
  onOpenSidebar: () => void;
  /** The screen has nothing left to show (the last shell ended), or Back was pressed. */
  onClose: () => void;
}) {
  const { shells: list, creating, store } = props.shells;
  const p = usePalette();
  const sc = useSidebarColors();
  const look = useShellLook(props.lookKey);
  const [error, setError] = useState<string | null>(null);
  const activeId = useSyncExternalStore(onActiveShellChange, lastActiveShell, () => null);
  const active = pickActive(list ?? [], activeId);
  const autoCreated = useRef(false);
  const { onClose, sessionCwd } = props;

  // Back returns to the conversation the screen covers (the drawer's own Back handler runs first while it is open).
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const create = async () => {
    try {
      const shell = await store.create(sessionCwd);
      showShell(shell.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const createRef = useRef(create);
  createRef.current = create;

  // The first open with no shell makes one (the web does the same); it waits for the first read of the list.
  useEffect(() => {
    if (list === null || list.length > 0 || creating || autoCreated.current) return;
    autoCreated.current = true;
    void createRef.current();
  }, [list, creating]);

  const end = async (id: string) => {
    try {
      const { closeScreen } = await endShell(store, id);
      setError(null);
      if (closeScreen) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const gone = (id: string) => {
    if (shellGone(store, id).closeScreen) onClose();
  };

  const labels = shellLabels(list ?? []);
  const shell = active ? (list ?? []).find((s) => s.id === active) : undefined;
  return (
    <View style={styles.fill} testID="shell-screen">
      <View style={[styles.bar, { height: props.topInset + BAR_HEIGHT, paddingTop: props.topInset, backgroundColor: sc.bg, borderBottomColor: p.border }]}>
        <Press onPress={props.onOpenSidebar} hitSlop={8} accessibilityRole="button" accessibilityLabel="Session list" style={styles.trigger}>
          <PanelLeftIcon size={16} color={p.muted} />
        </Press>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" accessibilityLabel="Shells" style={styles.tabs} contentContainerStyle={styles.tabsContent}>
          {(list ?? []).map((s, i) => (
            <ShellTab key={s.id} shell={s} index={i} label={labels.get(s.id) ?? s.command} active={s.id === active} onSelect={() => showShell(s.id)} onEnd={() => void end(s.id)} />
          ))}
        </ScrollView>
        <Press
          onPress={() => void create()}
          disabled={creating}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="New shell"
          accessibilityState={{ disabled: creating, busy: creating }}
          style={styles.plus}
        >
          {creating ? <ActivityIndicator size="small" color={p.muted} /> : <PlusIcon size={20} color={p.muted} />}
        </Press>
      </View>
      <View style={[styles.fill, { backgroundColor: p.bg }]}>
        {error ? <ErrorBox message={error} /> : null}
        {list === null ? (
          <View style={styles.center}>
            <ActivityIndicator size="small" color={p.muted} />
          </View>
        ) : shell ? (
          <ShellView key={shell.id} pairing={props.pairing} shell={shell} look={look} bottomInset={props.bottomInset} onGone={(id) => gone(id)} />
        ) : creating ? (
          <View style={styles.center}>
            <ActivityIndicator size="small" color={p.muted} />
          </View>
        ) : (
          <EmptyState scale="ui" title="No shells">
            <Btn variant="outline" label="New shell" icon={<PlusIcon size={18} color={p.muted} />} onPress={() => void create()} />
          </EmptyState>
        )}
      </View>
    </View>
  );
}

/** One tab (web ShellTab): the position, the foreground command, and, on the shown tab, a button that ends the shell. */
function ShellTab(props: { shell: ShellInfo; index: number; label: string; active: boolean; onSelect: () => void; onEnd: () => void }) {
  const p = usePalette();
  const c = useChrome();
  const { label } = props;
  return (
    <View style={[styles.tab, { borderRightColor: p.border }, props.active ? { backgroundColor: p.bg, borderBottomColor: p.bg } : { borderBottomColor: p.border }]}>
      <Press
        onPress={props.onSelect}
        accessibilityRole="tab"
        accessibilityState={{ selected: props.active }}
        accessibilityLabel={label}
        android_ripple={{ color: c.accent }}
        style={styles.tabLabel}
      >
        <Text style={[ui.xs, styles.tabIndex, { color: p.muted }]}>{props.index + 1}</Text>
        <Text numberOfLines={1} style={[styles.tabText, { color: props.active ? p.text : p.muted }]}>
          {label}
        </Text>
      </Press>
      {props.active ? (
        <Press onPress={props.onEnd} hitSlop={4} accessibilityRole="button" accessibilityLabel={`End shell: ${label}`} style={styles.end}>
          <XIcon size={16} color={p.muted} />
        </Press>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  // The header's place: 44 under the status bar, the surface of the sidebar, a line under it.
  bar: { flexDirection: "row", alignItems: "stretch", borderBottomWidth: 1 },
  trigger: { width: 44, alignItems: "center", justifyContent: "center" },
  tabs: { flex: 1, minWidth: 0 },
  tabsContent: { alignItems: "stretch" },
  // The shown tab joins the terminal under it: it has no bottom line.
  tab: { flexDirection: "row", alignItems: "center", minWidth: 112, maxWidth: 192, paddingLeft: 12, paddingRight: 4, borderRightWidth: 1, borderBottomWidth: 1, marginBottom: -1 },
  tabLabel: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "stretch" },
  tabIndex: { fontVariant: ["tabular-nums"], opacity: 0.7 },
  // font-mono text-xs.
  tabText: { flexShrink: 1, fontFamily: "monospace", fontSize: 12, lineHeight: 16 },
  end: { width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: 4 },
  plus: { width: 44, alignItems: "center", justifyContent: "center" },
});
