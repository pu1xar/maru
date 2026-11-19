import assert from "node:assert/strict";
import { test } from "node:test";
import type { FolderCompletion } from "@maru/shared";

import {
  checkQuery,
  commonPrefix,
  folderFieldView,
  folderInputKind,
  folderKeyAction,
  type FolderKeyState,
  judgeFolder,
  listingQuery,
  moveHighlight,
  parentPart,
  readFolders,
  RELATIVE_REASON,
  tabComplete,
  typedPrefix,
  withEntry,
} from "./folderInput.ts";

const H = "/Users/me";

test("input kinds: empty, a path from ~ or /, anything else", () => {
  assert.equal(folderInputKind(""), "empty");
  assert.equal(folderInputKind("   "), "empty");
  assert.equal(folderInputKind("~"), "path");
  assert.equal(folderInputKind("~/projects"), "path");
  assert.equal(folderInputKind(" /tmp"), "path");
  assert.equal(folderInputKind("projects"), "relative");
  assert.equal(folderInputKind("~me/x"), "relative");
  assert.equal(folderInputKind("./x"), "relative");
});

test("queries: listing and folder check", () => {
  assert.equal(listingQuery("~"), "~/");
  assert.equal(listingQuery("~/pro"), "~/pro");
  assert.equal(checkQuery("~"), "~/");
  assert.equal(checkQuery("~/"), "~/");
  assert.equal(checkQuery("~/projects"), "~/projects/");
  assert.equal(checkQuery("~/projects//"), "~/projects/");
  assert.equal(checkQuery("/"), "/");
  assert.equal(checkQuery("//"), "/");
  assert.equal(checkQuery("/tmp/a b"), "/tmp/a b/");
});

test("parent part and typed prefix", () => {
  assert.equal(parentPart("~/projects/0"), "~/projects/");
  assert.equal(typedPrefix("~/projects/0"), "0");
  assert.equal(parentPart("~/projects/"), "~/projects/");
  assert.equal(typedPrefix("~/projects/"), "");
  assert.equal(parentPart("~"), "~/");
  assert.equal(typedPrefix("~"), "");
  assert.equal(parentPart("/"), "/");
  assert.equal(withEntry("~/pro", `${H}/projects`), "~/projects");
  assert.equal(withEntry("~", `${H}/projects`), "~/projects");
  assert.equal(withEntry("/", "/Users"), "/Users");
});

test("common prefix ignores case and keeps the first name's letters", () => {
  assert.equal(commonPrefix([]), "");
  assert.equal(commonPrefix(["abc"]), "abc");
  assert.equal(commonPrefix(["00_alpha", "01_beta"]), "0");
  assert.equal(commonPrefix(["Apple", "apricot"]), "Ap");
  assert.equal(commonPrefix(["a", "b"]), "");
  assert.equal(commonPrefix(["proto", "projects"]), "pro");
  assert.equal(commonPrefix(["ab", "abc"]), "ab");
});

test("Tab: a highlighted row, one match, a shared start, nothing to add", () => {
  const dirs = [`${H}/projects/00_alpha`, `${H}/projects/01_beta`, `${H}/projects/02_gamma`];
  // A highlighted row is taken whole, with its slash.
  assert.equal(tabComplete("~/projects/0", dirs, 1), "~/projects/01_beta/");
  // Several matches fill up to what they share.
  assert.equal(tabComplete("~/projects/", dirs, -1), "~/projects/0");
  assert.equal(tabComplete("~/projects/", [`${H}/projects/00_alpha`, `${H}/projects/00_x`], -1), "~/projects/00_");
  // Nothing more to add: unchanged (null), as a shell leaves the line.
  assert.equal(tabComplete("~/projects/0", dirs, -1), null);
  // One match: the whole name and a slash, also for a bare `~` and for `/`.
  assert.equal(tabComplete("~/pro", [`${H}/projects`], -1), "~/projects/");
  assert.equal(tabComplete("~", [`${H}/projects`], -1), "~/projects/");
  assert.equal(tabComplete("/Us", ["/Users"], -1), "/Users/");
  // An exact folder with a longer sibling stays put; a different case is corrected.
  assert.equal(tabComplete("~/projects", [`${H}/projects`, `${H}/projects2`], -1), null);
  assert.equal(tabComplete("~/pro", [`${H}/Projects`, `${H}/Proto`], -1), "~/Pro");
  assert.equal(tabComplete("~/zzz", [], -1), null);
});

