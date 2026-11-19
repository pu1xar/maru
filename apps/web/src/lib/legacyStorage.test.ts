import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LEGACY_KEY_PREFIX, moveLegacyKeys, renamedKey, type KeyValueStorage } from "./legacyStorage.ts";

/** A Storage over a Map; `full` makes every write throw as a full storage does. */
function fakeStorage(entries: Record<string, string>, full = false): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      if (full) throw new Error("QuotaExceededError");
      map.set(k, v);
    },
    removeItem: (k) => void map.delete(k),
  };
}

test("renamedKey maps the old prefix and leaves other keys alone", () => {
  assert.equal(renamedKey("chat_client_ui_scale"), "maru_ui_scale");
  assert.equal(renamedKey("chat_client_view_mode:claude:a:s1"), "maru_view_mode:claude:a:s1");
  assert.equal(renamedKey("maru_ui_scale"), null);
  assert.equal(renamedKey("other"), null);
});

// Keys from branches written before the rename: the prefix rule covers them without a list.
test("keys of branches named before the rename move too", () => {
  assert.equal(renamedKey("chat_client_theme"), "maru_theme");
  assert.equal(renamedKey("chat_client_file_tree_expanded"), "maru_file_tree_expanded");
  const s = fakeStorage({ chat_client_theme: '"light"', chat_client_file_tree_expanded: '{"/a":["/a/b"]}' });
  moveLegacyKeys(s);
  assert.deepEqual(Object.fromEntries(s.map), { maru_theme: '"light"', maru_file_tree_expanded: '{"/a":["/a/b"]}' });
});

test("every old key moves to its new name with the same value and the old key goes", () => {
  const s = fakeStorage({
    chat_client_ui_scale: "125",
    chat_client_sidebar_open: "false",
    "chat_client_right_panel:claude:a:s1": '{"tabs":[],"open":true}',
    "chat_client_view_mode:codex:b:t1": '"terminal"',
    "maru_composer_draft:claude:a:s1": "draft",
    unrelated: "x",
  });
  const r = moveLegacyKeys(s);
  assert.equal(r.moved.length, 4);
  assert.deepEqual(r.superseded, []);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(Object.fromEntries(s.map), {
    maru_ui_scale: "125",
    maru_sidebar_open: "false",
    "maru_right_panel:claude:a:s1": '{"tabs":[],"open":true}',
    "maru_view_mode:codex:b:t1": '"terminal"',
    "maru_composer_draft:claude:a:s1": "draft",
    unrelated: "x",
  });
});

test("a value already under the new name wins and the old key is removed", () => {
  const s = fakeStorage({ chat_client_ui_scale: "125", maru_ui_scale: "90" });
  const r = moveLegacyKeys(s);
  assert.deepEqual(r.superseded, ["chat_client_ui_scale"]);
  assert.deepEqual(Object.fromEntries(s.map), { maru_ui_scale: "90" });
});

test("a failed write keeps the old key for the next load", () => {
  const s = fakeStorage({ chat_client_ui_scale: "125" }, true);
  const r = moveLegacyKeys(s);
  assert.deepEqual(r.failed, ["chat_client_ui_scale"]);
  assert.deepEqual(Object.fromEntries(s.map), { chat_client_ui_scale: "125" });
});

test("a second load finds nothing to move", () => {
  const s = fakeStorage({ chat_client_ui_scale: "125" });
  moveLegacyKeys(s);
  assert.deepEqual(moveLegacyKeys(s), { moved: [], superseded: [], failed: [] });
});

// A key added under the old prefix would be moved away on every load and read back as missing.
test("no web source outside this module names a key with the old prefix", () => {
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const files: string[] = [path.join(webRoot, "index.html")];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|jsx|html|css)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(webRoot, "src"));
  const self = new Set(["legacyStorage.ts", "legacyStorage.test.ts"].map((n) => path.join(webRoot, "src/lib", n)));
  const violations = files.filter((f) => !self.has(f) && readFileSync(f, "utf8").includes(LEGACY_KEY_PREFIX));
  assert.ok(files.length > 100, `scanned ${files.length} files`);
  assert.deepEqual(violations, []);
});
