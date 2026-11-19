// Which stored session a launch reopens (lastSession.ts). Pure, so node tests cover it.

/**
 * The stored key when the server's list still holds it as a session of its own. A subagent thread
 * (`<session key>:agent-<id>`) and a key the list no longer has (deleted, left the list, another
 * server) open nothing: the launch shows the list instead.
 */
export function restorableSession(stored: string | null, listed: { has(key: string): boolean }): string | null {
  if (!stored || stored.includes(":agent-")) return null;
  return listed.has(stored) ? stored : null;
}

/** Whether the screen's session is one to remember: listed, and not a subagent thread. */
export function rememberableSession(selected: string | null, listed: { has(key: string): boolean }): selected is string {
  return selected !== null && !selected.includes(":agent-") && listed.has(selected);
}
