// The palette the display settings produce: the theme's palette (palette.ts, from the one color
// source) with the chat code surface and the user's bubble the settings choose. React Native-free.
import { backgroundScheme, type ChatCodeBackground, type MessageBubbleStyle } from "../../../web/src/lib/displayPrefs.logic.ts";
import { withAlpha } from "../../../../packages/shared/src/themeColors.ts";
import { darkPalette, lightPalette, type Palette } from "../palette.ts";

export type Scheme = "light" | "dark";

/** The palette a component reads: the code surface also says which color scheme its text reads in. */
export interface AppPalette extends Palette {
  codeScheme: Scheme;
}

/**
 * The terminal background preset of the chat code (web index.css `--chat-code-preset-terminal`:
 * the default terminal color set's background #0f0f0f in dark, #eceff3 in light). The app has no terminal mode, so the
 * preset is that default.
 */
export const CHAT_CODE_TERMINAL: Record<Scheme, string> = { dark: "#0f0f0f", light: "#eceff3" };

/** A code surface and the scheme its text reads in: a custom color brings its own (web `data-chat-code-scheme`), a preset keeps the theme's. */
export function codeSurface(setting: ChatCodeBackground, scheme: Scheme, themeCode: string): { surface: string; scheme: Scheme } {
  if (setting === "default") return { surface: themeCode, scheme };
  if (setting === "terminal") return { surface: CHAT_CODE_TERMINAL[scheme], scheme };
  return { surface: setting, scheme: backgroundScheme(setting) };
}

const cache = new Map<string, AppPalette>();

/** The palette of a theme with the chat code background and the user's bubble color. The same inputs give the same object. */
export function paletteFor(scheme: Scheme, settings: { chatCodeBackground: ChatCodeBackground; messageBubble: MessageBubbleStyle }): AppPalette {
  const key = `${scheme}|${settings.chatCodeBackground}|${settings.messageBubble}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const base = scheme === "light" ? lightPalette : darkPalette;
  const code = codeSurface(settings.chatCodeBackground, scheme, base.code);
  const next: AppPalette = {
    ...base,
    code: code.surface,
    codeScheme: code.scheme,
    // The accent with white text, in both themes (index.css [data-message-bubble="blue"]).
    userBubble: settings.messageBubble === "blue" ? base.accent : base.userBubble,
  };
  cache.set(key, next);
  return next;
}

/**
 * The palette for what sits inside a user's bubble: a blue bubble has white text, white at 75% for
 * the muted labels and white links (index.css `[data-message-bubble="blue"] [data-user-message-bubble]`).
 * Null for the default bubble, whose contents read the page's palette.
 */
export function bubbleContent(p: AppPalette, style: MessageBubbleStyle): AppPalette | null {
  if (style !== "blue") return null;
  return { ...p, text: "#ffffff", muted: withAlpha("#ffffff", 0.75), info: "#ffffff" };
}
