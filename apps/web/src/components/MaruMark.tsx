import type { SVGProps } from "react";

/**
 * The maru mark (DESIGN.md 7c), the simple line form the user chose (2026-11-16): the two
 * interlocking L frames of a 우물마루 floor and the cross of its rung and middle board, drawn in
 * the current text color so it follows the theme and wherever it sits. Every icon of the app (Android,
 * the desktop app) draws the same lines.
 */
export function MaruMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="120.96 120.96 190.08 190.08" xmlns="http://www.w3.org/2000/svg" {...props}>
      <g fill="none" stroke="currentColor" strokeWidth="14" strokeLinecap="butt" strokeLinejoin="miter">
        <path d="M145 250V145H304" />
        <path d="M287 182V287H128" />
        <path d="M170 216H262" />
        <path d="M216 162V270" />
      </g>
    </svg>
  );
}
