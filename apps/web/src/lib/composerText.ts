// What the composers (chat and terminal) send and what Enter does in them (DESIGN.md 7).
import { messageToSend } from "@maru/shared";

import { fenceOpenAt } from "../components/chat/userMessageFences.ts";

// The trimming rule lives in packages/shared, so the Android app's input trims the same way.
export { messageToSend };

export interface ComposerKey {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  /** An IME syllable is being composed (Korean input); `keyCode` 229 says the same. */
  readonly isComposing: boolean;
}

/** The fields composerEnter reads, from a React keyboard event. */
export function composerKeyOf(event: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  keyCode: number;
  nativeEvent: { isComposing: boolean };
}): ComposerKey {
  const { key, shiftKey, altKey, metaKey, ctrlKey } = event;
  return { key, shiftKey, altKey, metaKey, ctrlKey, isComposing: event.nativeEvent.isComposing || event.keyCode === 229 };
}

/**
 * What a key does in a composer once its pickers and menus have passed on it:
 * - "none": not Enter, or Enter that only commits an IME syllable
 * - "send": Cmd+Enter or Ctrl+Enter always, plain Enter outside a code block
 * - "newline": Shift or Alt with Enter, and plain Enter while the caret sits inside a backtick
 *   code block that is not closed yet (userMessageFences.ts reads the block). The textarea adds
 *   the line itself, so the caller leaves the key alone.
 */
export function composerEnter(event: ComposerKey, text: string, caret: number): "none" | "send" | "newline" {
  if (event.key !== "Enter" || event.isComposing) return "none";
  if (event.metaKey || event.ctrlKey) return "send";
  if (event.shiftKey || event.altKey) return "newline";
  return fenceOpenAt(text, caret) ? "newline" : "send";
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Shown under the input while the caret is inside a code block. */
export const FENCE_ENTER_HINT = `Inside a code block: Enter for a new line, ${IS_MAC ? "⌘Enter" : "Ctrl+Enter"} to send`;
