// The app's live state from /ws: the chosen sessions and Groups (hello, index, projects), the
// questions sessions wait on, and one open thread. The thread reducer and the session grouping are
// the web's own (apps/web/src/threadState.ts, model.ts), shared by relative import.
import { useCallback, useEffect, useReducer, useState } from "react";
import { THREAD_FIRST_ROWS, THREAD_OLDER_ROWS } from "@maru/shared";
import type { ClientMessage, PendingQuestionView, PendingSend, Project, ServerMessage, SessionSummary, UsageSnapshot } from "@maru/shared";
import { initialThreadState, threadReducer, type ThreadViewState } from "../../../web/src/threadState.ts";
import { withFolded } from "../../../web/src/model.ts";
import { setGroupFolded, type Pairing } from "./api.ts";
import type { Connection, ConnectionState } from "./connection.ts";

export interface MaruState {
  connection: ConnectionState;
  /** false until the first hello. */
  loaded: boolean;
  sessions: Map<string, SessionSummary>;
  projects: Project[];
  pending: Map<string, PendingQuestionView[]>;
  /** Messages sent that the model has not taken in yet, by session (DESIGN.md 4.4). */
  queued: Map<string, readonly PendingSend[]>;
  /** The folded sidebar folders (fold keys, DESIGN.md 6v): the server's list, shared by every client. */
  folded: ReadonlySet<string>;
  /** Folds or unfolds one folder: shown at once, sent as that one key, and settled by the server's list. */
  setFolded: (key: string, folded: boolean) => void;
  /** The account usage gauges (DESIGN.md 6a), after connect and on every change. */
  usage: UsageSnapshot | null;
  /** The last failed drive command (send, interrupt), for a short notice. */
  lastError: { at: number; threadId: string | null; reqId: string | null; error: string } | null;
}

export function useMaru(conn: Connection, pairing: Pairing): MaruState {
  const [connection, setConnection] = useState<ConnectionState>(conn.state);
  const [sessions, setSessions] = useState<Map<string, SessionSummary>>(new Map());
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<Map<string, PendingQuestionView[]>>(new Map());
  const [queued, setQueued] = useState<Map<string, readonly PendingSend[]>>(new Map());
  const [lastError, setLastError] = useState<MaruState["lastError"]>(null);
  const [folded, setFoldedState] = useState<ReadonlySet<string>>(new Set());
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);

  useEffect(() => conn.onState(setConnection), [conn]);
  useEffect(
    () =>
      conn.onMessage((msg: ServerMessage) => {
        switch (msg.type) {
          case "hello":
            setSessions(new Map(msg.sessions.map((s) => [s.key, s])));
            setProjects(msg.projects);
            // A server built before the folds were kept there sends no list.
            if (msg.foldedGroups) setFoldedState(new Set(msg.foldedGroups));
            // The server resends every question still waiting right after hello (as the web's
            // lib/pending.ts relies on); anything else was answered or ended while away.
            setPending(new Map());
            setLoaded(true);
            // The server sends every list again after hello.
            setQueued(new Map());
            break;
          case "index":
            setSessions((prev) => {
              const next = new Map(prev);
              if (msg.event.type === "upsert") next.set(msg.event.session.key, msg.event.session);
              else next.delete(msg.event.key);
              return next;
            });
            break;
          case "projects":
            setProjects(msg.projects);
            break;
          case "foldedGroups":
            setFoldedState(new Set(msg.keys));
            break;
          case "usage":
            // An older snapshot (a reply that overtook a newer broadcast) does not replace a newer one.
            setUsage((prev) => (prev && msg.snapshot.generatedAt < prev.generatedAt ? prev : msg.snapshot));
            break;
          case "session.pending":
            setPending((prev) => {
              const next = new Map(prev);
              if (msg.questions.length) next.set(msg.key, msg.questions);
              else next.delete(msg.key);
              return next;
            });
            break;
          case "session.queued":
            setQueued((prev) => {
              const next = new Map(prev);
              if (msg.sends.length) next.set(msg.key, msg.sends);
              else next.delete(msg.key);
              return next;
            });
            break;
          case "command.error":
            // A failed session.create answers its own sheet (createSession).
            if (msg.reqId?.startsWith("create-")) break;
            setLastError({ at: Date.now(), threadId: msg.threadId ?? null, reqId: msg.reqId ?? null, error: msg.error });
            break;
        }
      }),
    [conn],
  );

  const setFolded = useCallback(
    (key: string, value: boolean) => {
      setFoldedState((prev) => withFolded(prev, key, value));
      setGroupFolded(pairing, { key, folded: value }).catch(() => {
        // Not saved: the folder goes back to what it was, unless the server's list already said otherwise.
        setFoldedState((prev) => withFolded(prev, key, !value));
      });
    },
    [pairing],
  );
  return { connection, loaded, sessions, projects, pending, queued, folded, setFolded, usage, lastError };
}

