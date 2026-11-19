// Browser storage keys from before the rename to maru (DESIGN.md 8). The page's keys begin with
// "maru_"; the old build wrote the same names under "chat_client_". Loading the page moves each old
// key to its new name once and removes it, so the saved display settings, panel widths and layouts
// carry over. main.tsx imports this module first, so the move runs before anything reads storage.

export const LEGACY_KEY_PREFIX = "chat_client_";
export const KEY_PREFIX = "maru_";

/** The part of the browser's Storage the move uses, so tests can pass a fake. */
export interface KeyValueStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LegacyMoveResult {
  /** Old keys whose value now sits under the new name. */
  moved: string[];
  /** Old keys removed because the new name already had a value (written by a newer page). */
  superseded: string[];
  /** Old keys left in place because the new value could not be written (storage full). */
  failed: string[];
}

/** The key's name after the rename, or null for a key the old build did not write. */
export function renamedKey(key: string): string | null {
  return key.startsWith(LEGACY_KEY_PREFIX) ? KEY_PREFIX + key.slice(LEGACY_KEY_PREFIX.length) : null;
}

/**
 * Moves every "chat_client_" key to its "maru_" name. A value already under the new name wins. An
 * old key is removed only once its value is safe under the new name, so a failed write keeps it
 * for the next load.
 */
export function moveLegacyKeys(storage: KeyValueStorage): LegacyMoveResult {
  const result: LegacyMoveResult = { moved: [], superseded: [], failed: [] };
  // Collected first: removing keys while walking the index would skip some.
  const legacy: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && renamedKey(key) !== null) legacy.push(key);
  }
  for (const oldKey of legacy) {
    const newKey = renamedKey(oldKey)!;
    try {
      const value = storage.getItem(oldKey);
      if (value === null) continue;
      if (storage.getItem(newKey) === null) {
        storage.setItem(newKey, value);
        result.moved.push(oldKey);
      } else {
        result.superseded.push(oldKey);
      }
      storage.removeItem(oldKey);
    } catch {
      result.failed.push(oldKey);
    }
  }
  return result;
}

if (typeof window !== "undefined") {
  try {
    moveLegacyKeys(window.localStorage);
  } catch {
    // Storage blocked: nothing to move, and the page reads defaults.
  }
}
