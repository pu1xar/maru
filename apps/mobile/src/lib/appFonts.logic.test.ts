import { test } from "node:test";
import assert from "node:assert/strict";
import { UI_FONTS } from "../../../web/src/lib/uiFonts.logic.ts";
import { TERMINAL_FONTS } from "../../../web/src/lib/viewMode.logic.ts";
import { SANS_FACES, codeFaces, downloadsFor, facesFor, loadedFamily, pickFace, weightNumber, type FontFace } from "./appFonts.logic.ts";

// A font CDN as a deployment sets it (build.env MARU_FONT_CDN); the module-level CODE_FACES reads the build's own.
const CDN = "https://cdn.example.com/fonts/v1/bon-google-sans-code";
const CODE_FACES = codeFaces(CDN);

const allFaces = (): FontFace[] => [...Object.values(SANS_FACES), ...Object.values(CODE_FACES)].flatMap((f) => f ?? []);

test("every font of the web's lists has files or is the phone's own", () => {
  // The web's interface fonts: the system one is the phone's, the other four have faces.
  for (const f of UI_FONTS) assert.equal(f.id === "system" ? SANS_FACES[f.id] === undefined : (SANS_FACES[f.id]?.length ?? 0) > 0, true, f.id);
  // The web's monospace fonts: Bon (both entries) and D2Coding have faces; SF Mono and the system monospace are the phone's.
  const withFiles = TERMINAL_FONTS.filter((f) => CODE_FACES[f.id]).map((f) => f.id);
  assert.deepEqual(withFiles, ["bon", "bon-web", "d2coding"]);
});

test("a face is a pinned ttf: Android reads no woff2 and no moving version", () => {
  let urls = 0;
  for (const f of allFaces()) {
    urls++;
    // An npm mirror at an exact version, or the font CDN's version directory (/fonts/v1/, immutable files).
    assert.match(
      f.source.uri,
      /^https:\/\/(cdn\.jsdelivr\.net\/npm\/(@[a-z0-9-]+\/)?[a-z0-9-]+@\d+\.\d+\.\d+\/|cdn\.example\.com\/fonts\/v\d+\/[a-z0-9-]+\/)/,
      f.source.uri,
    );
    assert.match(f.source.uri, /\.ttf$/, f.source.uri);
  }
  // Inter, Pretendard, Plex 4 each; Bon 2 (listed under both of its entries); D2Coding 2.
  assert.equal(urls, 4 + 4 + 4 + 2 + 2 + 2);
});

test("the faces of one family have distinct names and the weights the interface draws", () => {
  const names = allFaces().map((f) => f.family);
  assert.equal(new Set(names).size, [...new Set(names)].length);
  for (const id of ["inter", "pretendard", "plex-kr"] as const) assert.deepEqual(SANS_FACES[id]?.map((f) => f.weight), [400, 500, 600, 700]);
  assert.equal(SANS_FACES["noto-kr" as keyof typeof SANS_FACES], undefined);
});

test("Bon is one family of two font CDN ttf faces for both of its entries, and nothing ships in the app", () => {
  assert.deepEqual(CODE_FACES.bon?.map((f) => [f.family, f.weight]), [["maru-bon-400", 400], ["maru-bon-700", 700]]);
  assert.deepEqual(CODE_FACES.bon?.map((f) => f.source.uri), [
    `${CDN}/Bon-GoogleSansCode-Regular-android.ttf`,
    `${CDN}/Bon-GoogleSansCode-Bold-android.ttf`,
  ]);
  assert.equal(CODE_FACES["bon-web"], CODE_FACES.bon);
});

test("a style's weight as a number", () => {
  assert.equal(weightNumber(undefined), 400);
  assert.equal(weightNumber("normal"), 400);
  assert.equal(weightNumber("bold"), 700);
  assert.equal(weightNumber("600"), 600);
  assert.equal(weightNumber(500), 500);
  assert.equal(weightNumber("nonsense"), 400);
});

test("the nearest face wins and a tie goes to the heavier", () => {
  const faces = SANS_FACES.pretendard!.filter((f) => f.weight !== 500 && f.weight !== 600);
  assert.equal(pickFace(faces, 400)?.weight, 400);
  assert.equal(pickFace(faces, 600)?.weight, 700);
  assert.equal(pickFace(faces, 300)?.weight, 400);
  assert.equal(pickFace(faces, 900)?.weight, 700);
  assert.equal(pickFace([], 400), null);
});

test("only a loaded face is drawn in", () => {
  const faces = SANS_FACES.pretendard!;
  assert.equal(loadedFamily(faces, new Set(), 400), null);
  assert.equal(loadedFamily(faces, new Set(["maru-pretendard-400"]), 700), "maru-pretendard-400");
  assert.equal(loadedFamily(undefined, new Set(["x"]), 400), null);
});

test("a choice needs the interface font, the conversation's own font and the code font, each once", () => {
  assert.deepEqual(facesFor("system", "ui", "system"), []);
  assert.deepEqual(
    facesFor("pretendard", "ui", "system").map((f) => f.family),
    ["maru-pretendard-400", "maru-pretendard-500", "maru-pretendard-600", "maru-pretendard-700"],
  );
  assert.equal(facesFor("pretendard", "pretendard", "system").length, 4);
  assert.equal(facesFor("pretendard", "inter", "d2coding").length, 4 + 4 + 2);
  assert.equal(downloadsFor(facesFor("system", "ui", "bon", CODE_FACES)).length, 2);
  assert.equal(downloadsFor(facesFor("system", "ui", "d2coding", CODE_FACES)).length, 2);
});

test("without a font CDN the Bon entries have no files and D2Coding keeps its own", () => {
  const none = codeFaces(null);
  assert.equal(none.bon, undefined);
  assert.equal(none["bon-web"], undefined);
  assert.equal(none.d2coding?.length, 2);
  assert.deepEqual(facesFor("system", "ui", "bon", none), []);
});
