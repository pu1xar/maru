// The selected session in the address: `?s=<session id>` (user request 2026-11-16). The page keeps
// the full key (`provider:account:id`) inside; the address holds only the id, which stays the same
// when the session moves to another account. An old link with the full key still opens.

/** What the address carries for a session key: its id (the part after the last `:`). */
export function sessionUrlValue(key: string): string {
  const at = key.lastIndexOf(":");
  return at === -1 ? key : key.slice(at + 1);
}

/** Whether an address value is a bare id (to look up) rather than a full key. */
export function isBareSessionId(value: string): boolean {
  return !value.includes(":");
}

/** The key of the listed session with this id, or null. */
export function keyForSessionId(id: string, sessions: Iterable<{ key: string; id: string }>): string | null {
  for (const s of sessions) if (s.id === id) return s.key;
  return null;
}
