import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { PickFolderError, pickFolder, pickFolderScript } from "./pickFolder.ts";

test("the script quotes the prompt and the default folder for AppleScript", () => {
  const s = pickFolderScript('a "b" \\c', "/tmp/x");
  assert.match(s, /with prompt "a \\"b\\" \\\\c"/);
  assert.match(s, /POSIX file "\/tmp\/x" as alias/);
  assert.match(s, /on error number -128/);
});

test("a choice comes back without its trailing slash, a cancel as cancelled, one dialog at a time", async (t) => {
  if (process.platform !== "darwin") return t.skip("macOS only");
  let release!: (v: string) => void;
  const first = pickFolder({ defaultPath: os.tmpdir() }, () => new Promise((r) => (release = r)));
  await assert.rejects(pickFolder({}, async () => ""), (e: unknown) => e instanceof PickFolderError && e.status === 409);
  release("/Users/x/proj/\n");
  assert.deepEqual(await first, { path: "/Users/x/proj" });
  assert.deepEqual(await pickFolder({}, async () => "\n"), { cancelled: true });
  // A missing default folder falls back instead of failing the dialog.
  let script = "";
  await pickFolder({ defaultPath: "/no/such/dir" }, async (s) => ((script = s), "/a/"));
  assert.doesNotMatch(script, /no\/such/);
});
