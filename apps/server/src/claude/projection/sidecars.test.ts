import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configDirsResolver, createFsSidecars } from "./sidecars.ts";

test("workflowResumed: the journal written after the final record, across config dirs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidecars-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  const transcript = path.join(a, "projects", "-w", "S1.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "");
  // A resumed session writes the final record under one account and the journal under another.
  const final = path.join(a, "projects", "-w", "S1", "workflows", "wf_1.json");
  const journal = path.join(b, "projects", "-w", "S1", "subagents", "workflows", "wf_1", "journal.jsonl");
  fs.mkdirSync(path.dirname(final), { recursive: true });
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  fs.writeFileSync(final, JSON.stringify({ status: "killed" }));
  fs.writeFileSync(journal, '{"type":"launched"}\n');
  const s = createFsSidecars(transcript, configDirsResolver([a, b]));

  fs.utimesSync(journal, new Date(1000_000), new Date(1000_000));
  fs.utimesSync(final, new Date(2000_000), new Date(2000_000));
  assert.equal(s.workflowResumed("wf_1"), false, "the final record came last: settled");
  fs.utimesSync(journal, new Date(3000_000), new Date(3000_000));
  assert.equal(s.workflowResumed("wf_1"), true, "the journal moved on past it: resumed");
  assert.equal(s.workflowResumed("wf_2"), false, "no files");
  assert.equal(s.workflowResumed("../wf_1"), false, "not a run id");
  fs.rmSync(final);
  assert.equal(s.workflowResumed("wf_1"), false, "a first run before its final record is not a resume");
});
