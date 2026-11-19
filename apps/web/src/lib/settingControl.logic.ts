// The rules behind the Appearance rows' controls (Settings, Appearance; DESIGN.md 6g). The shape of
// the data picks the control: a few labeled choices sit on one line (segmented), colors are
// circles, a number is typed (whole numbers between a minimum and a maximum), a long list (the
// fonts, each drawn in its own face) is a select. React-free, so the Android app reads the same rules.

/**
 * The value a toggle group's change event picks. The group lets the pressed item be pressed again,
 * which empties it; a choice always has a value, so an empty or unknown press picks nothing (null).
 */
export function pickedValue(pressed: readonly unknown[], values: readonly string[]): string | null {
  const next = pressed[0];
  return typeof next === "string" && values.includes(next) ? next : null;
}

/** The whole numbers a number setting takes, both ends included. */
export interface IntRange {
  min: number;
  max: number;
}

/**
 * The range a list of steps spans (a sorted list: the first and last). The lists stay as the grid
 * the wheel and the pinch move on (areaZoom.ts stepValue); a typed number may sit between them.
 */
export function rangeOfSteps(steps: readonly number[]): IntRange {
  return { min: steps[0]!, max: steps[steps.length - 1]! };
}

/** Whether a stored value is a whole number inside the range. */
export function inIntRange(value: unknown, range: IntRange): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= range.min && value <= range.max;
}

/** A typed number as the nearest allowed whole number (rounded, then held to the range). */
export function clampInt(value: number, range: IntRange): number {
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/**
 * What typed text means: the nearest allowed whole number, or null when it is not a number at all
 * (the field then goes back to the value it had). Accepts a trailing unit or space ("15pt", "110 %").
 */
export function parseTypedNumber(text: string, range: IntRange): number | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:pt|%)?\s*$/i.exec(text);
  return m ? clampInt(Number(m[1]), range) : null;
}
