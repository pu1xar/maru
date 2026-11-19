// Local file (not from T3 Code): the decisions behind a ```mermaid block, kept free of the renderer
// so they run in node tests and stay out of the lazy diagram chunk (DESIGN.md 7g).

/** A fence's language names a Mermaid diagram (the info string is case-insensitive here). */
export function isMermaidLanguage(language: string): boolean {
  return language.trim().toLowerCase() === "mermaid";
}

/**
 * What a Mermaid block shows.
 * - "diagram": the drawn picture
 * - "code": the fenced source (the reader asked for it, the block is still arriving, there is
 *   nothing to draw, or the source did not draw)
 * A block still arriving is the last one of a streamed answer whose closing fence has not come.
 * Its text changes with every update, so it stays code until the fence closes and then draws once.
 */
export function mermaidBlockView(input: {
  code: string;
  open: boolean;
  showCode: boolean;
  failed: boolean;
}): "diagram" | "code" {
  if (input.showCode || input.open || input.failed) return "code";
  return input.code.trim().length > 0 ? "diagram" : "code";
}

/** The one line shown above the source when a diagram did not draw. */
export function mermaidFailureLine(error: unknown): { summary: string; detail: string } {
  const info = error as { code?: unknown; line?: unknown; message?: unknown } | null;
  const message = typeof info?.message === "string" ? info.message : String(error);
  const code = typeof info?.code === "string" ? info.code : "";
  const line = typeof info?.line === "number" && info.line > 0 ? info.line : 0;
  if (code === "syntax" || code === "semantic") {
    return {
      summary: line > 0 ? `Mermaid syntax error on line ${line}` : "Mermaid syntax error",
      detail: message,
    };
  }
  if (code === "unsupported-diagram") {
    return { summary: "Mermaid diagram type is not supported", detail: message };
  }
  if (code === "limit") {
    return { summary: "Mermaid diagram is too large to draw", detail: message };
  }
  return { summary: "Mermaid diagram could not be drawn", detail: message };
}

/** A drawn diagram narrows with the lane down to this share of its own width, then scrolls. */
export const MERMAID_MIN_SCALE = 0.7;

/** The narrowest width (px) a diagram of this natural width is drawn at, before it scrolls. */
export function mermaidMinWidth(naturalWidth: number): number {
  if (!Number.isFinite(naturalWidth) || naturalWidth <= 0) return 0;
  return Math.round(naturalWidth * MERMAID_MIN_SCALE);
}
