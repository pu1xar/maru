// The fonts the settings offer (the web's lists: web/src/lib/uiFonts.logic.ts for the interface and
// the conversation, web/src/lib/viewMode.logic.ts for the chat code) and the files the app loads for
// them. The web draws a font from a stylesheet of unicode-range woff2 files; Android reads only
// whole TrueType or OpenType files, so each family here is a few static `.ttf` faces at pinned
// versions. A face is downloaded the first time a setting chooses its font (the system fonts have
// none), and the phone keeps the file in its cache. React Native-free, so a node test reads it.
import { normalizeFontCdn } from "../../../../packages/shared/src/bonFont.ts";
import type { UiFontId } from "../../../web/src/lib/uiFonts.logic.ts";
import type { TerminalFontId } from "../../../web/src/lib/viewMode.logic.ts";

/** Where a face's file comes from: a pinned URL. */
export type FaceSource = { uri: string };

export interface FontFace {
  /** The name the face is registered under with the native font loader. */
  family: string;
  /** 400, 500, 600 or 700. */
  weight: number;
  source: FaceSource;
}

const JSDELIVR = "https://cdn.jsdelivr.net/npm";
const INTER = `${JSDELIVR}/@expo-google-fonts/inter@0.4.1`;
const PRETENDARD = `${JSDELIVR}/pretendard@1.3.9/dist/public/static/alternative`;
const PLEX_KR = `${JSDELIVR}/@expo-google-fonts/ibm-plex-sans-kr@0.4.1`;
const D2CODING = `${JSDELIVR}/d2coding@1.3.2/fonts`;
/**
 * The directory the deployment's font CDN serves Bon Google Sans Code from (a version directory of
 * immutable files, so the path pins them): MARU_FONT_CDN in build.env, which the build hands to
 * Metro as EXPO_PUBLIC_MARU_FONT_CDN. Null when unset; the Bon entries then have no files.
 */
export const FONT_CDN: string | null = normalizeFontCdn(process.env.EXPO_PUBLIC_MARU_FONT_CDN);

const NAMED: Record<number, string> = { 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold" };

/** The @expo-google-fonts file of a family at a weight: `<weight><Name>/<Prefix>_<weight><Name>.ttf`. */
function expoGoogle(base: string, prefix: string, weight: number): string {
  const tag = `${weight}${NAMED[weight]}`;
  return `${base}/${tag}/${prefix}_${tag}.ttf`;
}

function face(family: string, weight: number, uri: string): FontFace {
  return { family: `${family}-${weight}`, weight, source: { uri } };
}

const WEIGHTS = [400, 500, 600, 700] as const;

/**
 * The interface and conversation fonts that need files. "system" has none: it is the phone's own
 * font, as the web's system stack is the platform's.
 */
export const SANS_FACES: Partial<Record<UiFontId, readonly FontFace[]>> = {
  inter: WEIGHTS.map((w) => face("maru-inter", w, expoGoogle(INTER, "Inter", w))),
  pretendard: WEIGHTS.map((w) => face("maru-pretendard", w, `${PRETENDARD}/Pretendard-${NAMED[w]}.ttf`)),
  "plex-kr": WEIGHTS.map((w) => face("maru-plex-kr", w, expoGoogle(PLEX_KR, "IBMPlexSansKR", w))),
};

/**
 * The chat code fonts that need files. The two Bon entries share one family: Bon Google Sans Code
 * (English from Google Sans Code, Hangul from Sarasa Fixed K) as one ttf per weight on the font CDN
 * `cdn`, the same 12,185 code points the web's latin and hangul pieces carry (about 2.4 MB a
 * weight). Without a CDN the Bon entries have no files and draw in the phone's monospace. SF Mono
 * and the system monospace have no file: they are the phone's monospace, as the web's stacks fall
 * back off Apple devices.
 */
export function codeFaces(cdn: string | null): Partial<Record<TerminalFontId, readonly FontFace[]>> {
  const faces: Partial<Record<TerminalFontId, readonly FontFace[]>> = {
    d2coding: [
      face("maru-d2coding", 400, `${D2CODING}/d2coding-full.ttf`),
      face("maru-d2coding", 700, `${D2CODING}/d2coding-bold-full.ttf`),
    ],
  };
  if (cdn) {
    const bon: readonly FontFace[] = [
      face("maru-bon", 400, `${cdn}/Bon-GoogleSansCode-Regular-android.ttf`),
      face("maru-bon", 700, `${cdn}/Bon-GoogleSansCode-Bold-android.ttf`),
    ];
    return { bon, "bon-web": bon, ...faces };
  }
  return faces;
}

export const CODE_FACES: Partial<Record<TerminalFontId, readonly FontFace[]>> = codeFaces(FONT_CDN);

/** A style's fontWeight as a number: "bold" is 700, "normal" and no weight 400, and 100 to 900 as written. */
export function weightNumber(weight: unknown): number {
  if (weight === "bold") return 700;
  if (weight === undefined || weight === "normal") return 400;
  const n = typeof weight === "number" ? weight : Number(weight);
  return Number.isFinite(n) ? n : 400;
}

/** The face weight nearest to `weight`; between two, the heavier. Null when there are no faces. */
export function pickFace(faces: readonly FontFace[], weight: number): FontFace | null {
  let best: FontFace | null = null;
  for (const f of faces) {
    if (best === null) best = f;
    else {
      const d = Math.abs(f.weight - weight);
      const bd = Math.abs(best.weight - weight);
      if (d < bd || (d === bd && f.weight > best.weight)) best = f;
    }
  }
  return best;
}

/**
 * The family to draw `weight` in: the nearest face among those already loaded, null while none is
 * (the text then stays in the phone's font and moves over when the file arrives).
 */
export function loadedFamily(faces: readonly FontFace[] | undefined, loaded: ReadonlySet<string>, weight: number): string | null {
  if (!faces) return null;
  return pickFace(faces.filter((f) => loaded.has(f.family)), weight)?.family ?? null;
}

/** The faces a choice of fonts needs: the interface font, the conversation font (when it has its own) and the chat code font. */
export function facesFor(ui: UiFontId, chat: UiFontId | "ui", code: TerminalFontId, codeSet = CODE_FACES): FontFace[] {
  const all = [...(SANS_FACES[ui] ?? []), ...(chat === "ui" ? [] : (SANS_FACES[chat] ?? [])), ...(codeSet[code] ?? [])];
  const seen = new Set<string>();
  return all.filter((f) => (seen.has(f.family) ? false : (seen.add(f.family), true)));
}

/** The URLs a choice of fonts downloads. */
export function downloadsFor(faces: readonly FontFace[]): string[] {
  return faces.map((f) => f.source.uri);
}
