import assert from "node:assert/strict";
import { test } from "node:test";

import { AREA_ZOOM_STEPS } from "./areaZoom.logic.ts";
import { BACKDROP_STEPS } from "./desktopBackdrop.ts";
import { CHAT_TEXT_STEPS, UI_SCALE_STEPS } from "./displayPrefs.logic.ts";
import { clampInt, inIntRange, parseTypedNumber, pickedValue, rangeOfSteps } from "./settingControl.logic.ts";
import { TERMINAL_FONT_SIZES } from "./viewMode.logic.ts";

test("rangeOfSteps: the first and last step bound each number row", () => {
  assert.deepEqual(rangeOfSteps(CHAT_TEXT_STEPS), { min: 11, max: 22 });
  assert.deepEqual(rangeOfSteps(TERMINAL_FONT_SIZES), { min: 11, max: 22 });
  assert.deepEqual(rangeOfSteps(UI_SCALE_STEPS), { min: 80, max: 150 });
  assert.deepEqual(rangeOfSteps(AREA_ZOOM_STEPS), { min: 85, max: 150 });
  assert.deepEqual(rangeOfSteps(BACKDROP_STEPS), { min: 10, max: 40 });
});

test("inIntRange: whole numbers inside the range, ends included", () => {
  const r = rangeOfSteps(CHAT_TEXT_STEPS);
  assert.equal(inIntRange(11, r), true);
  assert.equal(inIntRange(22, r), true);
  assert.equal(inIntRange(14, r), true);
  assert.equal(inIntRange(10, r), false);
  assert.equal(inIntRange(23, r), false);
  assert.equal(inIntRange(14.5, r), false);
  assert.equal(inIntRange("14", r), false);
  assert.equal(inIntRange(null, r), false);
  assert.equal(inIntRange(Number.NaN, r), false);
});

test("clampInt: rounds, then holds to the range", () => {
  const r = rangeOfSteps(UI_SCALE_STEPS);
  assert.equal(clampInt(112, r), 112);
  assert.equal(clampInt(112.6, r), 113);
  assert.equal(clampInt(10, r), 80);
  assert.equal(clampInt(900, r), 150);
});

test("parseTypedNumber: the nearest allowed number, null for text that is no number", () => {
  const r = rangeOfSteps(CHAT_TEXT_STEPS);
  assert.equal(parseTypedNumber("15", r), 15);
  assert.equal(parseTypedNumber(" 15pt ", r), 15);
  assert.equal(parseTypedNumber("3", r), 11);
  assert.equal(parseTypedNumber("99", r), 22);
  assert.equal(parseTypedNumber("14.4", r), 14);
  assert.equal(parseTypedNumber("110 %", rangeOfSteps(UI_SCALE_STEPS)), 110);
  assert.equal(parseTypedNumber("", r), null);
  assert.equal(parseTypedNumber("abc", r), null);
  assert.equal(parseTypedNumber("1e3", r), null);
});

test("pickedValue: a known string, never an empty press", () => {
  assert.equal(pickedValue(["light"], ["system", "light", "dark"]), "light");
  assert.equal(pickedValue([], ["system", "light", "dark"]), null);
  assert.equal(pickedValue(["sepia"], ["system", "light", "dark"]), null);
  assert.equal(pickedValue([3], ["3"]), null);
});
