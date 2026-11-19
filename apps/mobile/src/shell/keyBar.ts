// The key bar under the shell on the phone (DESIGN.md 6s): the keys a touch keyboard lacks, in two
// rows. Ctrl and Alt latch for the next key (typed on the keyboard or pressed here); the other keys
// send at once. What each key sends, and how a latched Ctrl or Alt changes what was typed, is
// decided here, pure, so it is testable without a phone. The web's key bar (components/shell/
// ShellKeyBar.tsx) is the same idea with fewer keys; its Ctrl rule (controlChar) is shared.
import { controlChar } from "../../../web/src/lib/shellKeys.ts";

export interface Latches {
  ctrl: boolean;
  alt: boolean;
}

export const NO_LATCHES: Latches = { ctrl: false, alt: false };

export type BarKeyId =
  | "esc" | "tab" | "ctrl" | "alt"
  | "left" | "down" | "up" | "right" | "home" | "end" | "pgup" | "pgdn"
  | "ctrl-c" | "ctrl-d" | "pipe" | "tilde" | "slash" | "dash" | "backslash"
  | "paste";

export interface BarKey {
  id: BarKeyId;
  /** What is drawn on the key. */
  label: string;
  /** The accessibility name. */
  name: string;
  /** Width relative to the others in its row. */
  weight?: number;
  /** A key drawn as an arrow glyph instead of its label. */
  icon?: "arrow-left" | "arrow-down" | "arrow-up" | "arrow-right";
}

/** The two rows, top to bottom. 20 keys: 10 in each row. */
export const BAR_ROWS: readonly (readonly BarKey[])[] = [
  [
    { id: "esc", label: "Esc", name: "Escape" },
    { id: "tab", label: "Tab", name: "Tab" },
    { id: "ctrl", label: "Ctrl", name: "Control, applies to the next key" },
    { id: "alt", label: "Alt", name: "Alt, applies to the next key" },
    { id: "left", label: "Left", name: "Left arrow", icon: "arrow-left" },
    { id: "down", label: "Down", name: "Down arrow", icon: "arrow-down" },
    { id: "up", label: "Up", name: "Up arrow", icon: "arrow-up" },
    { id: "right", label: "Right", name: "Right arrow", icon: "arrow-right" },
    { id: "home", label: "Home", name: "Home" },
    { id: "end", label: "End", name: "End" },
  ],
  [
    { id: "ctrl-c", label: "^C", name: "Control C, interrupt" },
    { id: "ctrl-d", label: "^D", name: "Control D, end of input" },
    { id: "pipe", label: "|", name: "Vertical bar" },
    { id: "tilde", label: "~", name: "Tilde" },
    { id: "slash", label: "/", name: "Slash" },
    { id: "dash", label: "-", name: "Hyphen" },
    { id: "backslash", label: "\\", name: "Backslash" },
    { id: "paste", label: "Paste", name: "Paste from the clipboard", weight: 1.6 },
    { id: "pgup", label: "PgUp", name: "Page up" },
    { id: "pgdn", label: "PgDn", name: "Page down" },
  ],
];

/** Keys that latch instead of sending. */
export const isModifier = (id: BarKeyId): id is "ctrl" | "alt" => id === "ctrl" || id === "alt";

const ESC = "\x1b";

const TEXT_KEYS: Partial<Record<BarKeyId, string>> = { pipe: "|", tilde: "~", slash: "/", dash: "-", backslash: "\\" };

/**
 * What the keyboard typed after a latched Ctrl or Alt: Ctrl turns a single letter or one of @[\]^_
 * into its control code (the web's key bar rule), and Alt puts Escape in front, which is how a
 * terminal reads Alt. A latch that does not fit the typed text (Ctrl on a whole word) still ends.
 */
export function applyLatches(data: string, latches: Latches): string {
  let out = data;
  if (latches.ctrl) out = controlChar(out) ?? out;
  if (latches.alt) out = ESC + out;
  return out;
}

/** The xterm modifier parameter: 1 plus 2 for Alt and 4 for Ctrl (CSI 1;5D is Ctrl+Left). */
function modifierParam(latches: Latches): number {
  return 1 + (latches.alt ? 2 : 0) + (latches.ctrl ? 4 : 0);
}

const CURSOR_FINAL = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" } as const;
const PAGE_CODE = { pgup: 5, pgdn: 6 } as const;

/**
 * The bytes a key sends, or null for a key that sends nothing here (the modifiers, Paste). Arrow,
 * Home and End follow the shell's cursor key mode while no modifier is latched, and take the
 * modified form (CSI 1;m X) with one.
 */
export function barKeyData(id: BarKeyId, latches: Latches, appCursor: boolean): string | null {
  switch (id) {
    case "ctrl":
    case "alt":
    case "paste":
      return null;
    case "esc":
      return ESC;
    case "tab":
      return applyLatches("\t", { ctrl: false, alt: latches.alt });
    case "ctrl-c":
      return "\x03";
    case "ctrl-d":
      return "\x04";
    case "pipe":
    case "tilde":
    case "slash":
    case "dash":
    case "backslash":
      return applyLatches(TEXT_KEYS[id]!, latches);
    case "up":
    case "down":
    case "left":
    case "right":
    case "home":
    case "end": {
      const c = CURSOR_FINAL[id];
      if (latches.ctrl || latches.alt) return `${ESC}[1;${modifierParam(latches)}${c}`;
      return appCursor ? `${ESC}O${c}` : `${ESC}[${c}`;
    }
    case "pgup":
    case "pgdn":
      return latches.ctrl || latches.alt ? `${ESC}[${PAGE_CODE[id]};${modifierParam(latches)}~` : `${ESC}[${PAGE_CODE[id]}~`;
  }
}
