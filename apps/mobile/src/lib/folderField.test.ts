import assert from "node:assert/strict";
import { test } from "node:test";

// The folder input (components/FolderPathInput.tsx) runs the web's pure folder rules, read by path.
import { folderFieldView, readFolders, tabComplete, withEntry } from "../../../web/src/lib/folderInput.ts";

const H = "/Users/me";
const answer = (parent: string, dirs: string[], status: "ok" | "missing" | "not-folder" = "ok") => ({ dirs, expanded: `${parent}/`, parent, status });

test("tapping a row goes one folder in, Complete fills the shared start", () => {
  const dirs = [`${H}/projects`, `${H}/proto`];
  assert.equal(`${withEntry("~/pro", dirs[0]!)}/`, "~/projects/");
  assert.equal(tabComplete("~/p", dirs, -1), "~/pro");
  assert.equal(tabComplete("~/pro", [dirs[0]!], -1), "~/projects/");
});

test("a typed path is read once the server answers: the subfolders, and a missing folder as No such folder", async () => {
  const complete = async (q: string) => (q.endsWith("nope/") ? answer(`${H}/nope`, [], "missing") : answer(H, [`${H}/projects`]));
  const { list, check } = await readFolders("~/nope", complete);
  const view = folderFieldView("~/nope", { key: "~/nope", list, check, error: null }, []);
  assert.equal(view.reason, "No such folder");
  assert.equal(view.resolvedPath, null);
  const ok = await readFolders("~/", complete);
  const listed = folderFieldView("~/", { key: "~/", list: ok.list, check: ok.check, error: null }, []);
  assert.deepEqual(listed.rows, [`${H}/projects`]);
  assert.equal(listed.resolvedPath, H);
});
