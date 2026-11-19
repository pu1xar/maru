// The pure side of the terminal mode's color theme (Settings, Appearance, Terminal color set; DESIGN.md 6i, "터미널 테마 선택"):
// the colorsets, the token rules and the preference rules. terminalTheme.ts keeps the browser's storage and hooks;
// the Android app reads this file. One choice, the colorset, kept per device like the other display preferences. A
// colorset is its background plus the role colors (Claude's mark, ok, error, warning, accent, plan,
// accept, diff) and the text, rule and user-row colors derived from them.
//
// The default is colorset "iterm", whose background is the neutral #0f0f0f (the user's choice, DESIGN.md 6i).
// index.css `.term-root` keeps the iTerm profile's tokens, including their Display P3 values. The
// colorset "iterm" writes only `--term-bg` (#0f0f0f), so its role colors stay the stylesheet's and
// keep their P3 values. Every other colorset writes all the `--term-*` tokens inline on the terminal
// root (TerminalView, the settings preview, the loading fallback).
//
// Mapping rule (one rule for every colorset made from a public color scheme):
//   - bg, fg: the scheme's background and foreground (fg is pulled toward `strong` until it holds
//     5.5:1 on the background in use, so that it still holds 4.5:1 on a tinted diff row)
//   - strong (bold, user text, cursor, code): of the scheme's bright white, black and fg, the one
//     with the most contrast on the background
//   - claude: the scheme's orange (peach); ok: green; err: red; warn: yellow; accent (inline code,
//     question chip, links): blue; plan: cyan or teal; accept: magenta or purple. When a palette
//     has a normal and a bright variant, the one with more contrast on its background is the pick
//   - role colors are pulled toward `strong` until they hold 3:1 on the background in use
//   - dim = mix(fg, bg, 64%), rule 54%, subtle 29%, user row 19% (the shares of iTerm's #949494,
//     #808080, #4e4e4e and #3a3a3a between #14191e and #dcdcdc); dim is pulled toward fg until it
//     holds 3:1
//   - shimmer = claude with 30% strong mixed in; code-faint = mix(strong, bg, 50%)
//   - selection background = accent over bg by the same largest share as a diff row, its text fg
//   - diff rows: the mark is ok or err; the row background is mix(ok or err, bg, a) with the
//     largest a of 30% down to 10% (steps of 2%) that keeps fg and strong at 4.5:1 on it (a row)
//   - chip text (on the accent) is whichever of bg, black and white has the most contrast on accent
// A colorset that carries Claude Code's own palette or the iTerm profile gives some tokens
// directly (`fixed`); those are used as given.
//
// Public schemes come from their official palette sources (the URL in each `source`); the two
// Claude Code palettes are read from the CLI bundle, see their `source`.
export type TerminalScheme = "dark" | "light";

export interface TerminalTokens {
  bg: string;
  fg: string;
  bold: string;
  fgStrong: string;
  cursor: string;
  selectionBg: string;
  selectionFg: string;
  link: string;
  dim: string;
  rule: string;
  subtle: string;
  userBg: string;
  code: string;
  codeFaint: string;
  claude: string;
  shimmer: string;
  ok: string;
  err: string;
  warn: string;
  accent: string;
  plan: string;
  accept: string;
  delFg: string;
  delBg: string;
  addFg: string;
  addBg: string;
  chipFg: string;
  rewindAdd: string;
}

interface Roles {
  claude: string;
  ok: string;
  err: string;
  warn: string;
  accent: string;
  plan: string;
  accept: string;
}

export interface TerminalColorset {
  id: string;
  label: string;
  /** One line on what the set is like, shown under the name in the list. */
  hint: string;
  scheme: TerminalScheme;
  /** Where the colors come from. */
  source: string;
  bg: string;
  fg: string;
  strong: string;
  roles: Roles;
  /** Tokens taken as given instead of derived (and not pulled toward a contrast floor). */
  fixed?: Partial<TerminalTokens>;
}

/**
 * The iTerm profile's colors as index.css `.term-root` has them (sRGB fallback values; the
 * stylesheet also has the Display P3 ones). terminalTheme.test.ts reads index.css and checks that
 * these match, so the contrast numbers here are the stylesheet's.
 */
