// This phone's display settings in expo-secure-store (as the pairing and the last session are kept),
// one key per setting under the web's names and JSON forms (appearance.logic.ts), and the loading of
// the font files a choice needs. A font file is fetched from its pinned URL by expo-font and kept in
// the phone's cache.
import { Appearance } from "react-native";
import * as Font from "expo-font";
import * as SecureStore from "expo-secure-store";
import type { ThemePref } from "../../../web/src/lib/theme.logic.ts";
import { LEGACY_DISPLAY_KEYS } from "../../../web/src/lib/displayPrefs.logic.ts";
import type { FontFace } from "./appFonts.logic.ts";
import { APPEARANCE_KEYS, appearanceEntries, readAppearanceFrom, type AppearancePrefs } from "./appearance.logic.ts";

/** The stored settings; a key that cannot be read counts as not stored. */
export async function loadAppearance(): Promise<AppearancePrefs> {
  const keys = [...APPEARANCE_KEYS, ...LEGACY_DISPLAY_KEYS];
  const values = await Promise.all(keys.map((key) => SecureStore.getItemAsync(key).catch(() => null)));
  const stored = new Map(keys.map((key, i) => [key, values[i] ?? null] as const));
  return readAppearanceFrom((key) => stored.get(key) ?? null);
}

/** Writes every key (a value equal to its default is removed); a failed write leaves the change for this launch only. */
export function saveAppearance(prefs: AppearancePrefs): void {
  for (const [key, value] of appearanceEntries(prefs)) {
    (value === null ? SecureStore.deleteItemAsync(key) : SecureStore.setItemAsync(key, value)).catch(() => undefined);
  }
}

/** The color scheme the whole app follows: "System" gives it back to the phone, the others set it (useColorScheme reads it). */
export function applyTheme(theme: ThemePref): void {
  Appearance.setColorScheme(theme === "system" ? "auto" : theme);
}

/** Downloads (if the phone does not have it yet) and registers a face under its family name. */
export async function loadFace(face: FontFace): Promise<void> {
  await Font.loadAsync(face.family, { uri: face.source.uri });
}
