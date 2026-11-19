import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COLLAPSED_GROUPS_CACHE_KEY,
  COLLAPSED_GROUPS_LEGACY_KEY,
  clearLegacyCollapsedGroups,
  parseCollapsedGroups,
  readCollapsedGroupsCache,
  readLegacyCollapsedGroups,
  withFolded,
  writeCollapsedGroupsCache,
} from "./collapsedGroups.ts";

function fakeStorage(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

test("parseCollapsedGroups reads a list of keys and ignores anything else", () => {
  assert.deepEqual([...parseCollapsedGroups('["pinned","proj-1"]')], ["pinned", "proj-1"]);
  assert.equal(parseCollapsedGroups(null).size, 0);
  assert.equal(parseCollapsedGroups("not json").size, 0);
  assert.equal(parseCollapsedGroups('{"a":1}').size, 0);
  assert.equal(parseCollapsedGroups('["a",2]').size, 0);
});

test("withFolded sets one key to the asked state without touching the input", () => {
  const start = new Set(["a"]);
  assert.deepEqual([...withFolded(start, "b", true)].sort(), ["a", "b"]);
  assert.deepEqual([...withFolded(start, "a", false)], []);
  assert.deepEqual([...withFolded(start, "a", true)], ["a"]);
  assert.deepEqual([...start], ["a"]);
});

test("the first paint reads the server copy, else the older build's list", () => {
  const both = fakeStorage({ [COLLAPSED_GROUPS_CACHE_KEY]: '["a"]', [COLLAPSED_GROUPS_LEGACY_KEY]: '["b"]' });
  assert.deepEqual([...readCollapsedGroupsCache(both)], ["a"]);
  const legacyOnly = fakeStorage({ [COLLAPSED_GROUPS_LEGACY_KEY]: '["b"]' });
  assert.deepEqual([...readCollapsedGroupsCache(legacyOnly)], ["b"]);
  assert.equal(readCollapsedGroupsCache(fakeStorage()).size, 0);
});

test("an empty server list is written as an empty copy, not removed", () => {
  const s = fakeStorage({ [COLLAPSED_GROUPS_LEGACY_KEY]: '["b"]' });
  writeCollapsedGroupsCache(new Set(), s);
  assert.equal(s.map.get(COLLAPSED_GROUPS_CACHE_KEY), "[]");
  assert.equal(readCollapsedGroupsCache(s).size, 0);
});

test("the older list is read for the import and cleared after it", () => {
  const s = fakeStorage({ [COLLAPSED_GROUPS_LEGACY_KEY]: '["pinned","x"]' });
  assert.deepEqual(readLegacyCollapsedGroups(s), ["pinned", "x"]);
  clearLegacyCollapsedGroups(s);
  assert.equal(readLegacyCollapsedGroups(s), null);
});
