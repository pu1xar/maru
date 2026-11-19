import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCodexBin } from "../userConfig.ts";

test("the codex CLI is the first one on the server's PATH, as an absolute path", () => {
  const files = new Set(["/opt/b/codex", "/usr/bin/codex"]);
  const isFile = (p: string) => files.has(p);
  assert.equal(resolveCodexBin("/x:/opt/b:/usr/bin", isFile), "/opt/b/codex");
  assert.equal(resolveCodexBin("relative:/usr/bin", isFile), "/usr/bin/codex");
  assert.equal(resolveCodexBin("/x", isFile), "codex");
  assert.equal(resolveCodexBin("", isFile), "codex");
});
