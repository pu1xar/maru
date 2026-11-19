// The rewind screen's state (DESIGN.md 6o): the message list, the picked message and its options,
// and the request. The chat composer and the terminal input each hold one for their session and
// draw it their way (components/chat/RewindDialog.tsx, components/terminal/TerminalRewind.tsx);
// the rules are rewind.logic.ts.
//
// The timeline's Rewind button on a message asks the session's composer to open the screen at
// that message (openRewind). A composer that can take such a request registers for its session
// key, and the button shows only where one is registered (a subagent's view has none).
import type { RewindMode, RewindTarget, SessionRewindList, SessionRewindPreview, SessionRewindResult } from "@maru/shared";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { describeError, fetchRewindPreview, fetchSessionRewind, rewindSession } from "~/projectsApi";
import { getComposerDraft, setComposerDraft } from "./composerDraft";
import { defaultOption, draftAfterRewind, rewindOptions, type RewindChoice, type RewindOption } from "./rewind.logic";

// ---- open requests ----

type OpenHandler = (targetId: string | null) => void;
const handlers = new Map<string, Set<OpenHandler>>();
const presence = new Set<() => void>();

function notifyPresence(): void {
  for (const l of [...presence]) l();
}

/**
 * Asks the session's composer to open the rewind screen, at a message when `targetId` is given.
 * The newest composer of the session takes it, so two composers never open two screens.
 */
export function openRewind(key: string, targetId: string | null = null): void {
  const list = [...(handlers.get(key) ?? [])];
  list.at(-1)?.(targetId);
}

/** Whether a composer that opens the rewind screen is on the page for this session. */
export function useCanRewind(key: string): boolean {
  return useSyncExternalStore(
    (l) => {
      presence.add(l);
      return () => presence.delete(l);
    },
    () => (handlers.get(key)?.size ?? 0) > 0,
    () => false,
  );
}

function useOpenRequests(key: string, enabled: boolean, handler: OpenHandler): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const h: OpenHandler = (id) => ref.current(id);
    let set = handlers.get(key);
    if (!set) handlers.set(key, (set = new Set()));
    set.add(h);
    notifyPresence();
    return () => {
      set.delete(h);
      if (set.size === 0) handlers.delete(key);
      notifyPresence();
    };
  }, [key, enabled]);
}

// ---- the screen ----

export interface RewindScreenState {
  open: boolean;
  step: "pick" | "confirm";
  list: SessionRewindList | null;
  loading: boolean;
  error: string | null;
  /** Row in the pick step: a target's index, or targets.length for the "(current)" row. */
  active: number;
  target: RewindTarget | null;
  /** Opened at a message (the timeline's button): Esc from the options closes the screen, as the CLI's preselected message does. */
  preselected: boolean;
  options: RewindOption[];
  option: number;
  running: RewindMode | null;
  /** The dry run for the picked message's code (null until read, or when there is none). */
  preview: SessionRewindPreview | null;
}

const CLOSED: RewindScreenState = {
  open: false, step: "pick", list: null, loading: false, error: null, active: 0, target: null, preselected: false, options: [], option: 0, running: null, preview: null,
};

export interface RewindScreen {
  state: RewindScreenState;
  /** Opens the list (or the options of `targetId` once the list is read). */
  open: (targetId?: string | null) => void;
  close: () => void;
  /** Moves the row (pick) or the option (confirm). */
  move: (delta: number) => void;
  setActive: (index: number) => void;
  setOption: (index: number) => void;
  /** Enter: the row's message (or close on "(current)"), or the focused option. */
  enter: () => void;
  pick: (index: number) => void;
  choose: (value: RewindChoice) => void;
  /** Esc: back from the options to the list, or close. */
  escape: () => void;
}

/**
 * One session's rewind screen. `onDone` hears the result (the composer shows its notice); a
 * conversation rewind puts the message back into the session's draft first.
 */
