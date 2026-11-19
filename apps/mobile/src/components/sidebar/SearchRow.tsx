// The search and filter row under the head (SessionSidebar.tsx SidebarSessionHeader): a search field
// that is bare text and an icon until focused, the filter button (the provider's mark while one is
// chosen, a dot while only open sessions show) and the add button. The web's add menu holds a new
// session, an existing session onto the list and a new Group; the phone has the first only, so its
// button starts a new session.
import { useState } from "react";
import { StyleSheet, Switch, View } from "react-native";
import { Text, TextInput } from "../ui/Text.tsx";
import { CheckIcon, FunnelIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react-native";
import type { ProviderFilter } from "../../../../web/src/model.ts";
import { filterLabel } from "../../lib/sidebarModel.ts";
import { usePalette } from "../../theme.ts";
import { type } from "../../typography.ts";
import { Press } from "../Press.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { useSidebarColors } from "./useSidebarColors.ts";

/** Icon buttons are 28 (size-7) to the eye; the press reaches 44 (hitSlop). */
const BUTTON = 28;
const BUTTON_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;

export function SearchRow(props: {
  query: string;
  onQueryChange: (q: string) => void;
  onFocus: () => void;
  provider: ProviderFilter;
  activeOnly: boolean;
  filterOpen: boolean;
  onToggleFilter: () => void;
  onNew: () => void;
}) {
  const p = usePalette();
  const sc = useSidebarColors();
  const [focused, setFocused] = useState(false);
  const filtered = props.provider !== "all" || props.activeOnly;
  return (
    <View style={styles.row}>
      <View style={[styles.field, focused ? { backgroundColor: sc.rowActive } : null]}>
        <SearchIcon size={16} color={p.muted} />
        <TextInput
          value={props.query}
          onChangeText={props.onQueryChange}
          onFocus={() => {
            setFocused(true);
            props.onFocus();
          }}
          onBlur={() => setFocused(false)}
          placeholder="Search"
          placeholderTextColor={p.muted}
          accessibilityLabel="Search sessions and conversations"
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, type.sidebar, { color: p.text, fontWeight: "500" }]}
        />
        {props.query ? (
          <Press onPress={() => props.onQueryChange("")} hitSlop={10} accessibilityLabel="Clear search">
            <XIcon size={14} color={p.muted} />
          </Press>
        ) : null}
      </View>
      <Press
        onPress={props.onToggleFilter}
        hitSlop={BUTTON_SLOP}
        accessibilityLabel={filterLabel(props.provider, props.activeOnly)}
        accessibilityState={{ expanded: props.filterOpen }}
        style={[styles.button, filtered || props.filterOpen ? { backgroundColor: sc.rowActive } : null]}
      >
        {props.provider === "all" ? <FunnelIcon size={16} color={p.muted} /> : <ProviderIcon provider={props.provider} size={16} />}
        {props.activeOnly ? <View style={[styles.activeDot, { backgroundColor: p.ok }]} /> : null}
      </Press>
      <Press onPress={props.onNew} hitSlop={BUTTON_SLOP} accessibilityLabel="New session" style={styles.button}>
        <PlusIcon size={18} color={p.muted} />
      </Press>
    </View>
  );
}

/** The filter's menu (MenuPopup min-w-48): Provider as a radio group, then the open-only switch. */
export function FilterMenu(props: {
  provider: ProviderFilter;
  onProviderChange: (p: ProviderFilter) => void;
  activeOnly: boolean;
  onActiveOnlyChange: (v: boolean) => void;
  onClose: () => void;
}) {
  const p = usePalette();
  const items: { value: ProviderFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "claude", label: "Claude" },
    { value: "codex", label: "Codex" },
  ];
  return (
    <View accessibilityRole="menu" style={[styles.menu, { backgroundColor: p.surface, borderColor: p.border }]}>
      <Text style={[type.small, styles.menuLabel, { color: p.muted }]}>Provider</Text>
      {items.map((it) => (
        <Press
          key={it.value}
          accessibilityRole="radio"
          accessibilityState={{ checked: props.provider === it.value }}
          onPress={() => {
            props.onProviderChange(it.value);
            props.onClose();
          }}
          style={styles.menuItem}
        >
          <View style={styles.slot}>{it.value === "all" ? null : <ProviderIcon provider={it.value} size={14} />}</View>
          <Text style={[type.sidebar, { color: p.text, flex: 1 }]}>{it.label}</Text>
          {props.provider === it.value ? <CheckIcon size={16} color={p.text} /> : null}
        </Press>
      ))}
      <View style={[styles.separator, { backgroundColor: p.border }]} />
      <View style={styles.menuItem}>
        <Text style={[type.sidebar, { color: p.text, flex: 1, marginStart: 24 }]}>Open sessions only</Text>
        <Switch
          value={props.activeOnly}
          onValueChange={props.onActiveOnlyChange}
          trackColor={{ true: p.accent, false: p.border }}
          thumbColor={p.onAccent}
          accessibilityLabel="Open sessions only"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
  field: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32, paddingHorizontal: 10, borderRadius: 6 },
  input: { flex: 1, minWidth: 0, padding: 0 },
  button: { width: BUTTON, height: BUTTON, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  activeDot: { position: "absolute", top: 4, right: 4, width: 6, height: 6, borderRadius: 3 },
  menu: { minWidth: 192, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 4, elevation: 8 },
  menuLabel: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 4, paddingStart: 36, fontWeight: "500" },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40, paddingHorizontal: 12 },
  slot: { width: 16, alignItems: "center" },
  separator: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
});
