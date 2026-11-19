// A session's row (SessionSidebar.tsx SessionRow, the one-line "folder" row): the provider's mark, the
// name, a pin (in a Group, for a pinned session) and a terminal mark (the terminal holds it), and at
// the right end the status icon of a session at work or waiting. The account, folder and time the
// web puts in the row's hover card have no phone counterpart; the open row is the session itself.
import { memo } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../ui/Text.tsx";
import { PinIcon, TerminalIcon } from "lucide-react-native";
import type { SessionSummary } from "@maru/shared";
import { ACTIVITY_LABEL, sessionActivity } from "../../../../web/src/components/sessionActivity.logic.ts";
import { displayName, type SessionGroup } from "../../../../web/src/model.ts";
import { rowFacts, sessionMark } from "../../lib/sessionMark.ts";
import { usePalette } from "../../theme.ts";
import { type } from "../../typography.ts";
import { Press } from "../Press.tsx";
import { ActivityMark } from "./ActivityMark.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { useSidebarColors } from "./useSidebarColors.ts";

export const SessionRow = memo(function SessionRow(props: {
  s: SessionSummary;
  groupKind: SessionGroup["kind"];
  selected: boolean;
  onPress: () => void;
}) {
  const { s } = props;
  const p = usePalette();
  const sc = useSidebarColors();
  const title = displayName(s);
  const activity = sessionActivity(s);
  const mark = sessionMark(s);
  const facts = rowFacts(s, { kind: props.groupKind });
  // A closed session recedes like on the web, except the row that is open on screen.
  const recede = facts.recede && !props.selected;
  return (
    <Press
      onPress={props.onPress}
      hitSlop={{ top: 4, bottom: 4 }}
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      accessibilityLabel={`${title}, ${ACTIVITY_LABEL[activity]}${facts.pinned ? ", pinned" : ""}${props.groupKind === "archive" ? ", in Archive" : ""}${facts.terminalHeld ? ", open in terminal" : ""}`}
      style={[
        styles.row,
        props.selected ? { backgroundColor: sc.rowActive } : null,
        props.selected && sc.rowActiveRing ? { borderWidth: 1, borderColor: sc.rowActiveRing } : null,
      ]}
    >
      <ProviderIcon provider={s.provider} size={14} opacity={recede ? 0.5 : 1} />
      <Text
        style={[type.sidebar, styles.title, { color: p.text, fontWeight: recede ? "400" : "500", opacity: recede ? 0.75 : 1 }]}
        numberOfLines={1}
      >
        {title}
      </Text>
      {facts.pinned ? <PinIcon size={12} color={p.muted} /> : null}
      {facts.terminalHeld ? <TerminalIcon size={12} color={p.muted} /> : null}
      <View style={styles.status}>{mark ? <ActivityMark mark={mark} size={14} /> : null}</View>
    </Press>
  );
});

const styles = StyleSheet.create({
  // h-9, gap-2.5, px-2.5, and ps-9 so the mark starts in the folder name's column; rounded-md.
  row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 36, paddingEnd: 10, paddingStart: 36, borderRadius: 6 },
  title: { flex: 1, minWidth: 0 },
  status: { minWidth: 24, height: 24, alignItems: "flex-end", justifyContent: "center" },
});
