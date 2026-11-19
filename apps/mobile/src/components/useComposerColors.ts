// The input area's derived colors for the scheme on screen (lib/composerColors.ts).
import { useColorScheme } from "react-native";
import { composerColors, type ComposerColors } from "../lib/composerColors.ts";
import { usePalette } from "../theme.ts";

export function useComposerColors(): ComposerColors {
  const p = usePalette();
  return composerColors(useColorScheme() === "light" ? "light" : "dark", p);
}
