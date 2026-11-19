import { test } from "node:test";
import assert from "node:assert/strict";
import { UI_FONTS, normalizeChatFont, normalizeUiFont } from "./uiFonts.logic.ts";

test("the list offers system, Inter, Pretendard and IBM Plex Sans KR", () => {
  assert.deepEqual(UI_FONTS.map((f) => f.id), ["system", "inter", "pretendard", "plex-kr"]);
});

test("a stored Noto Sans KR choice reads as the default", () => {
  assert.equal(normalizeUiFont("noto-kr"), "system");
  assert.equal(normalizeChatFont("noto-kr"), "ui");
  assert.equal(normalizeUiFont("plex-kr"), "plex-kr");
  assert.equal(normalizeChatFont("ui"), "ui");
});
