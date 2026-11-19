import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { FileError, TEXT_PAGE_BYTES, fileFetchAllowed, readFileView, resolveRequestPath, sendRawFile } from "./fileView.ts";

function tmpdir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fileview-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("paths: ~ expands, relative and empty are refused", () => {
  assert.equal(resolveRequestPath("~/x/../y"), path.join(os.homedir(), "y"));
  assert.throws(() => resolveRequestPath("src/a.ts"), (e: unknown) => e instanceof FileError && e.status === 400);
  assert.throws(() => resolveRequestPath(null), (e: unknown) => e instanceof FileError && e.status === 400);
  assert.throws(() => readFileView("/no/such/file"), (e: unknown) => e instanceof FileError && e.status === 404);
});

test("a text file comes in pages that end on a line break and together make the whole file", (t) => {
  const dir = tmpdir(t);
  const f = path.join(dir, "big.ts");
  // Multi-byte text so a page cut in the middle of a character would show.
  const line = "const 한글 = \"값\"; // 0123456789\n";
  const whole = line.repeat(Math.ceil((TEXT_PAGE_BYTES * 2.5) / Buffer.byteLength(line)));
  fs.writeFileSync(f, whole);

  let offset: number | null = 0;
  let joined = "";
  let pages = 0;
  while (offset !== null) {
    const v = readFileView(f, String(offset));
    assert.equal(v.kind, "text");
    if (v.kind !== "text") return;
    assert.equal(v.language, "ts");
    assert.equal(v.offset, offset);
    if (v.nextOffset !== null) assert.ok(v.text.endsWith("\n"), "a middle page ends on a line break");
    joined += v.text;
    offset = v.nextOffset;
    pages++;
  }
  assert.equal(pages, 3);
  assert.equal(joined, whole);
});

test("a page with no line break still cuts on a whole character", (t) => {
  const dir = tmpdir(t);
  const f = path.join(dir, "one-line.txt");
  const whole = "가".repeat(TEXT_PAGE_BYTES); // 3 bytes each, no newline
  fs.writeFileSync(f, whole);
  let offset: number | null = 0;
  let joined = "";
  while (offset !== null) {
    const v = readFileView(f, String(offset));
    if (v.kind !== "text") assert.fail(v.kind);
    assert.ok(!v.text.includes("�"), "no broken character");
    joined += v.text;
    offset = v.nextOffset;
  }
  assert.equal(joined, whole);
});

test("kinds: media by extension, binary by a NUL, directories list folders first", (t) => {
  const dir = tmpdir(t);
  fs.writeFileSync(path.join(dir, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
  fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([1, 2, 0, 3]));
  fs.mkdirSync(path.join(dir, "zdir"));
  fs.symlinkSync(path.join(dir, "missing"), path.join(dir, "dangling"));

  const png = readFileView(path.join(dir, "a.png"));
  assert.deepEqual([png.kind, png.kind === "media" && png.media, png.kind === "media" && png.mime], ["media", "image", "image/png"]);
  assert.equal(readFileView(path.join(dir, "blob.bin")).kind, "binary");

  const d = readFileView(dir);
  if (d.kind !== "directory") assert.fail(d.kind);
  assert.deepEqual(
    d.entries.map((e) => [e.name, e.kind, e.size]),
    [["zdir", "directory", null], ["a.png", "file", 5], ["blob.bin", "file", 4], ["dangling", "other", null]],
  );
});

test("fetch site: only this origin's pages and typed URLs", () => {
  const req = (site?: string) => ({ headers: site === undefined ? {} : { "sec-fetch-site": site } }) as http.IncomingMessage;
  assert.equal(fileFetchAllowed(req()), true);
  assert.equal(fileFetchAllowed(req("same-origin")), true);
  assert.equal(fileFetchAllowed(req("none")), true);
  assert.equal(fileFetchAllowed(req("same-site")), false);
  assert.equal(fileFetchAllowed(req("cross-site")), false);
});

test("raw bytes: whole file, a byte range, and an unsatisfiable range", async (t) => {
  const dir = tmpdir(t);
  const f = path.join(dir, "clip.mp4");
  fs.writeFileSync(f, Buffer.from("0123456789"));
  const server = http.createServer((req, res) => sendRawFile(req, res, f));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

  const whole = await fetch(url);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "video/mp4");
  assert.equal(whole.headers.get("x-content-type-options"), "nosniff");
  assert.equal(whole.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(await whole.text(), "0123456789");

  const part = await fetch(url, { headers: { range: "bytes=2-4" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 2-4/10");
  assert.equal(await part.text(), "234");

  const suffix = await fetch(url, { headers: { range: "bytes=-3" } });
  assert.equal(await suffix.text(), "789");

  const bad = await fetch(url, { headers: { range: "bytes=20-" } });
  assert.equal(bad.status, 416);
  await bad.text();
});

test("a missing relative link is looked up under the session folder: one match reads, several list", async (t) => {
  const { readFileViewWithLookup } = await import("./fileView.ts");
  const root = tmpdir(t);
  fs.mkdirSync(path.join(root, "pentest", "a", "report"), { recursive: true });
  fs.writeFileSync(path.join(root, "pentest", "a", "report", "F-1.md"), "# one\n");
  fs.mkdirSync(path.join(root, "node_modules", "x", "report"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "x", "report", "F-1.md"), "skipped\n");

  const one = await readFileViewWithLookup(path.join(root, "report", "F-1.md"), null, "report/F-1.md", root);
  assert.equal(one.kind, "text");
  assert.equal(one.path, path.join(root, "pentest", "a", "report", "F-1.md"));

  fs.mkdirSync(path.join(root, "pentest", "b", "report"), { recursive: true });
  fs.writeFileSync(path.join(root, "pentest", "b", "report", "F-1.md"), "# two\n");
  const two = await readFileViewWithLookup(path.join(root, "report", "F-1.md"), null, "report/F-1.md", root);
  if (two.kind !== "ambiguous") assert.fail(two.kind);
  assert.deepEqual(two.candidates, [
    path.join(root, "pentest", "a", "report", "F-1.md"),
    path.join(root, "pentest", "b", "report", "F-1.md"),
  ]);

  // The detail writes a folder under the home folder with `~`, wherever the temp folder is.
  const home = os.homedir();
  const shownRoot = root.startsWith(`${home}/`) ? `~${root.slice(home.length)}` : root;
  await assert.rejects(
    readFileViewWithLookup(path.join(root, "nope.md"), null, "nope.md", root),
    (e: unknown) =>
      e instanceof FileError &&
      e.status === 404 &&
      e.message === "File not found" &&
      e.detail === `Searched in ${shownRoot} (1 folder excluded: .git, node_modules)`,
  );
  // An absolute link is not looked up.
  await assert.rejects(
    readFileViewWithLookup(path.join(root, "nope.md"), null, path.join(root, "nope.md"), root),
    (e: unknown) => e instanceof FileError && e.status === 404 && e.detail === null,
  );
});
