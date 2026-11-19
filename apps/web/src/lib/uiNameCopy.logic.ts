// The one line that names an element for a bug report (DESIGN.md 7e): the component that wrote the
// tag, the part's own name, and where it is in the source. This file is the only page code that
// reads the build's data-ui, data-ui-in and data-ui-src attributes (uiNames.test.ts allows it by
// name); lib/uiNameCopy.ts holds the listeners.

/** The part of an element this reads: a DOM Element, or a stand-in in tests. */
export interface UiNamed {
  getAttribute(name: string): string | null;
  parentElement: UiNamed | null;
  tagName: string;
}

/** The first element from `el` upward (itself included) that has the attribute. */
function nearest(el: UiNamed | null, has: (e: UiNamed) => boolean): UiNamed | null {
  for (let e = el; e; e = e.parentElement) if (has(e)) return e;
  return null;
}

/**
 * `V2SubagentGroup > CollapsibleTrigger (chat/TimelineV2EventRow.tsx:66, v0.1.431)`.
 *
 * - The tag's own `data-ui-src` is the position: the nearest element at or above `el` that has one.
 * - The names come from that element, else the nearest one above it that has either.
 * - `data-ui` alone is the component that drew the tag as its outermost one (build leaves out
 *   `data-ui-in` when it is the same). `data-ui-in` alone is a tag inside a component, so the tag's
 *   own name stands where `data-ui` would.
 * - `version` is the page's ("0.1.N"); left out when unknown.
 */
export function uiNameLine(el: UiNamed, version: string | null): string | null {
  const at = nearest(el, (e) => e.getAttribute("data-ui-src") !== null);
  if (!at) return null;
  const named = nearest(at, (e) => e.getAttribute("data-ui") !== null || e.getAttribute("data-ui-in") !== null);
  const ui = named?.getAttribute("data-ui") ?? null;
  const within = named?.getAttribute("data-ui-in") ?? null;
  const tag = (named ?? at).tagName.toLowerCase();
  const head = within && ui ? `${within} > ${ui}` : within ? `${within} > ${tag}` : (ui ?? tag);
  const src = (at.getAttribute("data-ui-src") ?? "").replace(/^components\//, "");
  return `${head} (${version ? `${src}, v${version}` : src})`;
}
