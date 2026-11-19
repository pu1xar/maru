// The paired app: the web's conversation header (components/ScreenHeader.tsx), the conversation
// with its banners and empty states, the question the session waits on, the error and notice boxes
// and the composer, with the session drawer over it. /ws is open only while the app is on the
// screen; the server pushes otherwise.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, AppState, Dimensions, Keyboard, Platform, StyleSheet, View } from "react-native";
import { Text } from "../components/ui/Text.tsx";
import { CircleAlertIcon, PanelLeftIcon, SearchXIcon, WifiOffIcon, XIcon } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { FindHint, SessionSummary } from "@maru/shared";
import { displayName } from "../../../web/src/model.ts";
import { Connection } from "../lib/connection.ts";
import { nextReqId, useMaru, useThread } from "../lib/useMaru.ts";
import type { Pairing } from "../lib/pairing.ts";
import { enablePush, onPushOpened, setSessionOnScreen } from "../lib/push.ts";
import type { PushStatus } from "../lib/pushData.ts";
import { Drawer } from "../components/Drawer.tsx";
import { SessionList } from "../components/SessionList.tsx";
import { Composer } from "../components/Composer.tsx";
import { PendingPanel } from "../components/PendingPanel.tsx";
import { NewSessionSheet } from "../components/NewSessionSheet.tsx";
import { MessageActions } from "../components/MessageActions.tsx";
import { Timeline } from "../components/timeline/Timeline.tsx";
import { TextScopeProvider } from "../appearance.tsx";
import { QueuedRows } from "../components/QueuedRows.tsx";
import { canSendNow, deliveredIds, shownQueued } from "../../../web/src/lib/queuedMessages.logic.ts";
import { putBackDraft, restoreDraft } from "../lib/drafts.ts";
import { prependAttachments, restoreAttachments } from "../lib/composerAttachments.ts";
import { attachmentsToPutBack, textsToPutBack, type AskedRecall } from "../lib/recallQueue.ts";
import { readLastSession, writeLastSession } from "../lib/lastSession.ts";
import { rememberableSession, restorableSession } from "../lib/lastSession.logic.ts";
import { FindBar } from "../components/FindBar.tsx";
import { ScreenHeader } from "../components/ScreenHeader.tsx";
import { Btn } from "../components/ui/Btn.tsx";
import { EmptyState } from "../components/ui/EmptyState.tsx";
import { chat } from "../components/ui/metrics.ts";
import { ComposerError } from "../components/ComposerNotice.tsx";
import { Banner, NoticeBox } from "../components/ui/Notices.tsx";
import { ToastHost } from "../components/ui/ToastHost.tsx";
import { useThreadFind } from "../lib/useThreadFind.ts";
import { SettingsSheet } from "../components/SettingsSheet.tsx";
import { usePalette } from "../theme.ts";
import { TerminalView } from "../components/terminal/TerminalView.tsx";
import { moveSessionViewMode, useViewMode } from "../lib/viewModeStore.ts";
import type { PermissionMode } from "../../../web/src/components/terminal/terminalModel.ts";
import { ShellScreen } from "../components/shell/ShellScreen.tsx";
import { endShell, showShell } from "../shell/actions.ts";
import { useShells } from "../shell/useShells.ts";
import { addToast } from "../lib/toast.ts";
import { reorderProjects } from "../lib/api.ts";
import { TERMINAL_GROUP_KEY } from "../../../web/src/lib/shellGroup.ts";
import { lastActiveShell, onActiveShellChange, pickActive } from "../../../web/src/lib/shellTabs.ts";

/** A subagent transcript's thread id is `<session key>:agent-<id>` (packages/shared subagentThreadId). */
function parentOf(threadId: string, session: SessionSummary | null): string | null {
  if (session?.parentKey) return session.parentKey;
  const i = threadId.lastIndexOf(":agent-");
  return i > 0 ? threadId.slice(0, i) : null;
}

