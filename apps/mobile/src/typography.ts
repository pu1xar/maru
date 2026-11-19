// The conversation's type scale, the web's at its default sizes (DESIGN.md 6g: conversation text
// 15pt, chat code 13pt; text-xs and text-2xs scale with it). 1sp here is the web's 1pt. The web's
// smallest step (11.8) rises to 12 on a phone, where smaller text is hard to read.
export const type = {
  /** Assistant prose and the user's bubble (web text-sm, leading-relaxed). */
  body: { fontSize: 15, lineHeight: 24 },
  /** A work row's line (web WorkLog text-sm). */
  row: { fontSize: 15, lineHeight: 22 },
  /** The sidebar's rows and labels (web text-sm, 14px; the sidebar is outside the conversation's scale). */
  sidebar: { fontSize: 14, lineHeight: 20 },
  /** Secondary text: times, details, a nested work row (web text-xs). */
  small: { fontSize: 13, lineHeight: 18 },
  /** The smallest labels (web text-2xs). */
  tiny: { fontSize: 12, lineHeight: 16 },
  /** Code blocks and inline code (chat code 13pt). */
  code: { fontSize: 13, lineHeight: 18 },
  /** Markdown headings; h4 and below are body size (index.css chat-markdown headings). */
  h1: { fontSize: 21, lineHeight: 27 },
  h2: { fontSize: 19, lineHeight: 25 },
  h3: { fontSize: 17, lineHeight: 22 },
  h4: { fontSize: 15, lineHeight: 20 },
} as const;

/** Space around a markdown heading (index.css: 1.25rem above, 0.5rem below). */
export const headingSpace = { top: 20, bottom: 8 } as const;
