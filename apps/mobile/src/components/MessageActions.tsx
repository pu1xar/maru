// The host of the message menu and the rewind sheet (DESIGN.md 2d, 6o, 6q). It registers for the
// open session (lib/messageActions.ts), so the user bubbles' "more" button opens the menu: copy,
// Rewind to here, Fork from here. Rewinding opens RewindSheet at that message and, when the
// conversation went back, puts the message into the session's draft (lib/drafts.ts); forking makes a
// new session on the server and opens it. A rewind's notice and a failure show in the strips above
// the composer (the web's notice and error boxes, MainScreen), a copy as a "Copied" toast (the web's
// button shows a check). Like the web, a request already sent goes through when the sheet closes or
// the session changes: the server has acted, so the draft and the notice still land.
import { useCallback, useEffect, useRef, useState, createElement } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { Text } from "./ui/Text.tsx";
import { CopyIcon, GitForkIcon, Undo2Icon, type LucideIcon } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { failureText as describeFailure, fetchRewindList, fetchRewindPreview, forkAt, rewindTo } from "../lib/messageApi.ts";
import { menuItems, registerMessageActions, type MenuAction, type MessageMenuRequest } from "../lib/messageActions.ts";
import type { Pairing } from "../lib/api.ts";
import { putBackRewound } from "../lib/drafts.ts";
import { choose, CLOSED, LOADING, listed, previewed, runnableMode, wantsPreview, type RewindFlow } from "../lib/rewindFlow.ts";
import { addToast, closeToast } from "../lib/toast.ts";
import { usePalette } from "../theme.ts";
import { Press } from "./Press.tsx";
import { RewindSheet } from "./RewindSheet.tsx";
import { ui } from "./ui/metrics.ts";
import { useChrome } from "./ui/useChrome.ts";

const MENU_ICON: Record<MenuAction, LucideIcon> = {
  copy: CopyIcon,
  rewind: Undo2Icon,
  fork: GitForkIcon,
};

export function MessageActions(props: {
  pairing: Pairing;
  /** The open session's key; null where the menu is not offered (no session, a subagent's transcript). */
  sessionKey: string | null;
  /** Opens a session in place of this one (the fork's result). */
  onOpenSession: (key: string) => void;
  /** A rewind's result text, for the notice box above the composer. */
  onNotice: (text: string) => void;
  /** A failure the sheet is no longer open to show, for the error box above the composer. */
  onError: (text: string) => void;
}) {
  const { pairing, sessionKey, onOpenSession, onNotice, onError } = props;
  const [menu, setMenu] = useState<MessageMenuRequest | null>(null);
  const [flow, setFlow] = useState<RewindFlow>(CLOSED);
  const [forking, setForking] = useState<ReadonlySet<string>>(new Set());
  /** The sheet's reads (list, preview): closing or reopening drops what is on its way. */
  const seq = useRef(0);
  /** Rewind requests: one sent goes through even if the sheet closes meanwhile (the server went back). */
  const reqSeq = useRef(0);

  useEffect(() => {
    if (sessionKey === null) return;
    return registerMessageActions({ key: sessionKey, open: setMenu });
  }, [sessionKey]);
  // A different session closes what was open for the old one.
  useEffect(() => {
    return () => {
      seq.current++;
      setMenu(null);
      setFlow(CLOSED);
    };
  }, [sessionKey]);

  const closeRewind = useCallback(() => {
    seq.current++;
    setFlow(CLOSED);
  }, []);

  const startRewind = (targetId: string) => {
    if (sessionKey === null) return;
    const key = sessionKey;
    const mine = ++seq.current;
    setFlow(LOADING);
    fetchRewindList(pairing, key).then(
      (list) => {
        if (seq.current !== mine) return;
        const next = listed(list, targetId);
        setFlow(next);
        // The code's dry run, when the code can go back: the CLI's numbers on the confirm step.
        if (wantsPreview(next)) {
          fetchRewindPreview(pairing, key, targetId).then(
            (preview) => {
              if (seq.current !== mine) return;
              setFlow((cur) => (cur.target?.id === targetId ? previewed(cur, preview) : cur));
            },
            () => {
              // Without the dry run the sheet names the files (restoreShown).
            },
          );
        }
      },
      (err: unknown) => {
        if (seq.current !== mine) return;
        setFlow({ ...CLOSED, open: true, error: describeFailure(err) });
      },
    );
  };

  const runRewind = () => {
    const mode = runnableMode(flow);
    if (sessionKey === null || !flow.target || mode === null) return;
    const key = sessionKey;
    const id = flow.target.id;
    const mine = ++reqSeq.current;
    const sheet = seq.current;
    setFlow({ ...flow, running: mode, error: null });
    rewindTo(pairing, key, id, mode).then(
      (result) => {
        if (reqSeq.current !== mine) return;
        // The draft and the notice also when the sheet was closed meanwhile: the server went back.
        if (result.prefill !== null) putBackRewound(key, result.prefill);
        if (seq.current === sheet) setFlow(CLOSED);
        onNotice(result.notice);
      },
      (err: unknown) => {
        if (reqSeq.current !== mine) return;
        if (seq.current !== sheet) {
          onError(describeFailure(err));
          return;
        }
        setFlow((cur) => ({ ...cur, running: null, error: describeFailure(err) }));
      },
    );
  };

  const startFork = (targetId: string) => {
    if (sessionKey === null || forking.has(sessionKey)) return;
    const key = sessionKey;
    setForking((s) => new Set([...s, key]));
    // The web shows this on the fork button; a menu that closed has no button, so a toast says it.
    const working = addToast({ type: "loading", title: "Forking" });
    forkAt(pairing, key, targetId)
      .then(
        (result) => {
          // A name that could not be set leaves the fork with the name the provider gave it.
          if (result.notice) console.warn(result.notice);
          onOpenSession(result.key);
        },
        (err: unknown) => onError(describeFailure(err)),
      )
      .finally(() => {
        closeToast(working);
        setForking((s) => new Set([...s].filter((k) => k !== key)));
      });
  };

  const act = (action: MenuAction) => {
    const m = menu;
    setMenu(null);
    if (!m) return;
    if (action === "copy") void Clipboard.setStringAsync(m.text).then(() => addToast({ type: "success", title: "Copied" }));
    else if (action === "rewind") startRewind(m.targetId);
    else startFork(m.targetId);
  };

  return (
    <>
      <MessageMenuSheet
        menu={menu}
        forking={sessionKey !== null && forking.has(sessionKey)}
        onClose={() => setMenu(null)}
        onPick={act}
      />
      <RewindSheet
        flow={flow}
        onClose={closeRewind}
        onChoose={(value) => setFlow((cur) => choose(cur, value))}
        onRun={runRewind}
      />
    </>
  );
}