test("highlight wraps in both directions", () => {
  assert.equal(moveHighlight(-1, 3, "down"), 0);
  assert.equal(moveHighlight(0, 3, "down"), 1);
  assert.equal(moveHighlight(2, 3, "down"), 0);
  assert.equal(moveHighlight(-1, 3, "up"), 2);
  assert.equal(moveHighlight(0, 3, "up"), 2);
  assert.equal(moveHighlight(2, 3, "up"), 1);
  assert.equal(moveHighlight(0, 0, "down"), -1);
});

test("a path can be taken only when the server read it as a folder", () => {
  const listed = (status: FolderCompletion["status"], parent = `${H}/p`): FolderCompletion => ({
    dirs: [],
    expanded: `${parent}/`,
    parent,
    status,
  });
  assert.deepEqual(judgeFolder("~/p", listed("ok")), { ok: true, path: `${H}/p` });
  assert.deepEqual(judgeFolder("~/p", listed("missing")), { ok: false, reason: "No such folder" });
  assert.deepEqual(judgeFolder("~/p", listed("not-folder")), { ok: false, reason: "Not a folder" });
  assert.match((judgeFolder("~/p", listed("unreadable")) as { reason: string }).reason, /cannot be read/);
  assert.deepEqual(judgeFolder("p", listed("ok")), { ok: false, reason: RELATIVE_REASON });
  assert.deepEqual(judgeFolder("", listed("ok")), { ok: false, reason: RELATIVE_REASON });
});

test("Tab ignores names that only contain the typed part, unless they are all there is", () => {
  const dirs = [`${H}/Projects`, `${H}/proto`, `${H}/improve`];
  assert.equal(tabComplete("~/pro", dirs, -1), "~/Pro", "the two that start with it share Pro (the case is corrected); improve is not counted");
  assert.equal(tabComplete("~/pro", [`${H}/improve`], -1), "~/improve/", "one contain-match is taken whole");
  assert.equal(tabComplete("~/pro", [`${H}/improve`, `${H}/approve`], -1), null, "several contain-matches share nothing to fill");
  assert.equal(tabComplete("~/pro", [`${H}/improve`, `${H}/projects`], -1), "~/projects/", "the one that starts with it wins");
  assert.equal(tabComplete("~/pro", dirs, 2), "~/improve/", "a highlighted row is taken even if it only contains the text");
});

const key = (over: Partial<FolderKeyState>): FolderKeyState => ({
  key: "Tab", shiftKey: false, composing: false, kind: "path", rows: 3, highlighted: -1, listOpen: true, caretAtEnd: true, ...over,
});

test("keys: arrows pick, Tab and the right arrow complete, Enter confirms, Escape closes", () => {
  assert.deepEqual(folderKeyAction(key({ key: "ArrowDown" })), { type: "move", dir: "down" });
  assert.deepEqual(folderKeyAction(key({ key: "ArrowUp" })), { type: "move", dir: "up" });
  assert.equal(folderKeyAction(key({ key: "ArrowDown", rows: 0 })), null);
  assert.deepEqual(folderKeyAction(key({ key: "Tab" })), { type: "complete" });
  assert.deepEqual(folderKeyAction(key({ key: "ArrowRight" })), { type: "complete" });
  assert.deepEqual(folderKeyAction(key({ key: "Enter" })), { type: "confirm" });
  assert.deepEqual(folderKeyAction(key({ key: "Escape" })), { type: "close" });
  assert.equal(folderKeyAction(key({ key: "a" })), null);
});

