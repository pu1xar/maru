// The rows of the session table (the web's settings/manage/ManageRows.tsx) as the phone lays them
// out. The web's table folds its columns by its own width (id below 45rem, last update below 39rem,
// size below 33rem, the lock and delete buttons below 28rem into the row menu), and a phone is
// below all of them; the phone stacks what the web keeps (the name over its folder) and puts the
// account, size and last update in a third line instead of dropping them, where a row of columns
// has no room. The select box, the provider mark and the ⋮ menu button are the web's. A row carries
// no status mark (running, waiting, error, open, closed; user request 2026-11-18). A tap on the row
// is the web's click on the name: it opens the conversation.
import { StyleSheet, View } from "react-native";
import { LockIcon, MoreHorizontalIcon, TriangleAlertIcon } from "lucide-react-native";
import type { UnitRow } from "@maru/shared";
import { rowLocked, type ManageRow, type UnitLabel } from "../../../../../web/src/components/settings/manageModel.ts";
import { deleteBlock, rowFolder, rowLabel, sessionMeta, unitMeta } from "../../../lib/manage.logic.ts";
import { usePalette } from "../../../theme.ts";
import { Press } from "../../Press.tsx";
import { ProviderIcon } from "../../sidebar/ProviderIcon.tsx";
import { Checkbox } from "../../ui/Checkbox.tsx";
import { Text } from "../../ui/Text.tsx";
import { ui } from "../../ui/metrics.ts";
import { useChrome } from "../../ui/useChrome.ts";

/** The ⋮ button at the row's end (a 36 icon button, 44 to touch). */
function MenuButton(props: { label: string; onPress: () => void }) {
  const p = usePalette();
  const c = useChrome();
  return (
    <Press
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={4}
      android_ripple={{ color: c.accent, borderless: true, radius: 20 }}
      style={styles.menu}
    >
      <MoreHorizontalIcon size={16} color={p.muted} />
    </Press>
  );
}

export function SessionRowView(props: {
  row: ManageRow;
  now: number;
  selected: boolean;
  onSelect: (on: boolean) => void;
  /** The row's tap: the conversation when the app can open it, else the menu. */
  onPress: () => void;
  onMenu: () => void;
}) {
  const p = usePalette();
  const c = useChrome();
  const r = props.row;
  const blocked = deleteBlock(r);
  const label = rowLabel(r);
  return (
    <View style={styles.row} accessibilityState={{ selected: props.selected }}>
      <View style={styles.box}>
        <Checkbox label={blocked ? `Select ${label}, ${blocked}` : `Select ${label}`} checked={props.selected} disabled={blocked !== null} onChange={props.onSelect} />
      </View>
      <Press
        onPress={props.onPress}
        accessibilityRole="button"
        accessibilityLabel={r.kind === "orphan" ? `Leftover files ${label}` : label}
        android_ripple={{ color: c.accent, foreground: true }}
        style={styles.body}
      >
        <View style={styles.nameLine}>
          {r.kind === "orphan" ? (
            <>
              <TriangleAlertIcon size={14} color={c.warningForeground} />
              <Text style={[ui.sm, { color: p.muted, flexShrink: 1 }]} numberOfLines={1}>No transcript</Text>
            </>
          ) : (
            <>
              <ProviderIcon provider={r.session.provider} size={14} />
              <Text style={[ui.sm, { color: p.text, fontWeight: "500", flexShrink: 1 }]} numberOfLines={1}>{label}</Text>
            </>
          )}
          {rowLocked(r) ? <LockIcon accessibilityLabel="Locked" size={12} color={c.warningForeground} /> : null}
        </View>
        <Text style={[ui.xs, { color: p.muted }]} numberOfLines={1} ellipsizeMode="head">{rowFolder(r)}</Text>
        <Text style={[ui.xs, { color: p.muted }]} numberOfLines={1}>{sessionMeta(r, props.now)}</Text>
      </Press>
      <MenuButton label={`Actions for ${label}`} onPress={props.onMenu} />
    </View>
  );
}

export function UnitRowView(props: {
  unit: UnitRow;
  now: number;
  /** The parent session's name (the row's name when the table shows units of every session). */
  parentName: string;
  parentPath: string | null;
  /** Set when the table is narrowed to this unit's session. */
  label: UnitLabel | null | undefined;
  narrowed: boolean;
  onPress: () => void;
  onMenu: () => void;
}) {
  const p = usePalette();
  const c = useChrome();
  const u = props.unit;
  const title = props.narrowed ? (props.label?.title ?? u.unitId) : props.parentName;
  const sub = props.narrowed ? (props.label?.detail ?? u.kind) : props.parentPath ? props.parentPath.replace(/^\/Users\/[^/]+/, "~") : u.enc;
  return (
    <View style={styles.row}>
      <Press
        onPress={props.onPress}
        accessibilityRole="button"
        accessibilityLabel={`${u.kind} ${u.unitId}, ${title}`}
        android_ripple={{ color: c.accent, foreground: true }}
        style={[styles.body, { paddingLeft: 12 }]}
      >
        <View style={styles.nameLine}>
          <ProviderIcon provider="claude" size={14} />
          <Text style={[ui.sm, { color: p.text, fontWeight: "500", flexShrink: 1 }]} numberOfLines={1}>{title}</Text>
          {u.locked ? <LockIcon accessibilityLabel="Locked" size={12} color={c.warningForeground} /> : null}
        </View>
        <Text style={[ui.xs, { color: p.muted }]} numberOfLines={1} ellipsizeMode={props.narrowed ? "tail" : "head"}>{sub}</Text>
        <Text style={[ui.xs, { color: p.muted }]} numberOfLines={1}>{`${u.unitId}, ${unitMeta(u, props.now)}`}</Text>
      </Press>
      <MenuButton label={`Actions for ${u.kind} ${u.unitId}`} onPress={props.onMenu} />
    </View>
  );
}

const styles = StyleSheet.create({
  // The table cell's px-3 py-2 around a checkbox, the text lines and the ⋮ button.
  row: { flexDirection: "row", alignItems: "center", minHeight: 44, paddingLeft: 12, paddingRight: 4 },
  box: { width: 18 + 12, alignItems: "flex-start", justifyContent: "center" },
  body: { flex: 1, minWidth: 0, paddingVertical: 8, paddingRight: 8, gap: 1 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  menu: { width: 36, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center" },
});
