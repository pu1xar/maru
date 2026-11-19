// The subagent stack of each session's conversation, for this page (DESIGN.md 6p): which thread of
// the session is open, so a conversation that mounts again (another screen took its place, or the
// list dropped and re-added its key in a rehome) opens the same thread.

/** One level of the subagent stack: the thread and the title it had when it was left. */
export interface ThreadStackEntry {
  readonly threadId: string;
  readonly title: string | null;
}

const EMPTY_STACK: readonly ThreadStackEntry[] = [];
const stacks = new Map<string, readonly ThreadStackEntry[]>();

/** The stack the session's conversation showed last (empty: the session's own thread). */
export function readThreadStack(sessionKey: string): readonly ThreadStackEntry[] {
  return stacks.get(sessionKey) ?? EMPTY_STACK;
}

export function rememberThreadStack(sessionKey: string, stack: readonly ThreadStackEntry[]): void {
  if (stack.length === 0) stacks.delete(sessionKey);
  else stacks.set(sessionKey, stack);
}

/** `provider:account:` of a key (`provider:account:id`), or null for anything else. */
function accountPrefix(key: string): string | null {
  const first = key.indexOf(":");
  const second = first < 0 ? -1 : key.indexOf(":", first + 1);
  return second < 0 ? null : key.slice(0, second + 1);
}

/**
 * A thread of a moved session's family under the new account, or null when it is not under the old
 * one. Every thread id carries its account: a Claude subagent thread is `<session key>:agent-<id>`,
 * and a Codex subagent thread is a key of its own (`codex:<account>:<thread>`) that the server moves
 * with its parent.
 */
export function movedFamilyThreadId(threadId: string, from: string, to: string): string | null {
  const before = accountPrefix(from);
  const after = accountPrefix(to);
  if (before === null || after === null || !threadId.startsWith(before)) return null;
  return after + threadId.slice(before.length);
}

/**
 * The keys of a moved session's other threads that are sessions of their own (Codex subagent
 * threads), old and new: from the ids the server says it moved and the threads open in the stack.
 * A Claude subagent thread lives under the session's key and moves with it.
 */
export function movedFamilyKeys(
  from: string,
  to: string,
  familyIds: readonly string[],
  stack: readonly ThreadStackEntry[],
): Array<[string, string]> {
  const before = accountPrefix(from);
  if (before === null) return [];
  const keys = new Set([...familyIds.map((id) => before + id), ...stack.map((entry) => entry.threadId)]);
  const pairs: Array<[string, string]> = [];
  for (const key of keys) {
    if (key === from || key.startsWith(`${from}:`)) continue;
    const moved = movedFamilyThreadId(key, from, to);
    if (moved !== null) pairs.push([key, moved]);
  }
  return pairs;
}

/** The session moved to another account: its stack goes to the new key, its thread ids renamed. A stack the new key already has stays. */
export function moveThreadStack(from: string, to: string): void {
  const stack = stacks.get(from);
  if (!stack) return;
  stacks.delete(from);
  if (stacks.has(to)) return;
  stacks.set(
    to,
    stack.map((entry) => {
      const threadId = movedFamilyThreadId(entry.threadId, from, to);
      return threadId === null ? entry : { ...entry, threadId };
    }),
  );
}
