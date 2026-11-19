// The terminal mode's body (the web's TerminalView.tsx): transcript, progress line and input for one
// thread, in the terminal font and the chosen color set (DESIGN.md 6i). MainScreen swaps it with the
// chat timeline and composer; both read the same thread store, so switching keeps the run, the
// pending asks and the draft. Owns what the view alone keeps: the transcript view (ctrl+o on the
// web), and the width its columns come from.
import { useMemo, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { OrchestrationV2TurnItem, PendingQuestionView, PendingSend, SessionSummary, ThreadSnapshot } from "@maru/shared";
import type { PermissionMode } from "../../../../web/src/components/terminal/terminalModel.ts";
import { useAppearance } from "../../appearance.tsx";
import type { Pairing } from "../../lib/api.ts";
import { messageTarget, openMessageMenu, useMessageActionsKey } from "../../lib/messageActions.ts";
import { addToast } from "../../lib/toast.ts";
import { useTerminalBlocks } from "../../lib/useTerminalBlocks.ts";
import { TermRoot } from "./TermRoot.tsx";
import { TerminalComposer } from "./TerminalComposer.tsx";
import { TerminalTasks } from "./TerminalTasks.tsx";
import { TerminalTimeline } from "./TerminalTimeline.tsx";
import { T, useTerm } from "./term.tsx";

export interface TerminalViewProps {
  session: SessionSummary | null;
  /** The open thread: the session's own or a subagent's transcript. */
  snapshot: ThreadSnapshot;
  cwd: string | null;
  /** Set when the thread is a subagent's and no listed session stands for it. */
  readOnly: string | null;
  /** What the composer reads (model, context, goal); null for a subagent's thread. */
  composerSnapshot: ThreadSnapshot | null;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onOpenThread: (threadId: string) => void;
  sendTick: number;
  queued: readonly PendingSend[];
  queuedBusy: ReadonlySet<string>;
  sendNow: { busy: boolean; onSend: () => void } | null;
  onRecall: (id: string) => void;
  online: boolean;
  pairing: Pairing;
  bottomInset: number;
  error: string | null;
  notice: string | null;
  onClearNotice: () => void;
  pending: readonly PendingQuestionView[];
  failedReqId: string | null;
  onAnswer: (requestId: string, answers: Record<string, string>) => string | null;
  onSend: (text: string, attachmentIds: string[]) => void;
  onStop: () => void;
  onSetMode: (mode: PermissionMode) => boolean;
}

export function TerminalView(props: TerminalViewProps) {
  const { prefs } = useAppearance();
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  return (
    <TermRoot font={prefs.monoFont} fontSize={prefs.terminalFontSize} colorset={prefs.terminalColorset} width={width}>
      <Body {...props} onLayout={onLayout} />
    </TermRoot>
  );
}

function Body(props: TerminalViewProps & { onLayout: (e: LayoutChangeEvent) => void }) {
  const { tokens, cellW, columns } = useTerm();
  // ctrl+o on the web: every call on its own and in full.
  const [verbose, setVerbose] = useState(false);
  const agentName = props.session?.provider === "codex" ? "Codex" : "Claude";
  const view = useTerminalBlocks(props.snapshot, { cwd: props.cwd ?? undefined, columns, verbose, agentName });

  const menuKey = useMessageActionsKey();
  const { userItems } = view;
  const onUserMenu = useMemo(
    () => (id: string, text: string) => {
      const target = messageTarget(menuKey, userItems.get(id) as OrchestrationV2TurnItem | undefined);
      if (target !== null) openMessageMenu({ text, targetId: target });
      // A transcript the server cannot rewind or fork still copies.
      else void Clipboard.setStringAsync(text).then(() => addToast({ type: "success", title: "Copied" }));
    },
    [menuKey, userItems],
  );

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]} onLayout={props.onLayout} testID="terminal-view">
      <View style={styles.scroll}>
        <TerminalTimeline
          snapshot={props.snapshot}
          view={view}
          columns={columns}
          loadingOlder={props.loadingOlder}
          onLoadOlder={props.onLoadOlder}
          onOpenThread={props.onOpenThread}
          sendTick={props.sendTick}
          queued={props.queued}
          queuedBusy={props.queuedBusy}
          sendNow={props.sendNow}
          onRecall={props.onRecall}
          onUserMenu={onUserMenu}
        />
      </View>
      {verbose ? (
        <View style={[styles.verbose, { borderTopColor: tokens.rule, paddingHorizontal: 3 * cellW }]}>
          <T c="dim">Showing detailed transcript</T>
          <T c="dim">verbose</T>
        </View>
      ) : null}
      <TerminalComposer
        session={props.session}
        snapshot={props.composerSnapshot}
        readOnly={props.readOnly}
        online={props.online}
        pairing={props.pairing}
        bottomInset={props.bottomInset}
        verbose={verbose}
        onToggleVerbose={() => setVerbose((v) => !v)}
        error={props.error}
        notice={props.notice}
        onClearNotice={props.onClearNotice}
        pending={props.pending}
        failedReqId={props.failedReqId}
        onAnswer={props.onAnswer}
        onSend={props.onSend}
        onStop={props.onStop}
        onSetMode={props.onSetMode}
        below={
          // The panel lists the session's own agents: in the main conversation, not inside an agent's.
          props.session && props.composerSnapshot ? (
            <TerminalTasks subagents={props.snapshot.subagents} sessionKey={props.session.key} viewingThreadId={props.snapshot.threadId} onShowThread={props.onOpenThread} />
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1, minHeight: 0 },
  verbose: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1 },
});
