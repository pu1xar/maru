// Find in the open thread (DESIGN.md 6u). The query goes to the server, which searches the whole
// thread (also the rows this page does not hold) and answers with every matching item. A step to
// an occurrence whose item is not held grows the window to it first (thread.loadOlder `until`);
// once held, the timeline scrolls to its row and paints the occurrences (MessagesTimeline `find`).
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { FindHint, FindTarget, ThreadSnapshot } from "@maru/shared";
import { findTargets, hasSearchText, hintedFindIndex, initialFindIndex, stepFindIndex } from "@maru/shared";

import { socketHub } from "~/lib/socket";
import type { ThreadFindBarProps } from "./ThreadFindBar";
import { findStep, itemOrder } from "./threadFind.logic";

/** How long typing pauses before the query goes to the server, ms. */
const SEARCH_DELAY_MS = 200;

/** The occurrence the timeline shows: the `occurrence`th one in entry `entryId`. `seq` changes with every step. */
export interface FindTimelineTarget {
  readonly entryId: string;
  readonly occurrence: number;
  readonly seq: number;
}

/** What the timeline gets while find is open. */
export interface FindTimelineProps {
  readonly query: string;
  readonly target: FindTimelineTarget | null;
}


let reqSeq = 0;

/**
 * The lowest message row on screen, as its place in the thread, or null when the timeline sits at
 * its end (a find then starts at the newest occurrence).
 */
function readAnchor(canvas: HTMLElement | null, byEntry: Map<string, number>): number | null {
  const scroller = canvas?.querySelector<HTMLElement>(".messages-timeline-scroll");
  if (!scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4) return null;
  const bottom = scroller.getBoundingClientRect().bottom;
  let anchor: number | null = null;
  for (const row of scroller.querySelectorAll<HTMLElement>("[data-message-id]")) {
    if (row.getBoundingClientRect().top >= bottom) continue;
    const at = byEntry.get(row.dataset.messageId ?? "");
    if (at !== undefined && (anchor === null || at > anchor)) anchor = at;
  }
  return anchor;
}

export function useThreadFind(opts: {
  threadId: string;
  snapshot: ThreadSnapshot | null;
  loadingOlder: boolean;
  loadOlderUntil: (itemId: string) => boolean;
  canvasRef: RefObject<HTMLElement | null>;
  /** The server holds this page's subscription (a snapshot came, not only the kept one): it answers a search. */
  ready: boolean;
}): {
  open: boolean;
  bar: ThreadFindBarProps | null;
  timeline: FindTimelineProps | null;
  /** Opens find (or takes the keyboard again); with `query`, searches it at once, starting at `hint`. */
  openFind: (start?: { query: string; hint?: FindHint }) => void;
} {
  const { threadId, snapshot, loadingOlder, loadOlderUntil, canvasRef, ready } = opts;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusSeq, setFocusSeq] = useState(0);
  const [status, setStatus] = useState<"idle" | "searching" | "error">("idle");
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

  const send = useCallback((q: string) => {
    const reqId = `${Date.now().toString(36)}:${++reqSeq}`;
    pendingReq.current = reqId;
    if (!socketHub().send({ type: "thread.search", threadId, query: q, reqId })) {
      pendingReq.current = null;
      setStatus("error");
      setError("Not connected to the server");
    }
  }, [threadId]);

  // The query goes out once typing pauses; an empty one clears the result.
  useEffect(() => {
    if (!open) return;
    if (!hasSearchText(query)) {
      reset();
      return;
    }
    if (query === searchedQuery && status !== "error") return;
    setStatus("searching");
    // Until the server holds the subscription the search waits (a conversation just opened, or one
    // that came back with its kept rows and waits for the server's answer).
    if (!ready) return;
    const timer = setTimeout(() => send(query), hintRef.current ? 0 : SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
    // searchedQuery and status only gate a repeat of the same query.
  }, [open, query, send, reset, ready]);

  useEffect(() => {
    return socketHub().onMessage((msg) => {
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
        start = initialFindIndex(list, (id) => order.byItem.get(id), readAnchor(canvasRef.current, order.byEntry));
      }
      setTargets(list);
      setIndex(start);
      setStatus("idle");
      setError(null);
      setNavSeq((n) => n + 1);
    });
  }, [canvasRef]);

  const target = status === "idle" && open ? (targets[index] ?? null) : null;
  const step = target ? findStep(snapshot, target, loadingOlder) : null;

  // A step to an item this page does not hold: older rows until it, once per step. A request that
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

  const go = useCallback((delta: number) => {
    if (targets.length === 0) return;
    setIndex((i) => stepFindIndex(i, targets.length, delta));
    setMissing(false);
    setNavSeq((n) => n + 1);
  }, [targets.length]);

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
  const timeline = useMemo<FindTimelineProps | null>(() => {
    if (!open || !hasSearchText(searchedQuery)) return null;
    return {
      query: searchedQuery,
      target: target && showEntry !== null ? { entryId: showEntry, occurrence: target.occurrence, seq: navSeq } : null,
    };
  }, [open, searchedQuery, target?.occurrence, showEntry, navSeq]);

  const bar: ThreadFindBarProps | null = open
    ? {
        query, total: targets.length, index, status, error, missing, focusSeq,
        onQueryChange: setQuery,
        onNext: () => go(1),
        onPrevious: () => go(-1),
        onClose: close,
      }
    : null;

  return { open, bar, timeline, openFind };
}
