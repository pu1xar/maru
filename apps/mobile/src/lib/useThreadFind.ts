// Find in the open conversation (DESIGN.md 6u), the app's twin of the web's useThreadFind. The
// query goes to the server (`thread.search`), which searches the whole thread, also the rows this
// app does not hold yet, and answers with every matching item. A step to an occurrence whose item
// is not held grows the window to it first (`thread.loadOlder` with `until`); once held, the
// timeline scrolls to its row and paints the occurrences (components/timeline/useFindScroll.ts).
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { FindHint, FindTarget, ThreadSnapshot } from "@maru/shared";
import {
  findTargets,
  hasSearchText,
  hintedFindIndex,
  initialFindIndex,
  stepFindIndex,
} from "../../../../packages/shared/src/threadSearch.ts";
import type { Connection } from "./connection.ts";
import {
  findAnchor,
  findStep,
  itemOrder,
  type FindStatus,
  type FindVisible,
  type TimelineFind,
} from "./threadFind.ts";

/** How long typing pauses before the query goes to the server, ms. */
const SEARCH_DELAY_MS = 200;

let reqSeq = 0;

/** What the find bar shows and does. */
export interface FindBarState {
  query: string;
  total: number;
  index: number;
  status: FindStatus;
  error: string | null;
  /** The current occurrence is not in the thread any more (rewritten since the search). */
  missing: boolean;
  /** Bumped by every open, so a bar that is open takes the keyboard again. */
  focusSeq: number;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export interface ThreadFind {
  open: boolean;
  bar: FindBarState | null;
  /** For the timeline: the query to paint and the step to show. Null while closed or before an answer. */
  timeline: TimelineFind | null;
  /** Opens find; with `query`, searches it at once, starting at `hint`. */
  openFind: (start?: { query: string; hint?: FindHint }) => void;
  /** The timeline writes what is on screen here. */
  visibleRef: MutableRefObject<FindVisible>;
}

export function useThreadFind(opts: {
  conn: Connection;
  threadId: string | null;
  snapshot: ThreadSnapshot | null;
  loadingOlder: boolean;
  loadOlderUntil: (itemId: string) => boolean;
  /** The server holds this thread's subscription (the connection is open and a snapshot came): it answers a search. */
  ready: boolean;
}): ThreadFind {
  const { conn, threadId, snapshot, loadingOlder, loadOlderUntil, ready } = opts;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusSeq, setFocusSeq] = useState(0);
  const [status, setStatus] = useState<FindStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [targets, setTargets] = useState<readonly FindTarget[]>([]);
  const [searchedQuery, setSearchedQuery] = useState("");
  const [index, setIndex] = useState(0);
  // Every search answer and every step: the timeline scrolls once per value.
  const [navSeq, setNavSeq] = useState(0);
  const [missing, setMissing] = useState(false);
  const pendingReq = useRef<string | null>(null);
  const hintRef = useRef<FindHint | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const visibleRef = useRef<FindVisible>({ ids: [], atEnd: true });
  /** The step (navSeq) whose older rows were asked for: one request per step. */
  const requestedFor = useRef<number | null>(null);

  const reset = useCallback(() => {
    pendingReq.current = null;
    hintRef.current = null;
    requestedFor.current = null;
    setTargets([]);
    setSearchedQuery("");
    setIndex(0);
    setStatus("idle");
    setError(null);
    setMissing(false);
  }, []);

  // Another thread (a subagent opened from a card) starts without a find.
  useEffect(() => {
    setOpen(false);
    setQuery("");
    reset();
  }, [threadId, reset]);

  const send = useCallback(
    (q: string) => {
      if (!threadId) return;
      const reqId = `${Date.now().toString(36)}:${++reqSeq}`;
      pendingReq.current = reqId;
      if (!conn.send({ type: "thread.search", threadId, query: q, reqId })) {
        pendingReq.current = null;
        setStatus("error");
        setError("Not connected to the server");
      }
    },
    [conn, threadId],
  );

