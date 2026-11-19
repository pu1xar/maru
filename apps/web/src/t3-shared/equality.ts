// Stand-ins for the two equality checks T3's timeline logic imports: zustand's `shallow`
// (zustand/vanilla/shallow) and Effect's structural `Equal.equals` (effect/Equal), which T3 Code
// (https://github.com/pingdotgg/t3code, MIT) uses on plain objects, arrays, Maps and Sets.

function isIterable(value: object): value is Iterable<unknown> {
  return Symbol.iterator in value;
}

/** One level deep: same keys with Object.is values, or same Map/Set/iterable entries in order. */
export function shallow<T>(left: T, right: T): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  if (left instanceof Map && right instanceof Map) {
    if (left.size !== right.size) return false;
    for (const [key, value] of left) {
      if (!right.has(key) || !Object.is(value, right.get(key))) return false;
    }
    return true;
  }
  if (left instanceof Set && right instanceof Set) {
    if (left.size !== right.size) return false;
    for (const value of left) if (!right.has(value)) return false;
    return true;
  }
  if (isIterable(left) && isIterable(right)) {
    const a = [...left];
    const b = [...right];
    return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}

/** Deep value equality for plain data (objects, arrays, Maps, Sets, Dates); cycles compare equal. */
export function structuralEqual(left: unknown, right: unknown): boolean {
  return compare(left, right, []);
}

function compare(left: unknown, right: unknown, path: Array<readonly [unknown, unknown]>): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  for (const [a, b] of path) if (a === left && b === right) return true;
  path.push([left, right]);
  try {
    if (left instanceof Date || right instanceof Date) {
      return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
    }
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
        return false;
      }
      return left.every((value, index) => compare(value, right[index], path));
    }
    if (left instanceof Map || right instanceof Map) {
      if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) {
        return false;
      }
      for (const [key, value] of left) {
        if (!right.has(key) || !compare(value, right.get(key), path)) return false;
      }
      return true;
    }
    if (left instanceof Set || right instanceof Set) {
      if (!(left instanceof Set) || !(right instanceof Set) || left.size !== right.size) {
        return false;
      }
      for (const value of left) if (!right.has(value)) return false;
      return true;
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    if (leftKeys.length !== Object.keys(rightRecord).length) return false;
    return leftKeys.every(
      (key) => Object.hasOwn(rightRecord, key) && compare(leftRecord[key], rightRecord[key], path),
    );
  } finally {
    path.pop();
  }
}