/**
 * The menu: the web's three buttons under a message (copy, rewind, fork) as the web's Menu draws its
 * items (ui/menu.tsx, touch density: 40 high, px-2, text-base, an 18 icon in the muted color at 80%),
 * in a bottom sheet because a phone has no anchor to open it at. The pressed message's first lines
 * head it as a menu group label does (text-xs, muted), since the sheet covers the message.
 */
function MessageMenuSheet(props: { menu: MessageMenuRequest | null; forking: boolean; onClose: () => void; onPick: (a: MenuAction) => void }) {
  const p = usePalette();
  const c = useChrome();
  const insets = useSafeAreaInsets();
  const { menu } = props;
  const items = menu ? menuItems({ hasText: menu.text.trim() !== "", forking: props.forking }) : [];
  return (
    <Modal visible={menu !== null} animationType="slide" transparent onRequestClose={props.onClose}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: c.backdrop }]} onPress={props.onClose} accessibilityLabel="Close" />
      <View style={styles.wrap} pointerEvents="box-none">
        <View style={[styles.sheet, { backgroundColor: p.bg, borderTopColor: c.sheetBorder, paddingBottom: 4 + insets.bottom }]}>
          {menu?.text.trim() ? (
            <Text numberOfLines={2} style={[ui.xs, { color: p.muted, fontWeight: "500", paddingHorizontal: 8, paddingVertical: 6 }]}>{menu.text.trim()}</Text>
          ) : null}
          {items.map((it) => (
            <Press
              key={it.action}
              onPress={() => props.onPick(it.action)}
              disabled={it.disabled !== null}
              accessibilityRole="button"
              accessibilityLabel={it.label}
              accessibilityState={{ disabled: it.disabled !== null }}
              android_ripple={{ color: c.accent, foreground: true }}
              style={[styles.item, it.disabled ? { opacity: 0.64 } : null]}
            >
              {createElement(MENU_ICON[it.action], { size: 18, color: p.muted, style: { opacity: 0.8 } })}
              <Text style={[ui.base, { color: p.text, flex: 1 }]}>{it.label}</Text>
              {it.disabled ? <Text style={[ui.xs, { color: p.muted }]}>{it.disabled}</Text> : null}
            </Press>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "flex-end" },
  // The dialog's phone sheet edge (square, top border only) with the menu's p-1.
  sheet: { borderTopWidth: 1, padding: 4, gap: 0 },
  // MenuItem density touch: min-h-10, gap-2, px-2, rounded-sm.
  item: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, overflow: "hidden" },
});
