// A message's 여기서 fork (DESIGN.md 6q): the server makes a new session from the conversation up
// to the message and its answer, and the page opens it in place of this one (openSession, the
// same flow as picking it in the sidebar). No confirmation: the original is not touched.
//
// The button lives in the timeline, far from the composer that shows errors, so a failure goes to
// the composer of the session (onForkError) and a fork in progress is a flag per session that
// disables the buttons (one click, one new session).
import { useSyncExternalStore } from "react";

import { describeError, forkSessionAt } from "~/projectsApi";
import { openSession } from "./openSession";

const forking = new Set<string>();
const forkingListeners = new Set<() => void>();
const errorListeners = new Map<string, Set<(message: string) => void>>();

function notifyForking(): void {
  for (const l of [...forkingListeners]) l();
}

/** Whether a fork of this session is on its way (the buttons wait). */
export function useForking(key: string): boolean {
  return useSyncExternalStore(
    (l) => {
      forkingListeners.add(l);
      return () => forkingListeners.delete(l);
    },
    () => forking.has(key),
    () => false,
  );
}

/** Called with the text of a fork that failed; returns the unregister function. */
export function onForkError(key: string, listener: (message: string) => void): () => void {
  let set = errorListeners.get(key);
  if (!set) errorListeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) errorListeners.delete(key);
  };
}

/** Forks the session at the message (the rewind screen's target id) and opens the new session. */
export async function forkFromMessage(key: string, id: string): Promise<void> {
  if (forking.has(key)) return;
  forking.add(key);
  notifyForking();
  try {
    const result = await forkSessionAt({ key, id });
    // A name that could not be set leaves the fork with the name the provider gave it; the list shows that name.
    if (result.notice) console.warn(result.notice);
    openSession(result.key);
  } catch (err) {
    for (const l of [...(errorListeners.get(key) ?? [])]) l(describeError(err));
  } finally {
    forking.delete(key);
    notifyForking();
  }
}
