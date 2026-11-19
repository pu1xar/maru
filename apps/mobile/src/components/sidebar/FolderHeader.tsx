// A folder's head row (SessionSidebar.tsx ProjectFolderHeader): its icon (pin for Pinned, archive
// for Archive, a folder for a Group, a tray for Unsorted), name, the dot of what a folded folder
// hides, the count of a folded one and the chevron. A press folds or unfolds it for every client; a
// long press on a Group's header (`onLongPress`) offers its Move up and Move down.
import { createElement } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../ui/Text.tsx";
import { ArchiveIcon, ChevronDownIcon, FolderCodeIcon, InboxIcon, PinIcon, type LucideIcon } from "lucide-react-native";
import type { SessionGroup } from "../../../../web/src/model.ts";
import type { FolderDot } from "../../../../web/src/components/sessionActivity.logic.ts";
import type { SidebarSection } from "../../lib/sidebarModel.ts";
import { usePalette } from "../../theme.ts";
import { type } from "../../typography.ts";
import { Press } from "../Press.tsx";
import { useSidebarColors } from "./useSidebarColors.ts";

// The web's group header icons (SessionSidebar.tsx).
const FOLDER_ICON: Record<SessionGroup["kind"], LucideIcon> = {
  pinned: PinIcon,
  archive: ArchiveIcon,
  project: FolderCodeIcon,
  unassigned: InboxIcon,
};

export function FolderHeader(props: { section: SidebarSection; first: boolean; onToggle: () => void; onLongPress?: (() => void) | undefined }) {
  const p = usePalette();
  const sc = useSidebarColors();
  const { section } = props;
  const dotColor: Record<FolderDot, string> = { attention: sc.warning, failed: sc.error, working: sc.info };
  return (
    <View style={{ marginTop: props.first ? 0 : 8 }}>
      <Press
        onPress={props.onToggle}
        onLongPress={props.onLongPress}
        hitSlop={{ top: 6, bottom: 6 }}
        accessibilityRole="button"
        accessibilityState={{ expanded: !section.folded }}
        accessibilityLabel={`${section.group.label}${section.dotLabel}`}
        style={styles.head}
      >
        {createElement(FOLDER_ICON[section.group.kind], { size: 16, color: p.muted })}
        <Text style={[type.sidebar, styles.label, { color: p.text }]} numberOfLines={1}>
          {section.group.label}
        </Text>
        {section.dot ? <View style={[styles.dot, { backgroundColor: dotColor[section.dot] }]} /> : null}
        {section.showCount ? <Text style={[type.small, styles.count, { color: p.muted }]}>{section.group.sessions.length}</Text> : null}
        <ChevronDownIcon size={12} color={p.muted} style={section.folded ? styles.folded : undefined} />
      </Press>
    </View>
  );
}

const styles = StyleSheet.create({
  // h-8, gap-2.5, the row content inset of 10.
  head: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 32, paddingHorizontal: 10, borderRadius: 8 },
  // text-sm font-medium at 90% of the foreground.
  label: { flex: 1, minWidth: 0, fontWeight: "500", opacity: 0.9 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  count: { fontVariant: ["tabular-nums"] },
  folded: { transform: [{ rotate: "-90deg" }] },
});