export function MainScreen(props: { pairing: Pairing; onRevoked: () => void; onUnpair: () => void }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const conn = useMemo(() => new Connection(props.pairing), [props.pairing]);
  useEffect(() => {
    conn.start();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") conn.resume();
      else if (s === "background") conn.suspend();
    });
    return () => {
      sub.remove();
      conn.stop();
    };
  }, [conn]);

  const maru = useMaru(conn, props.pairing);
  const { onRevoked } = props;
  useEffect(() => {
    if (maru.connection === "revoked") onRevoked();
  }, [maru.connection, onRevoked]);

  const [selected, setSelected] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [settings, setSettings] = useState(false);
  const [creating, setCreating] = useState(false);
  // The shell screen (DESIGN.md 6s) covers the conversation; the session stays selected under it.
  // lookKey changes when Settings closes, so the shell takes a changed terminal size or color set.
  const [shellOpen, setShellOpen] = useState(false);
  const [lookKey, setLookKey] = useState(0);
  const [push, setPush] = useState<PushStatus>({ state: "pending" });
  const [now, setNow] = useState(Date.now());
  // Counts the messages sent; the conversation scrolls to its end when it grows (Timeline sendTick).
  const [sendTick, setSendTick] = useState(0);
  // The notice a rewind leaves and the error a fork or a rewind that finished after its sheet closed
  // gives (the web shows them above the input); both go when another session opens.
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => {
    setNotice(null);
    setActionError(null);
  }, [selected]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  // A launch reopens the session that was open last (lib/lastSession.ts); when there is none to
  // reopen, the drawer opens on the first list, as Claude's app starts there.
  const [lastKey, setLastKey] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void readLastSession().then((k) => live && setLastKey(k));
    return () => {
      live = false;
    };
  }, []);
  const launched = useRef(false);
  useEffect(() => {
    if (launched.current || !maru.loaded || lastKey === undefined) return;
    launched.current = true;
    // A tapped notification that already opened a session keeps it.
    if (selected !== null) return;
    const key = restorableSession(lastKey, maru.sessions);
    if (key) setSelected(key);
    else setDrawer(true);
  }, [maru.loaded, maru.sessions, lastKey, selected]);
  const remembered = useRef<string | null>(null);
  useEffect(() => {
    if (!launched.current || !rememberableSession(selected, maru.sessions) || remembered.current === selected) return;
    remembered.current = selected;
    writeLastSession(selected);
  }, [selected, maru.sessions]);

  const select = useCallback((key: string) => {
    setSelected(key);
    setShellOpen(false);
    setDrawer(false);
  }, []);
  // Pushes: the token to the server, and a tapped notification opens its session.
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    let live = true;
    void enablePush(props.pairing, (s) => live && setPush(s)).then((c) => {
      if (live) cleanup = c;
      else c();
    });
    const offOpened = onPushOpened(select);
    return () => {
      live = false;
      cleanup?.();
      offOpened();
    };
  }, [props.pairing, select]);
  useEffect(() => {
    setSessionOnScreen(selected);
    return () => setSessionOnScreen(null);
  }, [selected]);

  // A session opened from a conversation search that the list does not hold (DESIGN.md 6u): kept so the header and the composer know it.
  const [peeked, setPeeked] = useState<SessionSummary | null>(null);
  const session = selected ? (maru.sessions.get(selected) ?? (peeked?.key === selected ? peeked : null)) : null;
  const parent = selected ? parentOf(selected, session) : null;
  const thread = useThread(conn, selected);
  const keyboard = useKeyboardHeight();
  const shells = useShells(props.pairing, shellOpen || drawer);
  const shownShell = pickActive(shells.shells ?? [], useSyncExternalStore(onActiveShellChange, lastActiveShell, () => null));
  // Find in the conversation, and the find a search over every session hands to the session it opens.
  const find = useThreadFind({
    conn,
    threadId: selected,
    snapshot: thread?.snapshot ?? null,
    loadingOlder: thread?.loadingOlder ?? false,
    loadOlderUntil: thread?.loadOlderUntil ?? NEVER_LOADS,
    ready: maru.connection === "open" && !!thread?.snapshot,
  });
  const [pendingFind, setPendingFind] = useState<{ key: string; query: string; hint: FindHint } | null>(null);
  const findReady = maru.connection === "open" && !!thread?.snapshot;
  const { openFind } = find;
  useEffect(() => {
    if (!pendingFind || selected !== pendingFind.key || !findReady) return;
    openFind({ query: pendingFind.query, hint: pendingFind.hint });
    setPendingFind(null);
  }, [pendingFind, selected, findReady, openFind]);

  const send = (text: string, attachmentIds: string[]) => {
    if (!selected) return;
    conn.send({ type: "thread.send", threadId: selected, text, ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}), reqId: nextReqId("send") });
    setSendTick((n) => n + 1);
    setActionError(null);
    setNotice(null);
  };
  const stop = () => selected && conn.send({ type: "thread.interrupt", threadId: selected, reqId: nextReqId("stop") });
  // The terminal mode's mode line (shift+tab on the web); the server answers with the new state or an error.
  const setMode = (mode: PermissionMode): boolean =>
    selected !== null && conn.send({ type: "thread.setPermissionMode", threadId: selected, mode, reqId: nextReqId("mode") });
  /** The answer's request id once sent; null when the connection is down. */
  const answer = (requestId: string, answers: Record<string, string>): string | null => {
    if (!selected) return null;
    const reqId = nextReqId("answer");
    return conn.send({ type: "thread.answer", threadId: selected, requestId, answers, reqId }) ? reqId : null;
  };
  // Taking queued messages back: their texts go in front of that session's draft, as on the web (DESIGN.md 4.4).
  const recalls = useRef(new Map<string, AskedRecall>());
  const [recalling, setRecalling] = useState<ReadonlySet<string>>(new Set());
  useEffect(
    () =>
      conn.onMessage((msg) => {
        if (msg.type === "hello") {
          // A new connection answers no recall that was on its way.
          recalls.current.clear();
          setRecalling(new Set());
          return;
        }
        // A send the server refused gives back its text and uploads while the input is empty (DESIGN.md 6n).
        if (msg.type === "command.error" && msg.threadId && msg.reqId?.startsWith("send-") && (msg.unsent || msg.unsentAttachments)) {
          if (msg.unsentAttachments) restoreAttachments(msg.threadId, msg.unsentAttachments);
          if (msg.unsent) restoreDraft(msg.threadId, msg.unsent);
          return;
        }
        if (msg.type !== "thread.recalled" || !msg.reqId || !recalls.current.has(msg.reqId)) return;
        const asked = recalls.current.get(msg.reqId)!;
        recalls.current.delete(msg.reqId);
        setRecalling((prev) => new Set([...prev].filter((x) => x !== asked.id)));
        // The texts go in front of the draft and the uploads in front of the waiting attachments; a discard drops both.
        const texts = textsToPutBack(asked, msg.messages);
        if (texts.length) putBackDraft(asked.key, texts);
        prependAttachments(asked.key, attachmentsToPutBack(asked, msg.messages));
      }),
    [conn],
  );
  // Send now (web sendQueuedNow): the request on its way, and the notice its answer carries (an error comes through lastError).
  const [sendingNow, setSendingNow] = useState<string | null>(null);
  useEffect(
    () =>
      conn.onMessage((msg) => {
        if (msg.type === "hello") setSendingNow(null);
        else if ((msg.type === "command.result" || msg.type === "command.error") && msg.reqId?.startsWith("sendnow-")) {
          setSendingNow((cur) => (cur === msg.reqId ? null : cur));
          if (msg.type === "command.result" && msg.notice) setNotice(msg.notice);
        }
      }),
    [conn],
  );
  const sendNow = () => {
    if (!selected || sendingNow) return;
    const reqId = nextReqId("sendnow");
    if (conn.send({ type: "thread.sendNow", threadId: selected, reqId })) {
      setSendingNow(reqId);
      setActionError(null);
      setNotice(null);
    }
  };
  const recall = (id: string, discard: boolean) => {
    if (!selected) return;
    const reqId = `mr${Date.now()}`;
    if (!conn.send({ type: "thread.recall", threadId: selected, ids: [id], reqId })) return;
    recalls.current.set(reqId, { key: selected, id, discard });
    setRecalling((prev) => new Set([...prev, id]));
  };
  const sends = selected ? maru.queued.get(selected) : undefined;
  const queuedRows = useMemo(
    () => (sends?.length ? shownQueued(sends, deliveredIds(thread?.snapshot?.visibleTurnItems ?? [])) : []),
    [sends, thread?.snapshot],
  );

  const lastError = maru.lastError && (!maru.lastError.threadId || maru.lastError.threadId === selected) ? maru.lastError : null;
  const error = lastError && now - lastError.at < 60_000 ? lastError.error : null;
  const pending = selected ? (maru.pending.get(selected) ?? []) : [];
  const shownError = error ?? actionError;

  // The header describes the listed session, or the one a subagent's transcript belongs to.
  const rootSession = parent ? (maru.sessions.get(parent) ?? null) : session;
  const serverDown = maru.connection === "offline";
  const snapshot = thread?.snapshot ?? null;
  // A session the list does not have and the server did not open either (web MissingSessionState).
  const missing = selected !== null && !session && !parent && maru.loaded && !snapshot && !thread?.error;
  const inConversation = selected !== null && (session !== null || parent !== null || snapshot !== null);
  // The conversation as the chat timeline or as the CLI's screen (DESIGN.md 6i); a session's own choice, else the Settings default.
  const [viewMode, setViewMode] = useViewMode(selected);
  const terminal = viewMode === "terminal" && snapshot !== null && !missing;
  const pickViewMode = (mode: typeof viewMode) => {
    // The find belongs to the chat timeline.
    if (mode === "terminal") find.bar?.onClose();
    setViewMode(mode);
  };
  const title = !inConversation
    ? null
    : parent
      ? snapshot?.title || "subagent"
      : session
        ? displayName(session)
        : snapshot?.title || "";

  // The shell a new one starts beside: the folder of the session the screen covers.
  const shellCwd = rootSession?.cwd ?? null;
  const terminalGroup = {
    shells: shells.shells,
    screenOpen: shellOpen,
    shown: shownShell,
    folded: maru.folded.has(TERMINAL_GROUP_KEY),
    onToggleFold: () => maru.setFolded(TERMINAL_GROUP_KEY, !maru.folded.has(TERMINAL_GROUP_KEY)),
    onToggleScreen: () => {
      setShellOpen((open) => !open);
      setDrawer(false);
    },
    onNewShell: () => {
      setShellOpen(true);
      setDrawer(false);
      shells.store.create(shellCwd).then(
        (shell) => showShell(shell.id),
        (err: unknown) => addToast({ type: "error", title: "Could not open a shell", description: err instanceof Error ? err.message : String(err) }),
      );
    },
    onSelect: (id: string) => {
      showShell(id);
      setShellOpen(true);
      setDrawer(false);
    },
    onEnd: (id: string) => {
      endShell(shells.store, id).then(
        ({ closeScreen }) => closeScreen && setShellOpen(false),
        (err: unknown) => addToast({ type: "error", title: "Could not end the shell", description: err instanceof Error ? err.message : String(err) }),
      );
    },
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.bg, paddingBottom: keyboard }}>
      {shellOpen ? (
        <ShellScreen
          pairing={props.pairing}
          shells={shells}
          sessionCwd={shellCwd}
          topInset={insets.top}
          bottomInset={keyboard ? 0 : insets.bottom}
          lookKey={lookKey}
          onOpenSidebar={() => setDrawer(true)}
          onClose={() => setShellOpen(false)}
        />
      ) : null}
      {/* Hidden, not unmounted, while the shell screen shows: the conversation keeps its scroll position and find. */}
      <View style={shellOpen ? styles.hidden : styles.fill}>
        <ScreenHeader
          topInset={insets.top}
          title={title}
          idleLabel={!selected ? "No open session" : missing ? "Session not found" : ""}
          root={parent && rootSession ? { title: displayName(rootSession), onOpen: () => setSelected(parent) } : null}
          session={rootSession}
        canFind={!!snapshot && !terminal}
          findOpen={find.open}
          onFind={() => (find.bar ? find.bar.onClose() : find.openFind())}
          onOpenSidebar={() => setDrawer(true)}
        viewMode={snapshot && !missing ? { mode: viewMode, onChange: pickViewMode } : null}
        />
        <View style={{ flex: 1 }}>
          {!selected ? (
            <EmptyState scale="ui" title="Select a session">
              <Btn
                variant="outline"
                label="Session list"
                icon={<PanelLeftIcon size={18} color={p.muted} />}
                onPress={() => setDrawer(true)}
              />
            </EmptyState>
          ) : missing ? (
            <EmptyState scale="ui" icon={<SearchXIcon size={20} color={p.muted} />} title="Session not found">
              <Btn variant="outline" size="sm" label="Clear selection" icon={<XIcon size={18} color={p.muted} />} onPress={() => setSelected(null)} />
            </EmptyState>
          ) : (
            <>
              {serverDown && snapshot ? <Banner icon={WifiOffIcon}>Disconnected from server</Banner> : null}
              {thread?.error && snapshot ? <Banner tone="error" icon={CircleAlertIcon}>{thread.error}</Banner> : null}
            {snapshot && terminal ? (
              <TerminalView
                // One view per thread: the transcript view and what it opened start over in another.
                key={snapshot.threadId}
                session={session}
                snapshot={snapshot}
                cwd={session?.cwd ?? (parent ? (maru.sessions.get(parent)?.cwd ?? null) : null)}
                readOnly={parent !== null && !session ? "Subagent conversations are read-only" : null}
                composerSnapshot={parent ? null : snapshot}
                loadingOlder={thread!.loadingOlder}
                onLoadOlder={thread!.loadOlder}
                onOpenThread={setSelected}
                sendTick={sendTick}
                queued={queuedRows}
                queuedBusy={recalling}
                sendNow={session && !parent && canSendNow(session, false) ? { busy: sendingNow !== null, onSend: sendNow } : null}
                onRecall={(id) => recall(id, false)}
                online={maru.connection === "open"}
                pairing={props.pairing}
                bottomInset={keyboard ? 0 : insets.bottom}
                error={shownError}
                notice={notice}
                onClearNotice={() => setNotice(null)}
                pending={pending}
                failedReqId={lastError?.reqId ?? null}
                onAnswer={answer}
                onSend={send}
                onStop={stop}
                onSetMode={setMode}
              />
            ) : snapshot ? (
                <TextScopeProvider scope="chat">
                  <Timeline
                    snapshot={snapshot}
                    cwd={session?.cwd ?? (parent ? (maru.sessions.get(parent)?.cwd ?? null) : null)}
                    loadingOlder={thread!.loadingOlder}
                    onLoadOlder={thread!.loadOlder}
                    onOpenThread={setSelected}
                    sendTick={sendTick}
                    find={find.timeline}
                    visibleRef={find.visibleRef}
                    tail={queuedRows.length ? <QueuedRows sends={queuedRows} busy={recalling} sendNow={session && !parent && canSendNow(session, false) ? { busy: sendingNow !== null, onSend: sendNow } : null} onRecall={(id) => recall(id, false)} /> : undefined}
                  />
                </TextScopeProvider>
              ) : thread?.error ? (
                <EmptyState scale="chat" title="Could not open conversation" description={thread.error} />
              ) : serverDown ? (
                <EmptyState
                  scale="chat"
                  icon={<WifiOffIcon size={20} color={p.muted} />}
                  title="Disconnected from server"
                />
              ) : (
                <TimelineLoading />
              )}
            </>
          )}
        {find.bar && !terminal ? <FindBar bar={find.bar} /> : null}
        </View>
        {terminal ? null : (
        <TextScopeProvider scope="chat">
          <Composer
            above={
              <>
                {pending.length ? (
                  <PendingPanel
                    key={selected}
                    embedded
                    questions={pending}
                    maxHeight={Dimensions.get("window").height * 0.5 - keyboard / 2}
                    failedReqId={lastError?.reqId ?? null}
                    onAnswer={answer}
                  />
                ) : null}
                {shownError ? <ComposerError text={shownError} /> : null}
                {notice ? <NoticeBox embedded message={notice} onClose={() => setNotice(null)} /> : null}
              </>
            }
            session={session}
            snapshot={parent ? null : (thread?.snapshot ?? null)}
            readOnly={parent !== null && !session ? "Subagent conversations are read-only" : null}
            online={maru.connection === "open"}
            pairing={props.pairing}
            bottomInset={keyboard ? 0 : insets.bottom}
            onSend={send}
            onStop={stop}
          />
        </TextScopeProvider>
        )}
      </View>
      <Drawer open={drawer} onOpen={() => setDrawer(true)} onClose={() => setDrawer(false)}>
        <SessionList
          sessions={maru.sessions}
          projects={maru.projects}
          loaded={maru.loaded}
          folded={maru.folded}
          onToggleFold={(key) => maru.setFolded(key, !maru.folded.has(key))}
          onReorderGroups={(ids) =>
            reorderProjects(props.pairing, ids).catch((err: unknown) =>
              addToast({ type: "error", title: "Could not reorder", description: err instanceof Error ? err.message : String(err) }),
            )
          }
          usage={maru.usage}
          selected={selected}
          now={now}
          topInset={insets.top}
          bottomInset={keyboard || insets.bottom}
          pairing={props.pairing}
          onOpenHit={(hit, s, q) => {
            setPeeked(maru.sessions.has(s.key) ? null : s);
            setPendingFind({ key: s.key, query: q, hint: { itemId: hit.itemId, role: hit.role, at: hit.at } });
            select(s.key);
          }}
          connection={maru.connection}
          onSelect={(s) => select(s.key)}
          onNew={() => {
            setDrawer(false);
            setCreating(true);
          }}
          onSettings={() => {
            setDrawer(false);
            setSettings(true);
          }}
          onHome={() => {
            setSelected(null);
            setSettings(false);
            setShellOpen(false);
            setDrawer(false);
          }}
          terminal={terminalGroup}
        />
      </Drawer>
      <NewSessionSheet
        open={creating}
        pairing={props.pairing}
        conn={conn}
        online={maru.connection === "open"}
        sessions={maru.sessions}
        projects={maru.projects}
        projectId={session?.parentKey ? null : (session?.projectId ?? null)}
        onClose={() => setCreating(false)}
        onCreated={(key) => {
          setCreating(false);
          select(key);
        }}
      />
      <SettingsSheet
        open={settings}
        pairing={props.pairing}
        push={push}
        sessions={maru.sessions}
        onClose={() => {
          setSettings(false);
          setLookKey((n) => n + 1);
        }}
        onUnpair={props.onUnpair}
        onOpenSession={(key) => {
          setSettings(false);
          select(key);
        }}
        onRekey={(from, to) => {
          // A session moved to another account keeps its own view mode.
          moveSessionViewMode(from, to);
          setSelected((cur) => (cur === from ? to : cur));
        }}
      />
      {/* The user bubbles' menu: copy, rewind, fork. A subagent's transcript has none (the server cannot rewind or fork it). */}
      <MessageActions
        pairing={props.pairing}
        sessionKey={parent ? null : selected}
        onOpenSession={select}
        onNotice={setNotice}
        onError={setActionError}
      />
      <ToastHost />
    </View>
  );
}

