import assert from "node:assert/strict";
import { test } from "node:test";

import { filterFolderNames, folderMatchRank } from "./folderMatch.ts";

test("a name that starts with the prefix ranks before one that contains it", () => {
  assert.equal(folderMatchRank("pro", "Projects"), 0);
  assert.equal(folderMatchRank("pro", "improve"), 1);
  assert.equal(folderMatchRank("pro", "other"), null);
  assert.equal(folderMatchRank("", "anything"), 0);
});

test("filtering ignores case, puts starts-with first and hides dot folders until a dot is typed", () => {
  const names = ["improve", "proto", "Projects", ".profile", "other"];
  assert.deepEqual(filterFolderNames("pro", names), ["Projects", "proto", "improve"]);
  assert.deepEqual(filterFolderNames("", names), ["Projects", "improve", "other", "proto"]);
  assert.deepEqual(filterFolderNames(".pro", names), [".profile"]);
});