export function useRewindScreen(sessionKey: string, opts: { enabled: boolean; onDone: (result: SessionRewindResult) => void }): RewindScreen {
  const [state, setState] = useState<RewindScreenState>(CLOSED);
  /** The screen's reads (list, preview); closing or reopening drops what is on its way. */
  const seq = useRef(0);
  /** Rewind requests: one sent goes through even if the screen closes meanwhile (the server went back). */
  const reqSeq = useRef(0);
  const onDone = useRef(opts.onDone);
  onDone.current = opts.onDone;

  const toConfirm = (s: RewindScreenState, target: RewindTarget, preselected: boolean): RewindScreenState => {
    const options = rewindOptions(target, s.list?.blocked ?? null);
    // The code's dry run, when the code can go back: the CLI's numbers on its confirm screen.
    if (target.code.enabled && !s.list?.blocked) {
      const mine = seq.current;
      fetchRewindPreview(sessionKey, target.id).then(
        (preview) => {
          setState((cur) => {
            if (seq.current !== mine || cur.target?.id !== target.id || cur.step !== "confirm") return cur;
            const next = rewindOptions(target, cur.list?.blocked ?? null, preview);
            const keep = next[cur.option]?.enabled ? cur.option : defaultOption(next);
            return { ...cur, preview, options: next, option: keep };
          });
        },
        () => {
          // Without the dry run the screen names the files (restoreShown).
        },
      );
    }
    return { ...s, step: "confirm", target, preselected, options, option: defaultOption(options), error: null, preview: null };
  };

  const open = useCallback((targetId: string | null = null) => {
    const mine = ++seq.current;
    setState({ ...CLOSED, open: true, loading: true });
    fetchSessionRewind(sessionKey).then(
      (list) => {
        if (seq.current !== mine) return;
        const base: RewindScreenState = { ...CLOSED, open: true, list, active: list.targets.length };
        const target = targetId === null ? undefined : list.targets.find((t) => t.id === targetId);
        if (target) setState(toConfirm(base, target, true));
        else setState(targetId !== null ? { ...base, error: "This message is not in the conversation now, pick one from the list" } : base);
      },
      (err: unknown) => {
        if (seq.current !== mine) return;
        setState((s) => ({ ...s, loading: false, error: describeError(err) }));
      },
    );
  }, [sessionKey]);

  const close = useCallback(() => {
    seq.current++;
    setState(CLOSED);
  }, []);

  useOpenRequests(sessionKey, opts.enabled, open);
  // A different session closes the screen.
  useEffect(() => close, [sessionKey, close]);

  const choose = (value: RewindChoice) => {
    const s = state;
    if (!s.target || s.running) return;
    if (value === "nevermind") {
      if (s.preselected) close();
      else setState({ ...s, step: "pick", target: null, error: null });
      return;
    }
    const opt = s.options.find((o) => o.value === value);
    if (!opt?.enabled) {
      setState({ ...s, error: opt?.reason ?? "Not available right now" });
      return;
    }
    const mine = ++reqSeq.current;
    const screen = seq.current;
    setState({ ...s, running: value, error: null });
    rewindSession({ key: sessionKey, id: s.target.id, mode: value }).then(
      (result) => {
        if (reqSeq.current !== mine) return;
        // The draft and the notice also when the screen was closed meanwhile: the server went back.
        if (result.prefill !== null) setComposerDraft(sessionKey, draftAfterRewind(getComposerDraft(sessionKey), result.prefill));
        if (seq.current === screen) setState(CLOSED);
        onDone.current(result);
      },
      (err: unknown) => {
        if (reqSeq.current !== mine || seq.current !== screen) return;
        setState((cur) => ({ ...cur, running: null, error: describeError(err) }));
      },
    );
  };

  const pick = (index: number) => {
    const s = state;
    if (!s.list || s.running) return;
    if (index >= s.list.targets.length) {
      close();
      return;
    }
    setState(toConfirm({ ...s, active: index }, s.list.targets[index]!, false));
  };

  const move = (delta: number) => {
    setState((s) => {
      if (s.running) return s;
      if (s.step === "pick") {
        const max = s.list ? s.list.targets.length : 0;
        return { ...s, active: Math.max(0, Math.min(max, s.active + delta)) };
      }
      return { ...s, option: Math.max(0, Math.min(s.options.length - 1, s.option + delta)) };
    });
  };

  const enter = () => {
    if (state.step === "pick") pick(state.active);
    else {
      const opt = state.options[state.option];
      if (opt) choose(opt.value);
    }
  };

  const escape = () => {
    if (state.running) return;
    if (state.step === "confirm" && !state.preselected) setState({ ...state, step: "pick", target: null, error: null });
    else close();
  };

  return {
    state,
    open,
    close,
    move,
    setActive: (index) => setState((s) => (s.step === "pick" ? { ...s, active: index } : s)),
    setOption: (index) => setState((s) => (s.step === "confirm" ? { ...s, option: index } : s)),
    enter,
    pick,
    choose,
    escape,
  };
}