export const ITERM_TOKENS: TerminalTokens = {
  bg: "#14191e",
  fg: "#dcdcdc",
  bold: "#ffffff",
  fgStrong: "#ffffff",
  cursor: "#ffffff",
  selectionBg: "#b3d7ff",
  selectionFg: "#000000",
  link: "#328eee",
  dim: "#949494",
  rule: "#808080",
  subtle: "#4e4e4e",
  userBg: "#3a3a3a",
  code: "#ffffff",
  codeFaint: "#8a8c8e",
  claude: "#e48285",
  shimmer: "#ffab7f",
  ok: "#6ada7e",
  err: "#ff7eb0",
  warn: "#ffd500",
  accent: "#a4d8ff",
  plan: "#3bb1b0",
  accept: "#afafff",
  delFg: "#e8555a",
  delBg: "#690000",
  addFg: "#00da4b",
  addBg: "#006100",
  chipFg: "#000000",
  rewindAdd: "#3bb184",
};

export const ITERM_COLORSET_ID = "iterm";
/**
 * The background of the colorset "iterm": a near-black gray (OKLab a = b = 0), darker than the
 * profile's #14191e (ITERM_TOKENS.bg, which index.css keeps). The first neutral, #181818 (#14191e's
 * OKLab lightness with the blue taken out), read as gray and too light, and the user asked for a
 * darker one (2026-11-16). terminalTheme.test.ts checks that it is a gray and darker than #14191e.
 */
export const ITERM_COLORSET_BG = "#0f0f0f";

const CC_SOURCE =
  "Claude Code 2.1.325 CLI bundle (@anthropic-ai/claude-agent-sdk-darwin-arm64 0.3.321, the `claude` binary), the built-in theme objects returned by bq(): ";

/** Claude Code's dark theme object as the CLI draws it with truecolor (outside tmux). */
const CC_DARK: Partial<TerminalTokens> = {
  dim: "#999999",
  rule: "#888888",
  subtle: "#505050",
  userBg: "#373737",
  shimmer: "#eb9f7f",
  delFg: "#b3596b",
  delBg: "#7a2936",
  addFg: "#38a660",
  addBg: "#225c2b",
  selectionBg: "#264f78",
  selectionFg: "#ffffff",
};

