// The browser side of the interface fonts (uiFonts.logic.ts has the font list and its rules, which
// the Android app reads too): adding a font's stylesheet to the page.
export * from "./uiFonts.logic.ts";

/** The minimal shape of `document` ensureStylesheets uses (a test passes its own). */
export interface SheetHost {
  head?: { appendChild(node: unknown): unknown } | null;
  querySelector?(selector: string): unknown;
  createElement?(tag: string): { rel: string; href: string; setAttribute(name: string, value: string): void };
}

/** Adds a `<link rel="stylesheet">` for each sheet the page does not have yet; a page without a head does nothing. */
export function ensureStylesheets(sheets: readonly string[], host: SheetHost = document as unknown as SheetHost): void {
  const { head, createElement, querySelector } = host;
  if (!head || typeof createElement !== "function" || typeof querySelector !== "function") return;
  for (const href of sheets) {
    if (querySelector.call(host, `link[data-maru-font="${href}"]`)) continue;
    const link = createElement.call(host, "link");
    link.rel = "stylesheet";
    link.href = href;
    link.setAttribute("data-maru-font", href);
    head.appendChild(link);
  }
}