test("keys: what is left to the browser or the dialog", () => {
  assert.equal(folderKeyAction(key({ key: "Tab", shiftKey: true })), null, "Shift+Tab moves focus back");
  assert.equal(folderKeyAction(key({ key: "Tab", listOpen: false })), null, "no list, Tab moves on");
  assert.equal(folderKeyAction(key({ key: "Tab", rows: 0 })), null);
  assert.equal(folderKeyAction(key({ key: "Tab", kind: "relative" })), null);
  assert.equal(folderKeyAction(key({ key: "ArrowRight", caretAtEnd: false })), null, "inside the text the arrow moves the caret");
  assert.equal(folderKeyAction(key({ key: "ArrowRight", shiftKey: true })), null, "Shift+Right extends a selection");
  assert.equal(folderKeyAction(key({ key: "Escape", listOpen: false })), null, "a second Escape reaches the dialog");
});

test("keys: an empty field takes a recent folder only once one is highlighted", () => {
  assert.equal(folderKeyAction(key({ key: "Tab", kind: "empty" })), null);
  assert.deepEqual(folderKeyAction(key({ key: "Tab", kind: "empty", highlighted: 1 })), { type: "complete" });
  assert.deepEqual(folderKeyAction(key({ key: "Enter", kind: "empty" })), { type: "swallow" });
  assert.deepEqual(folderKeyAction(key({ key: "Enter", kind: "empty", highlighted: 0 })), { type: "confirm" });
});

test("keys: a key that belongs to the IME is left alone", () => {
  for (const k of ["ArrowDown", "Tab", "ArrowRight", "Enter", "Escape"]) {
    assert.equal(folderKeyAction(key({ key: k, composing: true })), null, k);
  }
});

const answer = (status: FolderCompletion["status"], parent: string, dirs: string[] = []): FolderCompletion => ({ dirs, expanded: `${parent}/`, parent, status });

test("reading folders asks once when the listing is the folder check, twice otherwise", async () => {
  const asked: string[] = [];
  const complete = async (q: string) => (asked.push(q), answer("ok", H, [`${H}/a`]));
  await readFolders("~/", complete);
  assert.deepEqual(asked, ["~/"]);
  asked.length = 0;
  const r = await readFolders("~/pro", complete);
  assert.deepEqual(asked.sort(), ["~/pro", "~/pro/"]);
  assert.deepEqual(r.list.dirs, [`${H}/a`]);
});

test("the field shows the recent folders while empty, then the last answer's subfolders", () => {
  const recent = [`${H}/a`, `${H}/b`];
  const empty = folderFieldView("", null, recent);
  assert.deepEqual(empty.rows, recent);
  assert.equal(empty.reason, null);
  const lookup = { key: "~/p", list: answer("ok", H, [`${H}/projects`]), check: answer("missing", `${H}/p`), error: null };
  const typed = folderFieldView("~/p", lookup, recent);
  assert.deepEqual(typed.rows, [`${H}/projects`]);
  assert.equal(typed.reason, "No such folder");
  assert.equal(typed.resolvedPath, null);
  // More text typed: the old rows stay until the new answer arrives, and the field is waiting.
  const waiting = folderFieldView("~/pr", lookup, recent);
  assert.deepEqual(waiting.rows, [`${H}/projects`]);
  assert.equal(waiting.rowBase, "~/p");
  assert.equal(waiting.checking, true);
  assert.equal(waiting.reason, null);
});

test("the field resolves an existing folder, unless the caller rejects it", () => {
  const lookup = { key: "~/p", list: answer("ok", H), check: answer("ok", `${H}/p`), error: null };
  assert.equal(folderFieldView("~/p", lookup, []).resolvedPath, `${H}/p`);
  const rejected = folderFieldView("~/p", lookup, [], (d) => (d === `${H}/p` ? "This is the current working folder" : null));
  assert.equal(rejected.resolvedPath, null);
  assert.equal(rejected.reason, "This is the current working folder");
  const file = { key: "~/f", list: answer("ok", H), check: answer("not-folder", `${H}/f`), error: null };
  assert.equal(folderFieldView("~/f", file, []).reason, "Not a folder");
  assert.equal(folderFieldView("work", null, []).reason, RELATIVE_REASON);
});
