// The main screen's header, the web's conversation header (ThreadView + PaneHeader,
// SessionMetaLine) at phone width: 44 high (--workspace-topbar-height) under the status bar, no
// bottom edge (border-border) in every state. The sidebar trigger (a 28 ghost button with the
// PanelLeft icon) sits at the left; then the provider mark, a column of the breadcrumb (Group, "/",
// the title in font-medium; a subagent's transcript shows the session's title as a link before its
// own) over the meta line (account, working folder), and at the right the session's state icons first,
// then the view toggle and the find button (the web's SessionStateIcons, ViewModeToggle order).
// Parts fold by the header's width as the web's container queries do: the provider mark under 21rem,
// the Group under 24rem, the holder chip (the state icons take the terminal mark then) under 36rem.
// The find button is the app's own: the web opens its find with a keyboard shortcut.
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { Text } from "./ui/Text.tsx";
import { FolderIcon, PanelLeftIcon, SearchIcon, TerminalIcon, UserRoundIcon } from "lucide-react-native";
import type { SessionSummary } from "@maru/shared";
import { shortAccount, shortPath } from "../../../web/src/model.ts";
import { ACTIVITY_LABEL, sessionActivity } from "../../../web/src/components/sessionActivity.logic.ts";
import { metaOwner } from "../../../web/src/lib/sessionMeta.ts";
import type { ViewMode } from "../../../web/src/lib/viewMode.logic.ts";
import { sessionMark } from "../lib/sessionMark.ts";
import { ViewModeToggle } from "./terminal/ViewModeToggle.tsx";
import { usePalette } from "../theme.ts";
import { ActivityMark } from "./sidebar/ActivityMark.tsx";
import { MaruMark } from "./sidebar/MaruMark.tsx";
import { ProviderIcon } from "./sidebar/ProviderIcon.tsx";
import { Press } from "./Press.tsx";
import { ui } from "./ui/metrics.ts";
import { useChrome } from "./ui/useChrome.ts";

/** --workspace-topbar-height, 2.75rem. */
export const HEADER_HEIGHT = 44;
/** The web's container widths (rem at 16): the provider mark and the holder chip fold below these. */
const MARK_MIN = 21 * 16;
const OWNER_MIN = 36 * 16;

export function ScreenHeader(props: {
  topInset: number;
  /** The conversation's title; null with no session open. */
  title: string | null;
  /** The text of a header with no conversation ("No open session"). */
  idleLabel: string;
  /** In a subagent's transcript, the session it belongs to, as a link before the title. */
  root: { title: string; onOpen: () => void } | null;
  /** The listed session the header describes (the subagent's parent in a transcript). */
  session: SessionSummary | null;
  canFind: boolean;
  findOpen: boolean;
  onFind: () => void;
  onOpenSidebar: () => void;
  /** Chat | Terminal for the open conversation (DESIGN.md 6i); null where there is none to switch. */
  viewMode?: { mode: ViewMode; onChange: (mode: ViewMode) => void } | null;
}) {
  const p = usePalette();
  const c = useChrome();
  const { width } = useWindowDimensions();
  const { session } = props;
  const showTitle = props.title !== null;
  return (
    <View
      style={[
        styles.header,
        { height: props.topInset + HEADER_HEIGHT, paddingTop: props.topInset },
        // The web fades the timeline out under a conversation's header because the window frame already sets
        // it off; a phone has no frame (the status bar shares the canvas color), so the edge stays (border-border).
        { borderBottomWidth: 1, borderBottomColor: p.border },
      ]}
    >
      <Press
        onPress={props.onOpenSidebar}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Session list"
        android_ripple={{ color: c.accent, borderless: true, radius: 20 }}
        style={styles.trigger}
      >
        <PanelLeftIcon size={16} color={p.muted} />
      </Press>
      {session && width >= MARK_MIN ? <ProviderIcon provider={session.provider} size={16} /> : null}
      <View style={styles.column}>
        {showTitle ? (
          <View accessibilityRole="header" style={styles.crumbs}>
            {props.root ? (
              <>
                <Press onPress={props.root.onOpen} accessibilityLabel={`Open parent conversation: ${props.root.title}`} hitSlop={8} style={{ maxWidth: "30%", flexShrink: 1 }}>
                  <Text style={[ui.sm, styles.crumb, { color: p.muted }]} numberOfLines={1}>{props.root.title}</Text>
                </Press>
                <Text style={[ui.sm, styles.crumb, { color: p.muted }]}>/</Text>
              </>
            ) : null}
            <Text style={[ui.sm, styles.crumb, { color: p.text, flex: 1, minWidth: 40 }]} numberOfLines={1}>{props.title}</Text>
          </View>
        ) : (
          <Text style={[ui.sm, styles.crumb, { color: p.text }]} numberOfLines={1}>{props.idleLabel}</Text>
        )}
        {showTitle && session ? <MetaLine session={session} wide={width >= OWNER_MIN} /> : null}
      </View>
      {session ? <StateIcons session={session} wide={width >= OWNER_MIN} /> : null}
      {props.viewMode ? <ViewModeToggle mode={props.viewMode.mode} onChange={props.viewMode.onChange} /> : null}
      {props.canFind ? (
        <Press
          onPress={props.onFind}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Find in conversation"
          accessibilityState={{ selected: props.findOpen }}
          android_ripple={{ color: c.accent, borderless: true, radius: 20 }}
          style={[styles.trigger, props.findOpen ? { backgroundColor: c.accent } : null]}
        >
          <SearchIcon size={16} color={p.muted} />
        </Press>
      ) : null}
    </View>
  );
}