  // The query goes out once typing pauses; an empty one clears the result.
  useEffect(() => {
    if (!open) return;
    if (!hasSearchText(query)) {
      reset();
      return;
    }
    if (query === searchedQuery && status !== "error") return;
    setStatus("searching");
    // Until the server holds the subscription the search waits.
    if (!ready) return;
    const timer = setTimeout(() => send(query), hintRef.current ? 0 : SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
    // searchedQuery and status only gate a repeat of the same query.
  }, [open, query, send, reset, ready]);

  useEffect(
    () =>
      conn.onMessage((msg) => {
        if (msg.type !== "thread.searchResult" || msg.result.reqId !== pendingReq.current) return;
        pendingReq.current = null;
        const result = msg.result;
        setSearchedQuery(result.query);
        requestedFor.current = null;
        setMissing(false);
        if (result.error) {
          setTargets([]);
          setStatus("error");
          setError(result.error);
          return;
        }
        const list = findTargets(result);
        const hint = hintRef.current;
        hintRef.current = null;
        let start: number;
        if (hint) {
          start = Math.max(0, hintedFindIndex(list, hint));
        } else {
          const order = itemOrder(snapshotRef.current);
          const seen = visibleRef.current;
          start = initialFindIndex(list, (id) => order.byItem.get(id), findAnchor(seen.ids, seen.atEnd, order.byEntry));
        }
        setTargets(list);
        setIndex(start);
        setStatus("idle");
        setError(null);
        setNavSeq((n) => n + 1);
      }),
    [conn],
  );

  const target = status === "idle" && open ? (targets[index] ?? null) : null;
  const step = target ? findStep(snapshot, target, loadingOlder) : null;

  // A step to an item this app does not hold: older rows until it, once per step. A request that
  // ended without the item (the server read the thread's start) leaves the step missing.
  useEffect(() => {
    if (!step || step.kind !== "load") return;
    if (requestedFor.current === navSeq) {
      setMissing(true);
      return;
    }
    if (loadOlderUntil(step.itemId)) requestedFor.current = navSeq;
  }, [step?.kind, step?.kind === "load" ? step.itemId : null, navSeq, loadOlderUntil]);
  useEffect(() => {
    if (step?.kind === "missing") setMissing(true);
    else if (step?.kind === "show") setMissing(false);
  }, [step?.kind]);

  const go = useCallback(
    (delta: number) => {
      if (targets.length === 0) return;
      setIndex((i) => stepFindIndex(i, targets.length, delta));
      setMissing(false);
      setNavSeq((n) => n + 1);
    },
    [targets.length],
  );

  const close = useCallback(() => {
    setOpen(false);
    reset();
    setQuery("");
  }, [reset]);

  const openFind = useCallback((start?: { query: string; hint?: FindHint }) => {
    setOpen(true);
    setFocusSeq((n) => n + 1);
    if (start && hasSearchText(start.query)) {
      hintRef.current = start.hint ?? null;
      setSearchedQuery("");
      setQuery(start.query);
    }
  }, []);

  const showEntry = step?.kind === "show" ? step.entryId : null;
  const timeline = useMemo<TimelineFind | null>(() => {
    if (!open || !hasSearchText(searchedQuery)) return null;
    return {
      query: searchedQuery,
      target: target && showEntry !== null ? { entryId: showEntry, occurrence: target.occurrence, seq: navSeq } : null,
    };
  }, [open, searchedQuery, target?.occurrence, showEntry, navSeq]);

  const bar: FindBarState | null = open
    ? {
        query,
        total: targets.length,
        index,
        status,
        error,
        missing,
        focusSeq,
        onQueryChange: setQuery,
        onNext: () => go(1),
        onPrevious: () => go(-1),
        onClose: close,
      }
    : null;

  return { open, bar, timeline, openFind, visibleRef };
}