export const TERMINAL_COLORSETS: readonly TerminalColorset[] = [
  {
    id: ITERM_COLORSET_ID,
    label: "Current (as in iTerm)",
    hint: "Pink Claude, light sky accent. The 256 colors in tmux as iTerm draws them in P3",
    scheme: "dark",
    source: "256-color approximation of the iTerm 3.7.7 profile and the Claude Code 2.1.325 dark theme (DESIGN.md 6i, iTerm theme and cell)",
    bg: ITERM_COLORSET_BG,
    fg: ITERM_TOKENS.fg,
    strong: ITERM_TOKENS.fgStrong,
    roles: {
      claude: ITERM_TOKENS.claude,
      ok: ITERM_TOKENS.ok,
      err: ITERM_TOKENS.err,
      warn: ITERM_TOKENS.warn,
      accent: ITERM_TOKENS.accent,
      plan: ITERM_TOKENS.plan,
      accept: ITERM_TOKENS.accept,
    },
  },
  {
    id: "claude-dark",
    label: "Claude Code dark",
    hint: "Orange Claude, light purple accent. The original dark colors the CLI draws in truecolor",
    scheme: "dark",
    source: CC_SOURCE + "default (dark) theme",
    bg: ITERM_TOKENS.bg,
    fg: "#ffffff",
    strong: "#ffffff",
    roles: {
      claude: "#d77757",
      ok: "#4eba65",
      err: "#ff6b80",
      warn: "#ffc107",
      accent: "#b1b9f9",
      plan: "#48968c",
      accept: "#af87ff",
    },
    fixed: CC_DARK,
  },
  {
    id: "claude-dark-daltonized",
    label: "Claude Code dark (color blind)",
    hint: "Orange and blue contrast. A color-blind-adjusted theme where success is blue instead of green",
    scheme: "dark",
    source: CC_SOURCE + "dark-daltonized theme",
    bg: ITERM_TOKENS.bg,
    fg: "#ffffff",
    strong: "#ffffff",
    roles: {
      claude: "#ff9933",
      ok: "#3399ff",
      err: "#ff6666",
      warn: "#ffcc00",
      accent: "#99ccff",
      plan: "#669999",
      accept: "#af87ff",
    },
    fixed: {
      ...CC_DARK,
      shimmer: "#ffb765",
      delFg: "#b30000",
      delBg: "#660000",
      addFg: "#0077b3",
      addBg: "#004466",
    },
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    hint: "Soft pastels, peach Claude, pink accept",
    scheme: "dark",
    source: "https://github.com/catppuccin/palette/blob/main/palette.json (v1.8.0, mocha colors and ansiColors)",
    bg: "#1e1e2e",
    fg: "#cdd6f4",
    strong: "#cdd6f4",
    roles: { claude: "#fab387", ok: "#a6e3a1", err: "#f38ba8", warn: "#f9e2af", accent: "#89b4fa", plan: "#94e2d5", accept: "#f5c2e7" },
  },
  {
    id: "dracula",
    label: "Dracula",
    hint: "Saturated neon, purple accent and pink accept",
    scheme: "dark",
    source: "https://github.com/dracula/alacritty/blob/master/dracula.toml (orange #ffb86c: same file, focused match; https://spec.draculatheme.com)",
    bg: "#282a36",
    fg: "#f8f8f2",
    strong: "#ffffff",
    roles: { claude: "#ffb86c", ok: "#69ff94", err: "#ff6e6e", warn: "#ffffa5", accent: "#d6acff", plan: "#a4ffff", accept: "#ff92df" },
  },
  {
    id: "gruvbox-dark",
    label: "Gruvbox Dark",
    hint: "Warm brown background, retro orange and yellow",
    scheme: "dark",
    source: "https://github.com/morhetz/gruvbox/blob/master/colors/gruvbox.vim (dark0 bg, light1 fg, light0 strong, bright_* roles)",
    bg: "#282828",
    fg: "#ebdbb2",
    strong: "#fbf1c7",
    roles: { claude: "#fe8019", ok: "#b8bb26", err: "#fb4934", warn: "#fabd2f", accent: "#83a598", plan: "#8ec07c", accept: "#d3869b" },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    hint: "Teal background, classic 8 colors at low contrast",
    scheme: "dark",
    source: "https://github.com/altercation/solarized/blob/master/README.md (base03 bg, base0 fg, base3 strong, the 8 accents)",
    bg: "#002b36",
    fg: "#839496",
    strong: "#fdf6e3",
    roles: { claude: "#cb4b16", ok: "#859900", err: "#dc322f", warn: "#b58900", accent: "#268bd2", plan: "#2aa198", accept: "#d33682" },
  },
  {
    id: "github-dark",
    label: "GitHub Dark",
    hint: "Near-black background, vivid blue and green",
    scheme: "dark",
    source: "https://github.com/primer/github-vscode-theme (src/colors.js fg overrides) with @primer/primitives 7.10.0 dist/json/colors/dark.json (canvas.default, ansi, scale.orange[3])",
    bg: "#0d1117",
    fg: "#e6edf3",
    strong: "#ffffff",
    roles: { claude: "#f0883e", ok: "#56d364", err: "#ffa198", warn: "#e3b341", accent: "#79c0ff", plan: "#56d4dd", accept: "#d2a8ff" },
  },
  {
    id: "maru-warm",
    label: "maru brown",
    hint: "Warm brown from the logo's dark plate and cream line, terracotta Claude",
    scheme: "dark",
    source: "maru's own. Values from the logo colors: background #2B241F, line #F2E8D8, border #D9A05B (DESIGN.md 7c)",
    bg: "#2b241f",
    fg: "#e6dccb",
    strong: "#f2e8d8",
    roles: { claude: "#e08a5e", ok: "#a9c47f", err: "#e9776f", warn: "#d9a05b", accent: "#8fb8c9", plan: "#7fb5a3", accept: "#c2a3d2" },
  },
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    hint: "Pastels on a light cream background",
    scheme: "light",
    source: "https://github.com/catppuccin/palette/blob/main/palette.json (v1.8.0, latte colors and ansiColors)",
    bg: "#eff1f5",
    fg: "#4c4f69",
    strong: "#4c4f69",
    roles: { claude: "#fe640b", ok: "#40a02b", err: "#d20f39", warn: "#df8e1d", accent: "#1e66f5", plan: "#179299", accept: "#ea76cb" },
  },
  {
    id: "github-light",
    label: "GitHub Light",
    hint: "White background, deep blue and green",
    scheme: "light",
    source: "https://github.com/primer/github-vscode-theme (src/colors.js fg overrides) with @primer/primitives 7.10.0 dist/json/colors/light.json (canvas.default, ansi, scale.orange[5])",
    bg: "#ffffff",
    fg: "#1f2328",
    strong: "#1f2328",
    roles: { claude: "#bc4c00", ok: "#116329", err: "#a40e26", warn: "#4d2d00", accent: "#0969da", plan: "#1b7c83", accept: "#8250df" },
  },
  {
    id: "claude-light",
    label: "Claude Code light",
    hint: "White background, the CLI's light theme colors",
    scheme: "light",
    source: CC_SOURCE + "light theme (the CLI has no background of its own; the terminal's white is used)",
    bg: "#ffffff",
    fg: "#000000",
    strong: "#000000",
    roles: {
      claude: "#d77757",
      ok: "#2c7a39",
      err: "#ab2b3f",
      warn: "#966c1e",
      accent: "#5769f7",
      plan: "#006666",
      accept: "#8700ff",
    },
    fixed: {
      dim: "#666666",
      rule: "#8a8a8a",
      subtle: "#afafaf",
      userBg: "#f0f0f0",
      shimmer: "#f59575",
      delFg: "#ab2b3f",
      delBg: "#ffa8b4",
      addFg: "#2c7a39",
      addBg: "#69db7c",
      selectionBg: "#b4d5ff",
      selectionFg: "#000000",
    },
  },
];