/** The meta line: small icon and value chips of h-5 with px-1, 8 apart, the first pulled 4 left to line up with the title. */
function MetaLine({ session, wide }: { session: SessionSummary; wide: boolean }) {
  const p = usePalette();
  const owner = metaOwner(session);
  return (
    <View style={styles.meta}>
      <View style={[styles.chip, { flexShrink: 0 }]}>
        <UserRoundIcon size={12} color={p.muted} />
        <Text style={[ui.xs, { color: p.muted, flexShrink: 1 }]} numberOfLines={1}>{shortAccount(session.account)}</Text>
      </View>
      <View style={[styles.chip, { flexShrink: 1 }]}>
        <FolderIcon size={12} color={p.muted} />
        <Text style={[ui.xs, { color: p.muted, flexShrink: 1 }]} numberOfLines={1} ellipsizeMode="head">{shortPath(session.cwd)}</Text>
      </View>
      {owner && wide ? (
        <View style={[styles.chip, { flexShrink: 0 }]} accessibilityLabel={owner}>
          {owner === "maru" ? <MaruMark size={12} color={p.muted} /> : <TerminalIcon size={12} color={p.muted} />}
          <Text style={[ui.xs, { color: p.muted }]}>{owner}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** The state as the sidebar row shows it: the terminal mark while a terminal holds it (only where the holder chip is folded away), the running, waiting or failed icon. */
function StateIcons({ session, wide }: { session: SessionSummary; wide: boolean }) {
  const p = usePalette();
  const mark = sessionMark(session);
  const terminalHeld = session.owner === "terminal" && session.status !== "closed" && !wide;
  if (!mark && !terminalHeld) return null;
  const label = [terminalHeld ? "Open in terminal" : null, mark ? ACTIVITY_LABEL[sessionActivity(session)] : null].filter((x) => x !== null).join(", ");
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={styles.state}>
      {terminalHeld ? <TerminalIcon size={14} color={p.muted} /> : null}
      {mark ? <ActivityMark mark={mark} size={14} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // gap-3 between the parts, the left 13 of the floating trigger (controls-left 12 and ml-px), the right gutter 12.
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 13, paddingRight: 12 },
  // size-[--workspace-titlebar-control-size] (1.75rem), ghost.
  trigger: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center", marginRight: -1 },
  column: { flex: 1, minWidth: 0, justifyContent: "center" },
  crumbs: { flexDirection: "row", alignItems: "center", gap: 8 },
  crumb: { fontWeight: "500" },
  // marginTop -4: pulled up toward the title as the web meta line (-mt-1), the sizes unchanged.
  meta: { flexDirection: "row", alignItems: "center", gap: 8, marginStart: -4, marginTop: -4 },
  chip: { height: 20, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 4 },
  state: { flexDirection: "row", alignItems: "center", gap: 6 },
});
