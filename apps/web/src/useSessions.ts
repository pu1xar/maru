import { useEffect, useState, useSyncExternalStore } from "react";
import type { Project, SessionSummary } from "@maru/shared";

import {
  clearLegacyCollapsedGroups,
  readCollapsedGroupsCache,
  readLegacyCollapsedGroups,
  withFolded,
  writeCollapsedGroupsCache,
} from "./lib/collapsedGroups.ts";
import { socketHub, type Connection } from "./lib/socket.ts";
import { importGroupFolds, setGroupFolded } from "./projectsApi.ts";

export type { Connection };

/** The shared /ws connection state. */
export function useConnection(): Connection {
  const hub = socketHub();
  return useSyncExternalStore(hub.subscribeConnection, hub.getConnection);
}

/**
 * Live session index and project list over the shared /ws connection (lib/socket.ts). The server
 * resends a full `hello` after every reconnect. Project writes go over HTTP (projectsApi.ts) and
 * land here as the server's `projects` message and session upserts, so the server's values are
 * the only state.
 */
export function useSessions(): {
  sessions: Map<string, SessionSummary>;
  projects: Project[];
  connection: Connection;
  /** The first `hello` has arrived; before it, an empty list says nothing about the server's. */
  loaded: boolean;
  /** The folded sidebar folders (fold keys, DESIGN.md 6v): the server's list, shared by every client. */
  folded: ReadonlySet<string>;
  /** Folds or unfolds one folder: shown at once, sent as that one key, and settled by the server's list. */
  setFolded: (key: string, folded: boolean) => void;
} {
  const [sessions, setSessions] = useState<Map<string, SessionSummary>>(new Map());
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Until the server answers, the copy of its last list (first paint without a flash of open folders).
  const [folded, setFoldedState] = useState<ReadonlySet<string>>(readCollapsedGroupsCache);
  const adoptFolded = (keys: Iterable<string>) => {
    const next = new Set(keys);
    writeCollapsedGroupsCache(next);
    setFoldedState(next);
  };
  const connection = useConnection();

  useEffect(
    () =>
      socketHub().onMessage((msg) => {
        if (msg.type === "hello") {
          setSessions(new Map(msg.sessions.map((s) => [s.key, s])));
          // A server built before the projects contract sends no list.
          setProjects(msg.projects ?? []);
          setLoaded(true);
          if (msg.foldedGroups) {
            adoptFolded(msg.foldedGroups);
            // The list an earlier build kept in this browser goes to the server once; the server
            // takes it only while it holds none, and the answer is the list to show.
            const older = readLegacyCollapsedGroups();
            if (older) {
              importGroupFolds({ keys: older })
                .then((keys) => {
                  clearLegacyCollapsedGroups();
                  adoptFolded(keys);
                })
                .catch(() => {
                  // Server unreachable: the older list stays and goes with the next connect.
                });
            }
          }
        } else if (msg.type === "index") {
          const e = msg.event;
          setSessions((prev) => {
            const next = new Map(prev);
            if (e.type === "upsert") next.set(e.session.key, e.session);
            else next.delete(e.key);
            return next;
          });
        } else if (msg.type === "projects") {
          setProjects(msg.projects);
        } else if (msg.type === "foldedGroups") {
          adoptFolded(msg.keys);
        }
      }),
    [],
  );

  const setFolded = (key: string, value: boolean) => {
    setFoldedState((prev) => {
      const next = withFolded(prev, key, value);
      writeCollapsedGroupsCache(next);
      return next;
    });
    setGroupFolded({ key, folded: value }).catch(() => {
      // Not saved: the folder goes back to what it was, unless the server's list already said otherwise.
      setFoldedState((prev) => {
        const next = withFolded(prev, key, !value);
        writeCollapsedGroupsCache(next);
        return next;
      });
    });
  };

  return { sessions, projects, connection, loaded, folded, setFolded };
}
