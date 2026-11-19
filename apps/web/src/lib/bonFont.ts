// The web copy of Bon Google Sans Code ("Maru Bon Google Sans Code", used by the chat code font
// "Bon Google Sans Code (web font)"): its @font-face rules, declared from the font CDN setting
// (MARU_FONT_CDN in build.env, vite.config.ts `define`). The DOM picks the Latin or Hangul piece by
// unicode-range per character. With no CDN set the page declares nothing and the stack's next font
// draws the text.
import { bonFontFaceCss } from "@maru/shared";

declare const __MARU_FONT_CDN__: string | null;

/** The CDN directory this build was made with; null where no build defined it (node tests). */
export const FONT_CDN: string | null = typeof __MARU_FONT_CDN__ === "undefined" ? null : __MARU_FONT_CDN__;

/** Adds the style element with the Bon rules; nothing when there is no CDN. */
export function installBonFont(doc: Document = document, cdn: string | null = FONT_CDN): void {
  const css = bonFontFaceCss(cdn);
  if (!css) return;
  const el = doc.createElement("style");
  el.setAttribute("data-bon-font", "");
  el.textContent = css;
  doc.head.appendChild(el);
}
