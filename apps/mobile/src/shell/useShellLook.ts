// The shell's look for a screen (look.ts): the app's Monospace setting live, and the terminal text
// size and color set from the secure store, read when the screen opens and again when `reloadKey`
// changes (Settings closing) or the app comes back to the screen.
import { useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";
import { useAppearance } from "../appearance.tsx";
import { DEFAULT_SHELL_LOOK, readShellLook, TERMINAL_COLORSET_KEY, TERMINAL_FONT_SIZE_KEY, type ShellLook } from "./look.ts";

export function useShellLook(reloadKey: number): ShellLook {
  const { prefs } = useAppearance();
  const [stored, setStored] = useState<Pick<ShellLook, "fontSize" | "colorset">>(DEFAULT_SHELL_LOOK);
  const [returned, setReturned] = useState(0);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") setReturned((n) => n + 1);
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    let live = true;
    const keys = [TERMINAL_FONT_SIZE_KEY, TERMINAL_COLORSET_KEY];
    void Promise.all(keys.map((key) => SecureStore.getItemAsync(key).catch(() => null))).then((values) => {
      if (!live) return;
      const byKey = new Map(keys.map((key, i) => [key, values[i] ?? null] as const));
      const { fontSize, colorset } = readShellLook((key) => byKey.get(key) ?? null, prefs.monoFont);
      setStored((cur) => (cur.fontSize === fontSize && cur.colorset === colorset ? cur : { fontSize, colorset }));
    });
    return () => {
      live = false;
    };
  }, [reloadKey, returned, prefs.monoFont]);
  return useMemo(() => ({ ...stored, monoFont: prefs.monoFont }), [stored, prefs.monoFont]);
}
