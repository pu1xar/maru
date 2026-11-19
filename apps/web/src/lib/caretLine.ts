// Whether a textarea's caret is on its first or last visual line, for ↑ and ↓ walking the sent
// messages (composerHistory.logic.ts, DESIGN.md 6h). A long line the textarea wraps shows several
// lines with no "\n" in the text, so the text alone cannot tell (user report 2026-11-17: ↑ in the
// second visual line of a wrapped message jumped to the previous message). The caret's line is
// measured on a hidden copy of the textarea: the same width, padding and text styles, the text up
// to the caret, then a marker whose top is the caret's line.
import { onFirstLine, onLastLine } from "./composerHistory.logic";

const COPIED_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "fontFeatureSettings",
  "fontVariantLigatures",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "tabSize",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "direction",
] as const;

/** The top of the line the caret at `index` sits on, in the copy's pixels. */
function lineTops(el: HTMLTextAreaElement, indexes: readonly number[]): number[] {
  const style = getComputedStyle(el);
  const copy = document.createElement("div");
  for (const name of COPIED_STYLES) copy.style[name] = style[name];
  copy.style.position = "absolute";
  copy.style.visibility = "hidden";
  copy.style.top = "0";
  copy.style.left = "-9999px";
  copy.style.boxSizing = "border-box";
  // clientWidth leaves out the scrollbar and the border, as the textarea's text box does.
  copy.style.width = `${el.clientWidth}px`;
  copy.style.border = "0";
  copy.style.height = "auto";
  copy.style.overflow = "hidden";
  // A textarea always wraps and keeps spaces.
  if (style.whiteSpace === "normal" || style.whiteSpace === "") copy.style.whiteSpace = "pre-wrap";
  document.body.appendChild(copy);
  try {
    return indexes.map((index) => {
      copy.textContent = el.value.slice(0, index);
      const marker = document.createElement("span");
      // The rest of the text keeps the caret's line as it is (a word that wraps whole moves with it).
      marker.textContent = el.value.slice(index) || ".";
      copy.appendChild(marker);
      return marker.offsetTop;
    });
  } finally {
    copy.remove();
  }
}

/** The caret (the selection's start) is on the textarea's first visual line. */
export function caretOnFirstLine(el: HTMLTextAreaElement): boolean {
  if (!onFirstLine(el.value, el.selectionStart)) return false;
  if (typeof document === "undefined" || el.clientWidth === 0) return true;
  const [first, caret] = lineTops(el, [0, el.selectionStart]);
  return caret === first;
}

/** The caret (the selection's end) is on the textarea's last visual line. */
export function caretOnLastLine(el: HTMLTextAreaElement): boolean {
  if (!onLastLine(el.value, el.selectionEnd)) return false;
  if (typeof document === "undefined" || el.clientWidth === 0) return true;
  const [caret, last] = lineTops(el, [el.selectionEnd, el.value.length]);
  return caret === last;
}