let seq = 0;
/** A request id for a drive command, so its command.error can be told apart. */
export function nextReqId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

/**
 * Starts a session (DESIGN.md 6f, `session.create`). Resolves with its key once the CLI reported
 * the session id (`session.created`), or rejects with the server's `command.error`. The server
 * answers on the socket the request came in, so when that socket closes first (a drop, the app
 * going to the background) no answer can come: it rejects then, saying the session may exist.
 */
export function createSession(conn: Connection, input: Omit<Extract<ClientMessage, { type: "session.create" }>, "type" | "reqId">): Promise<string> {
  const reqId = nextReqId("create");
  return new Promise((resolve, reject) => {
    const done = () => {
      offMsg();
      offState();
    };
    const offMsg = conn.onMessage((msg) => {
      if (msg.type === "session.created" && msg.reqId === reqId) {
        done();
        resolve(msg.key);
      } else if (msg.type === "command.error" && msg.reqId === reqId) {
        done();
        reject(new Error(msg.error));
      }
    });
    const offState = conn.onState((s) => {
      if (s === "open") return;
      done();
      reject(new Error("The server disconnected while waiting. The session may already exist, so check the list"));
    });
    if (!conn.send({ type: "session.create", reqId, ...input })) {
      done();
      reject(new Error("Could not create the session, disconnected from server"));
    }
  });
}

/**
 * One thread kept live: subscribe on open and on every reconnect, unsubscribe on leave. The
 * subscription is windowed as the web's (DESIGN.md 6r): the newest rows first, older ones as the
 * reader scrolls up or a find steps to them (`thread.older`).
 */
export function useThread(conn: Connection, threadId: string | null): LiveThread | null {
  const [state, dispatch] = useReducer(threadReducer, threadId ?? "", initialThreadState);

  useEffect(() => {
    if (!threadId) return;
    dispatch({ type: "reset", threadId });
    const subscribe = () => conn.send({ type: "thread.subscribe", threadId, rows: THREAD_FIRST_ROWS });
    const offMsg = conn.onMessage((msg) => {
      if (msg.type === "thread.snapshot") dispatch({ type: "snapshot", snapshot: msg.snapshot });
      else if (msg.type === "thread.events") dispatch({ type: "events", threadId: msg.threadId, events: msg.events });
      else if (msg.type === "thread.error") dispatch({ type: "error", threadId: msg.threadId, error: msg.error });
      else if (msg.type === "thread.older") dispatch({ type: "older", older: msg.older });
    });
    const offOpen = conn.onOpen(subscribe);
    subscribe();
    return () => {
      offMsg();
      offOpen();
      conn.send({ type: "thread.unsubscribe", threadId });
    };
  }, [conn, threadId]);

  const canLoadOlder = threadId !== null && !state.loadingOlder && state.snapshot?.hasMoreBefore === true;
  const loadOlder = useCallback(() => {
    if (!threadId || !canLoadOlder) return;
    if (conn.send({ type: "thread.loadOlder", threadId, rows: THREAD_OLDER_ROWS })) dispatch({ type: "loadOlderRequested", threadId });
  }, [conn, threadId, canLoadOlder]);
  /** Older rows until item `itemId` is among them (a find's step, DESIGN.md 6u). False when no request went out. */
  const loadOlderUntil = useCallback(
    (itemId: string): boolean => {
      if (!threadId || !canLoadOlder) return false;
      if (!conn.send({ type: "thread.loadOlder", threadId, rows: THREAD_OLDER_ROWS, until: itemId })) return false;
      dispatch({ type: "loadOlderRequested", threadId });
      return true;
    },
    [conn, threadId, canLoadOlder],
  );
  return threadId && state.threadId === threadId ? { ...state, loadOlder, loadOlderUntil } : null;
}

export type LiveThread = ThreadViewState & { loadOlder: () => void; loadOlderUntil: (itemId: string) => boolean };
