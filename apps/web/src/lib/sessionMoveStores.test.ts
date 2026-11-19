// The per-key stores an account move carries (lib/sessionViewState.ts rekeySession): the view mode
// and the right panel, both in localStorage. The scroll positions and the subagent stack have their
// own tests (timelinePositions.test.ts, threadStack.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

// A browser-shaped global with localStorage, set before the modules load. It records the keys read,
// so the test learns each store's key name from the store itself.
const stored = new Map<string, string>();
const read: string[] = [];
Object.assign(globalThis, {
  window: {
    localStorage: {
      getItem: (k: string) => {
        read.push(k);
        return stored.get(k) ?? null;
      },
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});

const { moveSessionViewMode } = await import("./viewMode.ts");
const { moveRightPanel } = await import("../rightPanel.ts");

/** The key prefix a store reads for a session: the first key it asks for that ends with the probe. */
function prefixOf(run: (probe: string) => void): string {
  read.length = 0;
  run("probe-session");
  const key = read.find((k) => k.endsWith("probe-session"));
  assert.ok(key, "the store reads a key for the session");
  return key.slice(0, -"probe-session".length);
}

const MODE = prefixOf((probe) => moveSessionViewMode(probe, "probe-other"));
const PANEL = prefixOf((probe) => moveRightPanel(probe, "probe-other"));

test("a moved session keeps its own view mode under the new key", () => {
  stored.set(`${MODE}claude:a:s1`, JSON.stringify("terminal"));
  moveSessionViewMode("claude:a:s1", "claude:b:s1");
  assert.equal(stored.get(`${MODE}claude:b:s1`), JSON.stringify("terminal"));
  assert.equal(stored.has(`${MODE}claude:a:s1`), false);
  // Nothing of its own: the new key keeps opening in the default.
  moveSessionViewMode("claude:a:s2", "claude:b:s2");
  assert.equal(stored.has(`${MODE}claude:b:s2`), false);
});

test("a view mode the new key has already stays", () => {
  stored.set(`${MODE}claude:a:s3`, JSON.stringify("terminal"));
  stored.set(`${MODE}claude:b:s3`, JSON.stringify("chat"));
  moveSessionViewMode("claude:a:s3", "claude:b:s3");
  assert.equal(stored.get(`${MODE}claude:b:s3`), JSON.stringify("chat"));
  assert.equal(stored.has(`${MODE}claude:a:s3`), false);
});

test("a moved session keeps its right panel tabs and open state", () => {
  const panel = JSON.stringify({ open: true, tabs: [{ path: "/w/a.ts" }], active: "/w/a.ts" });
  stored.set(`${PANEL}claude:a:s1`, panel);
  moveRightPanel("claude:a:s1", "claude:b:s1");
  assert.equal(stored.get(`${PANEL}claude:b:s1`), panel);
  assert.equal(stored.has(`${PANEL}claude:a:s1`), false);
  // A second call for the same move changes nothing.
  moveRightPanel("claude:a:s1", "claude:b:s1");
  assert.equal(stored.get(`${PANEL}claude:b:s1`), panel);
});
