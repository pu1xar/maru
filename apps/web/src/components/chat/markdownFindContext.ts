// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/markdownFindContext.ts (unchanged).
import { createContext } from "react";

// Keep folded text mounted for find; reveal only the selected match.
export const MarkdownFindContext = createContext(false);

/** Create during render with stable `onReveal`; find dispatches `beforematch` to ancestors. */
export function findRevealRef(onReveal: () => void) {
  return (element: HTMLElement | null) => {
    if (!element) return;
    element.addEventListener("beforematch", onReveal);
    return () => element.removeEventListener("beforematch", onReveal);
  };
}
