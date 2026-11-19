// Bon Google Sans Code (English from Google Sans Code, Hangul from Sarasa Fixed K), served as woff2
// pieces by the deployment's font CDN. The CDN is a setting (MARU_FONT_CDN, build.env.example): the
// directory URL that holds the files named below, `https://<cdn>/fonts/v1/bon-google-sans-code`. The
// web page and the Android app's terminal page declare the pieces from it; with no CDN set they
// declare none and the font stack falls through to the next font.

/** The family name the pieces are declared under. */
export const BON_FAMILY = "Maru Bon Google Sans Code";

export const BON_LATIN_RANGE =
  "U+0000-024F, U+0300-036F, U+1E00-1EFF, U+2000-206F, U+2070-209F, U+20A0-20CF, U+2100-214F, U+2190-21FF, U+2200-22FF, U+2300-23FF, U+2460-24FF, U+2500-259F, U+25A0-25FF, U+2600-26FF, U+2700-27BF, U+FE00-FE0F, U+FF00-FFEF";
export const BON_HANGUL_RANGE =
  "U+1100-11FF, U+2E80-2EFF, U+3000-303F, U+3130-318F, U+31C0-31EF, U+A960-A97F, U+AC00-D7AF, U+D7B0-D7FF, U+F900-FAFF";

export interface BonPiece {
  /** The file `Bon-GoogleSansCode-<file>.woff2` in the CDN directory. */
  file: string;
  style: "normal" | "italic";
  weight: number;
  /** The `unicode-range` the piece covers: Latin and Hangul pieces share one family, chosen per character. */
  range: string;
}

export const BON_PIECES: readonly BonPiece[] = [
  { file: "Regular-latin", style: "normal", weight: 400, range: BON_LATIN_RANGE },
  { file: "Bold-latin", style: "normal", weight: 700, range: BON_LATIN_RANGE },
  { file: "Italic-latin", style: "italic", weight: 400, range: BON_LATIN_RANGE },
  { file: "Light-hangul", style: "normal", weight: 400, range: BON_HANGUL_RANGE },
  { file: "Bold-hangul", style: "normal", weight: 700, range: BON_HANGUL_RANGE },
];

/**
 * The CDN directory as a setting gives it, without a trailing slash; null when it is unset or is not
 * an https URL made only of characters a CSS `url("...")` and an HTML style element carry safely.
 */
export function normalizeFontCdn(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~%@+-]+)*$/.test(v) ? v : null;
}

export function bonPieceUrl(base: string, piece: Pick<BonPiece, "file">): string {
  return `${base}/Bon-GoogleSansCode-${piece.file}.woff2`;
}

/** The @font-face rules of the pieces for a CDN directory; "" when there is none. */
export function bonFontFaceCss(cdn: string | null | undefined): string {
  const base = normalizeFontCdn(cdn);
  if (!base) return "";
  return BON_PIECES.map(
    (p) =>
      `@font-face{font-family:"${BON_FAMILY}";src:url("${bonPieceUrl(base, p)}") format("woff2");font-style:${p.style};font-weight:${p.weight};font-display:swap;unicode-range:${p.range}}`,
  ).join("\n");
}
