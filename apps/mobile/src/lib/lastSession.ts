// The session this phone had open last, kept in expo-secure-store like the new-session sheet's
// memory, so launching the app opens it again instead of the empty drawer (DESIGN.md 6v).
import * as SecureStore from "expo-secure-store";

const KEY = "maru.lastSession.v1";

/** The stored key, or null when none is stored or storage fails. */
export async function readLastSession(): Promise<string | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    return raw ? raw : null;
  } catch {
    return null;
  }
}

export function writeLastSession(key: string): void {
  SecureStore.setItemAsync(KEY, key).catch(() => undefined);
}