export const DEFAULT_COLORSET_ID = ITERM_COLORSET_ID;

export function colorsetById(id: string): TerminalColorset {
  return TERMINAL_COLORSETS.find((c) => c.id === id) ?? TERMINAL_COLORSETS[0]!;
}

// Color math in sRGB, as WCAG 2 defines contrast.
type Rgb = readonly [number, number, number];

function parse(hex: string): Rgb {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function hex(rgb: Rgb): string {
  return "#" + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
}

/** `share` of `a` over `b` (0 to 1). */
export function mix(a: string, b: string, share: number): string {
  const x = parse(a);
  const y = parse(b);
  return hex([x[0] * share + y[0] * (1 - share), x[1] * share + y[1] * (1 - share), x[2] * share + y[2] * (1 - share)]);
}

export function luminance(color: string): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = parse(color);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio of two #rrggbb colors. */
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `color` moved toward `toward` in 1% steps until it holds `min` contrast on `bg`. */
function pull(color: string, toward: string, bg: string, min: number): string {
  for (let share = 0; share <= 1.0001; share += 0.01) {
    const candidate = mix(toward, color, share);
    if (contrast(candidate, bg) >= min) return candidate;
  }
  return toward;
}

function best(bg: string, candidates: readonly string[]): string {
  return candidates.reduce((a, b) => (contrast(b, bg) > contrast(a, bg) ? b : a));
}

/**
 * A tinted row (a diff row, the selection): `role` over `bg` with the largest share of 30% down
 * to 10% (steps of 2%) that keeps every text color in `texts` at 4.5:1 on it.
 */
function tintedRow(role: string, bg: string, texts: readonly string[]): string {
  for (let share = 0.3; share >= 0.1 - 1e-9; share -= 0.02) {
    const row = mix(role, bg, share);
    if (texts.every((t) => contrast(t, row) >= 4.5)) return row;
  }
  return mix(role, bg, 0.1);
}

export const BODY_MIN = 4.5;
/** The floor for fg: a tinted diff row lowers its contrast, so the plain background gets more. */
export const BODY_FLOOR = 5.5;
export const DIM_MIN = 3;
export const ROLE_MIN = 3;

/** The tokens of a colorset, by the mapping rule at the top of this file. */
export function resolveTerminalTokens(colorsetId: string): TerminalTokens {
  const set = colorsetById(colorsetId);
  const bg = set.bg;
  if (set.id === ITERM_COLORSET_ID) return { ...ITERM_TOKENS, bg };
  const fixed = set.fixed ?? {};
  const strong = set.strong;
  // A colorset with `fixed` tokens carries a palette made for its own surface: its roles are used as given.
  const role = (key: keyof Roles) => (set.fixed ? set.roles[key] : pull(set.roles[key], strong, bg, ROLE_MIN));
  const fg = pull(set.fg, strong, bg, BODY_FLOOR);
  const claude = role("claude");
  const ok = role("ok");
  const err = role("err");
  const warn = role("warn");
  const accent = role("accent");
  const plan = role("plan");
  const accept = role("accept");
  const dim = fixed.dim ?? pull(mix(fg, bg, 0.64), fg, bg, DIM_MIN);
  const chipFg = best(accent, [bg, "#000000", "#ffffff"]);
  return {
    bg,
    fg,
    bold: strong,
    fgStrong: strong,
    cursor: strong,
    selectionBg: fixed.selectionBg ?? tintedRow(accent, bg, [fg]),
    selectionFg: fixed.selectionFg ?? fg,
    link: accent,
    dim,
    rule: fixed.rule ?? mix(fg, bg, 0.54),
    subtle: fixed.subtle ?? mix(fg, bg, 0.29),
    userBg: fixed.userBg ?? mix(fg, bg, 0.19),
    code: strong,
    codeFaint: mix(strong, bg, 0.5),
    claude,
    shimmer: fixed.shimmer ?? mix(claude, strong, 0.7),
    ok,
    err,
    warn,
    accent,
    plan,
    accept,
    delFg: fixed.delFg ?? err,
    delBg: fixed.delBg ?? tintedRow(err, bg, [fg, strong]),
    addFg: fixed.addFg ?? ok,
    addBg: fixed.addBg ?? tintedRow(ok, bg, [fg, strong]),
    chipFg,
    rewindAdd: ok,
  };
}

const CSS_VARS: ReadonlyArray<readonly [keyof TerminalTokens, string]> = [
  ["bg", "--term-bg"],
  ["fg", "--term-fg"],
  ["bold", "--term-bold"],
  ["fgStrong", "--term-fg-strong"],
  ["cursor", "--term-cursor"],
  ["selectionBg", "--term-selection-bg"],
  ["selectionFg", "--term-selection-fg"],
  ["link", "--term-link"],
  ["dim", "--term-dim"],
  ["rule", "--term-rule"],
  ["subtle", "--term-subtle"],
  ["userBg", "--term-user-bg"],
  ["code", "--term-code"],
  ["codeFaint", "--term-code-faint"],
  ["claude", "--term-claude"],
  ["shimmer", "--term-shimmer"],
  ["ok", "--term-ok"],
  ["err", "--term-err"],
  ["warn", "--term-warn"],
  ["accent", "--term-accent"],
  ["plan", "--term-plan"],
  ["accept", "--term-accept"],
  ["delFg", "--term-del-fg"],
  ["delBg", "--term-del-bg"],
  ["addFg", "--term-add-fg"],
  ["addBg", "--term-add-bg"],
  ["chipFg", "--term-chip-fg"],
  ["rewindAdd", "--term-rewind-add"],
];

/**
 * The style the terminal root takes for a colorset: the background alone for the iTerm colorset
 * (its role colors stay the stylesheet's), otherwise every token. A light colorset also turns
 * the root's own app tokens (loading and error text, scrollbars) light, since the root keeps the
 * `dark` class (index.css .dark).
 */
export function terminalThemeStyle(colorsetId: string): Record<string, string> {
  const set = colorsetById(colorsetId);
  const tokens = resolveTerminalTokens(set.id);
  if (set.id === ITERM_COLORSET_ID) return { "--term-bg": tokens.bg };
  const style: Record<string, string> = {};
  for (const [key, name] of CSS_VARS) style[name] = tokens[key];
  if (set.scheme === "light") {
    style.colorScheme = "light";
    style["--color-foreground"] = tokens.fg;
    style["--color-muted-foreground"] = tokens.dim;
    style["--app-scrollbar-thumb"] = "rgb(0 0 0 / 18%)";
    style["--app-scrollbar-thumb-hover"] = "rgb(0 0 0 / 30%)";
  }
  return style;
}

/** A colorset's look for the list and the preview: its background, text and the role colors. */
export function terminalSwatch(colorsetId: string): { bg: string; fg: string; roles: string[] } {
  const t = resolveTerminalTokens(colorsetId);
  return { bg: t.bg, fg: t.fg, roles: [t.claude, t.ok, t.err, t.warn, t.accent, t.plan, t.accept] };
}

export interface TerminalThemePrefs {
  colorset: string;
}

export const DEFAULT_TERMINAL_THEME: TerminalThemePrefs = { colorset: DEFAULT_COLORSET_ID };

/** The device storage key of the colorset choice (web localStorage, the app's secure store). */
export const COLORSET_KEY = "maru_terminal_colorset";
/** The key of the background choice that existed before the background merged into the colorset; never read, removed on the next write. */
export const RETIRED_SURFACE_KEY = "maru_terminal_surface";

export function normalizeTerminalTheme(raw: { colorset?: unknown }): TerminalThemePrefs {
  return {
    colorset: TERMINAL_COLORSETS.some((c) => c.id === raw.colorset) ? (raw.colorset as string) : DEFAULT_TERMINAL_THEME.colorset,
  };
}
