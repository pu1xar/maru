// The web's text sizes outside the conversation (Tailwind's text-xs to text-xl at the 1rem root, with
// its line heights), for the header, sheets, settings and toasts. The conversation area scales them
// by the conversation text size (index.css [data-chat-text]); `chat` holds that scale at the default
// 15pt (15 over the theme's 14), used by what the web draws inside the conversation canvas: the
// find bar, the banners, the empty states. On a phone-wide web the controls use text-base (16)
// where a wider screen uses text-sm, so `base` is the control size here.
export const ui = {
  xs: { fontSize: 12, lineHeight: 16 },
  sm: { fontSize: 14, lineHeight: 20 },
  base: { fontSize: 16, lineHeight: 24 },
  xl: { fontSize: 20, lineHeight: 28 },
} as const;

export const chat = {
  xs: { fontSize: 13, lineHeight: 18 },
  sm: { fontSize: 15, lineHeight: 22 },
  base: { fontSize: 17, lineHeight: 24 },
  xl: { fontSize: 21, lineHeight: 30 },
} as const;

/** The web's control radius (--control-radius, rounded-lg: 0.5rem). */
export const CONTROL_RADIUS = 8;