const NEVER_LOADS = () => false;

/** Blank at first like the web's timeline, then a spinner if the snapshot is slow to come (ThreadView TimelineLoading). */
const LOADING_SPINNER_DELAY_MS = 400;
function TimelineLoading() {
  const p = usePalette();
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), LOADING_SPINNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <View style={styles.loading}>
      {late ? (
        <>
          <ActivityIndicator size="small" color={p.muted} style={{ transform: [{ scale: 0.8 }] }} />
          <Text style={[chat.sm, { color: p.muted }]}>Loading conversation</Text>
        </>
      ) : null}
    </View>
  );
}

/**
 * How far the software keyboard reaches up from the bottom of the screen. Android draws apps edge
 * to edge, so the window keeps its size when the keyboard opens and the screen pads itself. The
 * keyboard's top edge is used rather than its reported height, which leaves out the navigation bar
 * area under it (measured on the emulator: the composer sat partly under the keyboard).
 */
function useKeyboardHeight(): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const show = Keyboard.addListener("keyboardDidShow", (e) =>
      setH(Math.max(0, Dimensions.get("screen").height - e.endCoordinates.screenY)),
    );
    const hide = Keyboard.addListener("keyboardDidHide", () => setH(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return h;
}


const styles = StyleSheet.create({
  fill: { flex: 1 },
  hidden: { display: "none" },
  // flex flex-1 items-center justify-center gap-2.
  loading: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
});
