// The composer's pickers for /model and its kin (DESIGN.md 6m), as one hook both composers use:
// the chat composer (components/chat/ThreadComposer.tsx, drawn by components/chat/SessionPicker.tsx)
// and the terminal mode's (components/terminal/TerminalSessionPicker.tsx). The keys come from the
// composer's textarea, which keeps the focus (as with the `/` menu; pickerKey in
// sessionPicker.logic.ts): ↑ ↓ move, ← → change the model picker's effort, Enter picks, Esc goes
// back a level or closes. Picking sends `thread.configure`; the server answers with
// `command.result` (a notice) or `command.error`, which the composer's useCommandFeedback shows.
import type {
  SessionMcpResponse, SessionModelsResponse, SessionPickerKind, SessionSummary, ThreadProjectionState,
} from "@maru/shared";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from "react";

import { useThreadWhile } from "../useThread";
import { storeModelOptions } from "./modelOptionsCache";
import { socketHub } from "./socket";
import {
  INITIAL_PICKER_LOAD, effortStart, effortSteps, initialRow, modelChange, pickerDataFor, pickerKey, pickerLoadReducer, pickerNeeds, pickerView,
  currentEffort, type PickerChange, type PickerRow, type PickerView,
} from "./sessionPicker.logic";

let seq = 0;
function reqId(): string {
  seq += 1;
  return `picker-${Date.now().toString(36)}-${seq}`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

export { interceptMessage, type ComposerIntercept } from "./sessionPicker.logic";

export interface SessionPicker {
  /** The open picker, or null. */
  kind: SessionPickerKind | null;
  view: PickerView | null;
  /** The list on screen: the picker's rows, or a row's second list (an MCP server's actions). */
  list: { title: string; rows: PickerRow[] } | null;
  loading: boolean;
  error: string | null;
  active: number;
  /** The model picker's effort step for the highlighted row (effortSteps), -1 when it takes none. */
  effortStep: number;
  open(kind: SessionPickerKind): void;
  close(): void;
  highlight(index: number): void;
  pick(index: number): void;
  stepEffort(delta: 1 | -1): void;
  /** Applies the highlighted model with this effort level at once (a click or tap on the effort strip). */
  pickEffort(level: string): void;
  /** Handles the composer's key while a picker is open; true when the key was the picker's. `digits`: 1 to 9 pick a row. */
  onKeyDown(event: KeyboardEvent<HTMLElement>, opts?: { digits?: boolean }): boolean;
}

/**
 * `state` is the open thread's state, or undefined for a composer that shows no thread (the
 * dashboard's): the picker then holds the thread itself while it is open, for the current values.
 */
export function useSessionPicker(
  session: SessionSummary,
  state: ThreadProjectionState | null | undefined,
  hooks: { onError: (message: string) => void; onSent?: () => void },
): SessionPicker {
  const [kind, setKind] = useState<SessionPickerKind | null>(null);
  const [load, dispatch] = useReducer(pickerLoadReducer, INITIAL_PICKER_LOAD);
  const seq = useRef(0);
  const [active, setActive] = useState(0);
  const [level, setLevel] = useState<{ title: string; rows: PickerRow[]; from: number } | null>(null);
  const [effort, setEffort] = useState<{ row: string | null; step: number; touched: boolean }>({ row: null, step: -1, touched: false });

  const held = useThreadWhile(state === undefined && kind !== null ? session.key : null);
  const threadState = state !== undefined ? state : held?.snapshot?.state ?? null;
  const waitingThread = held !== null && held.snapshot === null && held.error === null;

  const close = useCallback(() => {
    setKind(null);
    setLevel(null);
  }, []);

  // Another session: nothing stays open.
  useEffect(() => close(), [session.key, close]);

  const open = useCallback((next: SessionPickerKind) => {
    setKind(next);
    setLevel(null);
    setActive(-1);
    setEffort({ row: null, step: -1, touched: false });
    const need = pickerNeeds(next);
    const n = ++seq.current;
    dispatch({ type: "open", seq: n, key: session.key, need });
    if (!need) return;
    const url = need === "models"
      ? `/api/session-models?key=${encodeURIComponent(session.key)}`
      : `/api/session-mcp?key=${encodeURIComponent(session.key)}`;
    getJson<SessionModelsResponse | SessionMcpResponse>(url).then(
      (body) => {
        if (need === "models" && session.provider === "codex") storeModelOptions(session.key, (body as SessionModelsResponse).options);
        dispatch({ type: "loaded", seq: n, need, body });
      },
      (err: unknown) => dispatch({ type: "failed", seq: n, need, error: err instanceof Error ? err.message : String(err) }),
    );
  }, [session.key, session.provider]);

  const loading = kind !== null && load.key === session.key && (load.loading || waitingThread);
  const error = kind !== null && load.key === session.key ? load.error : null;
  const data = pickerDataFor(load, session.key);
  const view = useMemo(
    () => (kind && data && !waitingThread ? pickerView(kind, session.provider, threadState, data) : null),
    [kind, data, waitingThread, session.provider, threadState],
  );
  const list = level ?? (view ? { title: view.title, rows: view.rows } : null);
  const index = list && list.rows.length ? (active < 0 ? initialRow(list.rows) : Math.min(active, list.rows.length - 1)) : 0;
  const row = list?.rows[index];
  const option = kind === "model" && !level ? row?.option : undefined;
  const effortStep = option
    ? (effort.row === option.value ? effort.step : effortStart(session.provider, option, currentEffort(threadState)))
    : -1;

  const send = useCallback((change: PickerChange) => {
    const ok = socketHub().send({ type: "thread.configure", threadId: session.key, reqId: reqId(), ...change });
    if (!ok) hooks.onError("Disconnected from server, could not change");
    else hooks.onSent?.();
  }, [session.key, hooks]);

  const pick = useCallback((i: number) => {
    const r = list?.rows[i];
    if (!r || r.disabled) return;
    if (r.next) {
      setLevel({ ...r.next, from: i });
      setActive(-1);
      return;
    }
    if (!r.change) return;
    const change = kind === "model" && r.option
      ? modelChange(session.provider, r.option, effort.row === r.option.value ? effort.step : effortStart(session.provider, r.option, currentEffort(threadState)), effort.row === r.option.value && effort.touched)
      : r.change;
    send(change);
    close();
  }, [list, kind, session.provider, effort, threadState, send, close]);

  const stepEffort = useCallback((delta: 1 | -1) => {
    if (!option) return;
    const steps = effortSteps(session.provider, option);
    if (steps.length === 0) return;
    const from = effortStep < 0 ? 0 : effortStep;
    setEffort({ row: option.value, step: (from + delta + steps.length) % steps.length, touched: true });
  }, [option, session.provider, effortStep]);

  const pickEffort = useCallback((level: string) => {
    if (!option) return;
    const step = effortSteps(session.provider, option).indexOf(level);
    if (step < 0) return;
    send(modelChange(session.provider, option, step, true));
    close();
  }, [option, session.provider, send, close]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>, opts: { digits?: boolean } = {}): boolean => {
    if (!kind) return false;
    const action = pickerKey(
      event.key,
      { shift: event.shiftKey, alt: event.altKey, meta: event.metaKey, ctrl: event.ctrlKey, composing: event.nativeEvent.isComposing || event.keyCode === 229 },
      { rows: list?.rows.length ?? 0, index, nested: level !== null, effort: effortStep >= 0, digits: opts.digits === true },
    );
    if (!action) return false;
    event.preventDefault();
    if (action.type === "close") close();
    else if (action.type === "back") {
      setActive(level?.from ?? -1);
      setLevel(null);
    } else if (action.type === "move") setActive(action.to);
    else if (action.type === "effort") stepEffort(action.delta);
    else pick(action.index);
    return true;
  }, [kind, list, level, index, effortStep, close, stepEffort, pick]);

  return {
    kind, view, list, loading, error, active: index, effortStep, open, close,
    highlight: setActive, pick, stepEffort, pickEffort, onKeyDown,
  };
}
