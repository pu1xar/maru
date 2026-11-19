// The drawer's content, the web sidebar's list (SessionSidebar.tsx) top to bottom: the head (mark,
// connection, counts), the search row with its filter, the folders (Pinned, the Groups, Unsorted, Archive,
// each folded for every client) with their one-line session rows, and the foot (update pill, usage,
// settings). The folders and their order are the web's own pure `groupByProject`.
// A long press on a Group's header offers Move up and Move down (DESIGN.md 6w).
// The views menu has the Terminal group only (Dashboard and Split view have no screen on the phone,
// DESIGN.md 6s); the Group and session menus have no server route on the phone, so they are left out.
import { useMemo, useState } from "react";
import { Alert, SectionList, StyleSheet, View } from "react-native";
import { Text } from "./ui/Text.tsx";
import type { Project, SearchHit, SessionSummary, UsageSnapshot } from "@maru/shared";
import { groupByProject, isFilterActive, type ProviderFilter } from "../../../web/src/model.ts";
import type { Pairing } from "../lib/api.ts";
import type { ConnectionState } from "../lib/connection.ts";
import { activityCounts, groupMoves, headerBadges, listEmptyText, listIsEmpty, sidebarSections, usageRows, type SidebarSection } from "../lib/sidebarModel.ts";
import { usePalette } from "../theme.ts";
import { type } from "../typography.ts";
import { ConversationSearch, warmConversationSearch } from "./ConversationSearch.tsx";
import { Press } from "./Press.tsx";
import { FolderHeader } from "./sidebar/FolderHeader.tsx";
import { SearchRow, FilterMenu } from "./sidebar/SearchRow.tsx";
import { SessionRow } from "./sidebar/SessionRow.tsx";
import { SidebarFooter } from "./sidebar/SidebarFooter.tsx";
import { SidebarHeader } from "./sidebar/SidebarHeader.tsx";
import { TerminalGroup, type TerminalGroupProps } from "./sidebar/TerminalGroup.tsx";

export function SessionList(props: {
  sessions: ReadonlyMap<string, SessionSummary>;
  projects: readonly Project[];
  /** The first list has arrived from the server. */
  loaded: boolean;
  /** The folded folders' keys (the server's list, shared by every client) and the toggle of one. */
  folded: ReadonlySet<string>;
  onToggleFold: (foldKey: string) => void;
  /** Sets the Groups' order: every Group id, top first (a long press on a Group's header). */
  onReorderGroups: (ids: string[]) => void;
  usage: UsageSnapshot | null;
  selected: string | null;
  now: number;
  topInset: number;
  bottomInset: number;
  connection: ConnectionState;
  onSelect: (s: SessionSummary) => void;
  onNew: () => void;
  onSettings: () => void;
  /** The mark's action: no session selected. */
  onHome: () => void;
  /** The search over sessions' names and conversations (DESIGN.md 6u). */
  pairing: Pairing;
  /** A conversation hit: open its session and the find at the hit. */
  onOpenHit: (hit: SearchHit, session: SessionSummary, query: string) => void;
  /** The Terminal group under the search row (DESIGN.md 6s). */
  terminal: TerminalGroupProps;
}) {
  const p = usePalette();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<ProviderFilter>("all");
  const [activeOnly, setActiveOnly] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  // Where the filter menu hangs: under the search row, measured.
  const [searchBottom, setSearchBottom] = useState(0);
  const filter = useMemo(() => ({ query, provider, activeOnly }), [query, provider, activeOnly]);
  const searching = query.trim() !== "";

  const groups = useMemo(() => groupByProject(props.sessions.values(), props.projects, filter), [props.sessions, props.projects, filter]);
  const sections = useMemo(() => sidebarSections(groups, props.folded, searching), [groups, props.folded, searching]);
  const badges = useMemo(() => headerBadges(activityCounts(props.sessions.values())), [props.sessions]);
  const usage = useMemo(() => usageRows(props.usage, props.now), [props.usage, props.now]);
  // A long press on a Group's header: Move up / Move down, each offered only where it goes somewhere.
  const offerMoves = (project: Project) => {
    const { up, down } = groupMoves(props.projects, project.id);
    if (!up && !down) return;
    Alert.alert(project.name, undefined, [
      ...(up ? [{ text: "Move up", onPress: () => props.onReorderGroups(up) }] : []),
      ...(down ? [{ text: "Move down", onPress: () => props.onReorderGroups(down) }] : []),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };
  const emptyText = listIsEmpty(groups) ? listEmptyText(props.loaded, isFilterActive(filter)) : null;

  return (
    <View style={{ flex: 1 }}>
      <SidebarHeader connection={props.connection} badges={badges} topInset={props.topInset} onHome={props.onHome} />
      <View style={styles.search} onLayout={(e) => setSearchBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
        <SearchRow
          query={query}
          onQueryChange={setQuery}
          onFocus={() => warmConversationSearch(props.pairing)}
          provider={provider}
          activeOnly={activeOnly}
          filterOpen={filterOpen}
          onToggleFilter={() => setFilterOpen((o) => !o)}
          onNew={props.onNew}
        />
      </View>
      <View style={styles.views}>
        <TerminalGroup {...props.terminal} />
      </View>
      <SectionList<SessionSummary, SidebarSection>
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        sections={sections}
        keyExtractor={(s) => s.key}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={styles.list}
        renderSectionHeader={({ section }) => (
          <FolderHeader
            section={section}
            first={section.key === sections[0]?.key}
            onToggle={() => props.onToggleFold(section.foldKey)}
            onLongPress={section.group.project ? () => offerMoves(section.group.project!) : undefined}
          />
        )}
        renderItem={({ item, section }) => (
          <SessionRow s={item} groupKind={section.group.kind} selected={item.key === props.selected} onPress={() => props.onSelect(item)} />
        )}
        ItemSeparatorComponent={Gap}
        ListEmptyComponent={
          emptyText ? (
            <Text accessibilityRole="alert" style={[type.small, styles.empty, { color: p.muted }]}>
              {emptyText}
            </Text>
          ) : undefined
        }
        ListFooterComponent={<ConversationSearch pairing={props.pairing} query={query} onOpen={props.onOpenHit} />}
      />
      <SidebarFooter usage={usage} bottomInset={props.bottomInset} pairing={props.pairing} onSettings={props.onSettings} />
      {filterOpen ? (
        <>
          <Press style={StyleSheet.absoluteFill} onPress={() => setFilterOpen(false)} android_ripple={{ color: "transparent" }} accessibilityLabel="Close filter" />
          <View style={[styles.menuAnchor, { top: searchBottom + 4 }]}>
            <FilterMenu
              provider={provider}
              onProviderChange={setProvider}
              activeOnly={activeOnly}
              onActiveOnlyChange={setActiveOnly}
              onClose={() => setFilterOpen(false)}
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

/** One pixel between rows (the web list's gap-px). */
function Gap() {
  return <View style={{ height: 1 }} />;
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: 8, paddingTop: 4 },
  // The views menu under the search row (mt-1).
  views: { paddingHorizontal: 8 },
  list: { paddingHorizontal: 8, paddingTop: 8, paddingBottom: 8 },
  empty: { textAlign: "center", paddingHorizontal: 8, paddingVertical: 24 },
  menuAnchor: { position: "absolute", right: 12 },
});
