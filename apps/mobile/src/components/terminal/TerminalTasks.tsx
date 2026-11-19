// The agent panel under the footer (the web's TaskPanel in TerminalComposer.tsx): "main", then the
// agents and workflows that run or just ended, one row each, the time at the right. A tap on a row
// opens that conversation (the web's Enter); the web's x and r keys (stop, resume) are not here,
// because a device token has no route for them (lib/terminalTasks.logic.ts). The web folds rows past
// five into "↑ N more" and moves a selection through them; a phone has no selection, so the list
// scrolls inside the height of those six rows instead.
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { OrchestrationV2Subagent } from "@maru/shared";
import { PANEL_ROWS, taskRows, workflowBar, type TaskRow } from "../../../../web/src/components/terminal/terminalTasks.ts";
import { agentViewsOf } from "../../lib/terminalTasks.logic.ts";
import { R, T, useTerm, type Role } from "./term.tsx";

export function TerminalTasks(props: {
  subagents: ReadonlyArray<OrchestrationV2Subagent>;
  /** The session's own thread: the "main" row. */
  sessionKey: string;
  /** The thread on screen. */
  viewingThreadId: string;
  /** Shows a thread: the session's own, or an agent's. */
  onShowThread: (threadId: string) => void;
}) {
  const { grid, cellW } = useTerm();
  const [now, setNow] = useState(() => Date.now());
  const agents = useMemo(() => agentViewsOf(props.subagents), [props.subagents]);
  const rows = useMemo(() => taskRows(agents, now, props.sessionKey, props.viewingThreadId), [agents, now, props.sessionKey, props.viewingThreadId]);
  // The rows' times count up, and an ended row leaves after its while.
  useEffect(() => {
    if (agents.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [agents.length]);
  if (rows.length === 0) return null;
  const pad = Math.max(0, (44 - grid.lineHeight) / 2);
  return (
    <ScrollView
      accessibilityLabel="Activity"
      nestedScrollEnabled
      style={{ maxHeight: (PANEL_ROWS + 1) * Math.max(grid.lineHeight, 44) }}
      keyboardShouldPersistTaps="handled"
    >
      {rows.map((row) => (
        <Pressable
          key={row.key}
          disabled={row.threadId === null || row.threadId === props.viewingThreadId}
          onPress={() => row.threadId && props.onShowThread(row.threadId)}
          accessibilityRole="button"
          accessibilityLabel={row.kind === "main" ? "Open the session's own conversation" : `Open ${row.name} ${row.detail}`.trim()}
          style={{ paddingVertical: pad }}
        >
          <Row row={row} cellW={cellW} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

function Row({ row, cellW }: { row: TaskRow; cellW: number }) {
  const glyph: Role = row.tone === "stopped" ? "err" : row.tone === "done" ? "ok" : row.tone === "viewing" ? "fg" : "dim";
  const bar = row.bar ? workflowBar(row.bar.done, row.bar.total) : null;
  return (
    <View style={styles.row}>
      <T c={row.kind === "main" ? "fg" : "dim"} numberOfLines={1} style={styles.name}>
        {"  "}
        <R c={glyph}>{row.glyph}</R> {row.kind === "main" ? <R bold>{row.name}</R> : row.name}
        {row.detail ? `  ${row.detail}` : ""}
        {bar ? (
          <>
            {"  "}
            <R c="fg">{bar.filled}</R>
            <R c="dim">{bar.empty}</R>
            {row.right ? `  ${row.right}` : ""}
          </>
        ) : null}
      </T>
      {!bar && row.right ? (
        <T c="dim" style={{ paddingHorizontal: 2 * cellW }}>
          {row.right}
        </T>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row" },
  name: { flex: 1, minWidth: 0 },
});
