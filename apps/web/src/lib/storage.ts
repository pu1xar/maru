// Local stand-in for T3 Code's localStorage helpers (apps/web/src/hooks/useLocalStorage.ts).
// T3 encodes values as JSON through an Effect Schema. Here values are plain JSON and the
// reader passes a type guard; a stored value that fails it throws, as a failed decode does in T3.

export type StoredValueGuard<T> = (value: unknown) => value is T;

export const isStoredBoolean: StoredValueGuard<boolean> = (value): value is boolean =>
  typeof value === "boolean";

export const isStoredFiniteNumber: StoredValueGuard<number> = (value): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function getLocalStorageItem<T>(key: string, isValue: StoredValueGuard<T>): T | null {
  const raw = window.localStorage.getItem(key);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!isValue(parsed)) throw new Error(`Stored value for ${key} has an unexpected type.`);
  return parsed;
}

export function setLocalStorageItem(key: string, value: unknown): void {
  window.localStorage.setItem(key, JSON.stringify(value));
}

export function removeLocalStorageItem(key: string): void {
  window.localStorage.removeItem(key);
}
