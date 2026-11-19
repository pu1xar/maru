// The app wears the web's colors: both read packages/shared's themeColors.ts (palette.ts maps
// them to the app's roles), user turns in a soft bubble and the assistant's text on the page.
// The color scheme is the phone's with Settings' theme laid over it (appearance.tsx), and the chat
// code surface and the user's bubble take the colors Settings choose (lib/appearancePalette.ts).
import { use } from "react";
import { useColorScheme } from "react-native";
import { PaletteScope, useAppearance } from "./appearance.tsx";
import { CODE_FAMILY, INLINE_CODE_FAMILY } from "./lib/appearance.logic.ts";
import { paletteFor, type AppPalette } from "./lib/appearancePalette.ts";

export type { Palette } from "./palette.ts";
export type { AppPalette } from "./lib/appearancePalette.ts";

export function usePalette(): AppPalette {
  const scheme = useColorScheme() === "light" ? "light" : "dark";
  const { prefs } = useAppearance();
  const scoped = use(PaletteScope);
  return scoped ?? paletteFor(scheme, prefs);
}

export const fonts = {
  /** The monospace font: Text turns it into the font Settings choose (lib/appearance.logic.ts resolveTextStyle). */
  mono: CODE_FAMILY,
  /** The same font for inline code, sized with the conversation text. */
  inlineMono: INLINE_CODE_FAMILY,
} as const;
