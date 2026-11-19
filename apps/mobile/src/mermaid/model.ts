// What the diagram sheet decides outside React Native and outside the WebView (DESIGN.md 7g): which
// code blocks offer a diagram, the colors the page draws with, and what the page may tell the app.
// Plain TypeScript so a node test runs it.
import type { Palette } from "../palette.ts";

/**
 * A fenced code token (marked's `raw`) whose closing fence is there. A block still arriving, or an
 * indented block, has none, and offers no diagram: its text may still change.
 */
export function fenceClosed(raw: string): boolean {
  const lines = raw.replace(/\r\n?/g, "\n").trimEnd().split("\n");
  if (lines.length < 2) return false;
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0]!)?.[1];
  const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[lines.length - 1]!)?.[1];
  return (
    opening !== undefined &&
    closing !== undefined &&
    closing[0] === opening[0] &&
    closing.length >= opening.length
  );
}

/** The web's eight series colors (index.css .chat-markdown-mermaid, oklch) as hex, for older WebViews. */
export const SERIES_COLORS = [
  "#539af2",
  "#23ba7d",
  "#e9ab2b",
  "#f36169",
  "#a87eeb",
  "#2abfd4",
  "#f2823b",
  "#9ac242",
] as const;

function channels(color: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (!hex) return null;
  let h = hex[1]!;
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * `share` (0 to 1) of `fg` over `bg` as an opaque #rrggbb: the web's color-mix(in srgb, fg share,
 * bg). Both must be hex; any other form gives `fg` unchanged.
 */
export function mixColor(fg: string, bg: string, share: number): string {
  const a = channels(fg);
  const b = channels(bg);
  if (!a || !b) return fg;
  return `#${a.map((v, i) => Math.round(v * share + b[i]! * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The page's colors, named as Pele names them and valued as the web's index.css does for
 * .chat-markdown-mermaid: a transparent canvas, nodes at 6% and 12% of the text color over the
 * canvas, edges at 60% and node borders at 35%. Opaque colors, so an edge under a node stays hidden.
 */
export function pageColors(p: Pick<Palette, "bg" | "text" | "muted" | "accent" | "danger">): Record<string, string> {
  const vars: Record<string, string> = {
    "--pele-bg": "transparent",
    "--pele-fg": p.text,
    "--pele-muted": p.muted,
    "--pele-line": mixColor(p.text, p.bg, 0.6),
    "--pele-surface": mixColor(p.text, p.bg, 0.06),
    "--pele-surface-alt": mixColor(p.text, p.bg, 0.12),
    "--pele-border": mixColor(p.text, p.bg, 0.35),
    "--pele-accent": p.accent,
    "--pele-critical": p.danger,
    "--pele-radius": "6px",
  };
  SERIES_COLORS.forEach((color, i) => {
    vars[`--pele-series-${i + 1}`] = color;
  });
  return vars;
}

/** What the page sends the app (ReactNativeWebView.postMessage, JSON). */
export type PageMessage =
  | { t: "drawn" }
  | { t: "failed"; code: string; line: number; message: string };

/** A page message from its text, or null for anything that is not one. */
export function parsePageMessage(data: string): PageMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  if (m.t === "drawn") return { t: "drawn" };
  if (m.t === "failed") {
    return {
      t: "failed",
      code: typeof m.code === "string" ? m.code : "",
      line: typeof m.line === "number" ? m.line : 0,
      message: typeof m.message === "string" ? m.message : "",
    };
  }
  return null;
}
