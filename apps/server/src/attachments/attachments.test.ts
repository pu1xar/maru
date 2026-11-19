import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { CLAUDE_CLI_COMMANDS, commandRunning, runsCliCommand } from "@maru/shared";
import { claudeContent, codexInput, commandWithAttachments } from "./message.ts";
import { AttachmentError, AttachmentStore, isAttachmentId, newAttachmentId, publicView, safeFileName, sniffMime, type StoredAttachment } from "./store.ts";
import { API_MAX_BASE64_BYTES, base64Length, parseSipsInfo, planImage, prepareImage } from "./images.ts";
import { parseJsonPath, readLineAt, readTranscriptBlob, valueAt } from "./transcriptBlob.ts";
import { FileError } from "../files/fileView.ts";

function tmp(t: { after(fn: () => void): void }, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A solid-color RGB PNG of the given size, written by hand (no image library here). */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const stored = (over: Partial<StoredAttachment>): StoredAttachment => ({
  id: "20261116-00000000-0000-4000-8000-000000000000", kind: "file", name: "a.txt", mimeType: "text/plain", sizeBytes: 3,
  path: "/s/a.txt", createdAt: 0, ...over,
});

// ---- message ----

test("Claude: text alone without attachments; else pictures first, then one text block with every note", () => {
  assert.equal(claudeContent("hi", [], () => Buffer.alloc(0)), "hi");
  const img = stored({ kind: "image", name: "shot.png", mimeType: "image/heic", path: "/s/1/shot.heic", imagePath: "/s/1/image.jpg", imageMime: "image/jpeg" });
  const pdf = stored({ name: "spec.pdf", mimeType: "application/pdf", path: "/s/2/spec.pdf" });
  const read: string[] = [];
  const content = claudeContent("look", [pdf, img], (a) => {
    read.push(a.imagePath!);
    return Buffer.from("JPEG");
  });
  assert.deepEqual(read, ["/s/1/image.jpg"]);
  assert.deepEqual(content, [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from("JPEG").toString("base64") } },
    { type: "text", text: 'look\n\n[Attached file "spec.pdf" is saved at: /s/2/spec.pdf]\n[Attached image "shot.png" is saved at: /s/1/shot.heic]' },
  ]);
  // No words: the notes are the text block.
  assert.deepEqual(claudeContent("", [pdf], () => Buffer.alloc(0)), [{ type: "text", text: '[Attached file "spec.pdf" is saved at: /s/2/spec.pdf]' }]);
});

test("Codex: the text with the notes, then each picture as a localImage of the model's copy", () => {
  const img = stored({ kind: "image", name: "a.png", mimeType: "image/png", path: "/s/1/a.png", imagePath: "/s/1/a.png", imageMime: "image/png" });
  const refused = stored({ name: "huge.tiff", mimeType: "image/tiff", path: "/s/3/huge.tiff", notice: "x" });
  assert.deepEqual(codexInput("hi", [img, refused]), [
    { type: "text", text: 'hi\n\n[Attached image "a.png" is saved at: /s/1/a.png]\n[Attached file "huge.tiff" is saved at: /s/3/huge.tiff]', text_elements: [] },
    { type: "localImage", path: "/s/1/a.png" },
  ]);
  assert.deepEqual(codexInput("hi", []), [{ type: "text", text: "hi", text_elements: [] }]);
});

test("commandRunning follows the SDK's SlashCommand.builtin rule; runsCliCommand adds the bundle's command type", () => {
  const row = (name: string, source: "builtin" | "custom", aliases: string[] = []) => ({ name, source, aliases });
  const list = [
    row("usage", "builtin", ["cost", "stats"]), row("cost", "custom"), row("context", "custom"), row("context", "builtin"),
    row("deploy", "custom", ["ship"]), row("dataviz", "builtin"), row("init", "builtin"), row("code-review", "builtin", ["review"]),
  ];
  assert.equal(commandRunning("context", list)?.source, "builtin", "a built-in row wins over an unmarked one of the same name");
  assert.equal(commandRunning("cost", list)?.source, "custom", "a row named cost runs before another row's alias");
  assert.equal(commandRunning("stats", list)?.name, "usage", "an alias no row has as its name runs the row that lists it");
  assert.equal(commandRunning("nothing", list), null);
  // CLI commands: usage (also as /stats), context. Not: the user's cost and ship, the CLI's skills and prompt commands.
  assert.deepEqual(["usage", "stats", "context", "cost", "ship", "dataviz", "init", "review"].map((n) => runsCliCommand(n, list)), [true, true, true, false, false, false, false, false]);
  assert.equal(runsCliCommand("nothing", list), null, "a name the list lacks: not known to be a CLI command");
  assert.equal(runsCliCommand("compact", null), null, "a list not known");
  assert.ok(CLAUDE_CLI_COMMANDS.has("compact") && CLAUDE_CLI_COMMANDS.has("clear") && !CLAUDE_CLI_COMMANDS.has("init"));
  assert.equal(commandWithAttachments("compact"), "/compact is a command, so it was not sent with the attachment. Send the command and the attachment separately");
});

// ---- store ----

test("ids sort by day and are checked; names lose separators, quotes and control characters", () => {
  const id = newAttachmentId(new Date(2026, 10, 16, 23, 59));
  assert.match(id, /^20261116-[0-9a-f-]{36}$/);
  assert.equal(isAttachmentId(id), true);
  assert.equal(isAttachmentId("../etc"), false);
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName('a"b\nc.txt'), "a_b_c.txt");
  assert.equal(safeFileName(""), "file");
  assert.equal(safeFileName("meta.json"), "_meta.json");
  assert.equal(safeFileName("image.jpg"), "_image.jpg");
  // 204 units fit APFS's 255 (600 bytes of UTF-8 is fine: the limit counts units, not bytes).
  assert.equal(safeFileName(`${"가".repeat(200)}.pdf`), `${"가".repeat(200)}.pdf`);
  const cut = safeFileName(`${"가".repeat(400)}.pdf`);
  assert.ok(cut.length === 255 && cut.endsWith(".pdf"));
});

test("the type comes from the bytes before the browser's word", () => {
  assert.equal(sniffMime(png(1, 1).subarray(0, 16), "application/octet-stream", "x"), "image/png");
  assert.equal(sniffMime(Buffer.from("%PDF-1.7"), "", "a.bin"), "application/pdf");
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic")]);
  assert.equal(sniffMime(heic, "", "IMG.HEIC"), "image/heic");
  assert.equal(sniffMime(Buffer.from("hello"), "text/x-python; charset=utf-8", "a.py"), "text/x-python");
  assert.equal(sniffMime(Buffer.from("hello"), "", "notes.md"), "text/markdown");
});

test("save streams to a folder per upload; a picture gets the model's copy; get reads it back", async (t) => {
  const root = tmp(t, "att-store-");
  const prepared: string[] = [];
  const store = new AttachmentStore({
    root,
    now: () => new Date(2026, 10, 16),
    prepare: async (file, mime) => {
      prepared.push(mime);
      return { ok: true, path: file, mime, width: 3, height: 2 };
    },
  });
  const pic = await store.save(Readable.from([png(3, 2)]), "image.png", "image/png");
  assert.equal(pic.kind, "image");
  assert.equal(pic.name, "_image.png");
  assert.deepEqual([pic.width, pic.height, pic.mimeType], [3, 2, "image/png"]);
  assert.equal(path.dirname(pic.path), path.join(root, pic.id));
  assert.deepEqual(prepared, ["image/png"]);
  assert.equal(fs.statSync(path.dirname(pic.path)).mode & 0o777, 0o700);

  const text = await store.save(Readable.from([Buffer.from("x".repeat(100_000))]), "log.txt", "text/plain");
  assert.equal(text.kind, "file");
  assert.equal(text.sizeBytes, 100_000);
  assert.equal(fs.readFileSync(text.path, "utf8").length, 100_000);
  assert.deepEqual(prepared, ["image/png"], "a text file is not prepared");

  const got = store.get(pic.id);
  assert.equal(got.imagePath, pic.path);
  assert.equal("imagePath" in publicView(got), false);
  assert.throws(() => store.get("nope"), (e: unknown) => e instanceof AttachmentError && e.status === 400);
  assert.throws(() => store.get(newAttachmentId(new Date())), (e: unknown) => e instanceof AttachmentError && e.status === 404);
});

test("a picture the model cannot take goes as a file with the reason", async (t) => {
  const root = tmp(t, "att-store-");
  const store = new AttachmentStore({ root, prepare: async () => ({ ok: false, reason: "줄여도 한 장 상한(base64 10MB)을 넘어 파일 경로로만 보냅니다" }) });
  const a = await store.save(Readable.from([png(2, 2)]), "big.png", "image/png");
  assert.equal(a.kind, "file");
  assert.match(a.notice ?? "", /10MB/);
});

test("names: the file system's 255 units are kept whole, cut beyond, and reserved names ignore case", async (t) => {
  const root = tmp(t, "att-store-");
  const store = new AttachmentStore({ root, prepare: async () => ({ ok: false, reason: "x" }) });
  // 255 ASCII letters failed before: the temporary file added ".part" past the limit (ENAMETOOLONG).
  const full = `${"a".repeat(251)}.txt`;
  const a = await store.save(Readable.from([Buffer.from("x")]), full, "text/plain");
  assert.equal(a.name, full);
  assert.equal(fs.readFileSync(a.path, "utf8"), "x");
  const long = await store.save(Readable.from([Buffer.from("y")]), `${"b".repeat(300)}.txt`, "text/plain");
  assert.equal(long.name.length, 255);
  assert.ok(long.name.endsWith(".txt"));
  // Hangul counts one unit a syllable (765 bytes is fine); an emoji counts two and is never split.
  assert.equal(safeFileName(`${"가".repeat(251)}.txt`).length, 255);
  const emoji = safeFileName(`${"😀".repeat(200)}.txt`);
  assert.ok(emoji.length <= 255 && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji), "no lone half of a pair");
  // APFS ignores case: "Meta.json" would be the folder's meta.json.
  const meta = await store.save(Readable.from([Buffer.from("{\"not\":\"meta\"}")]), "Meta.json", "application/json");
  assert.equal(meta.name, "_Meta.json");
  assert.equal(store.get(meta.id).name, "_Meta.json", "meta.json still describes the upload");
  assert.equal(safeFileName("IMAGE.JPG"), "_IMAGE.JPG");
  assert.equal(safeFileName("Upload.PART"), "_Upload.PART");
  // Line separators would break the note line; bidi overrides make a name read as another.
  assert.equal(safeFileName(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x202e)}gpj.exe`), "a_b_gpj.exe");
});

test("a picture step that throws leaves the upload as a file with the reason, not a 500 and a folder without meta", async (t) => {
  const root = tmp(t, "att-store-");
  const store = new AttachmentStore({ root, prepare: async () => { throw new Error("sips crashed"); } });
  const a = await store.save(Readable.from([png(2, 2)]), "x.png", "image/png");
  assert.equal(a.kind, "file");
  assert.match(a.notice ?? "", /sips crashed/);
  assert.equal(store.get(a.id).id, a.id);
});

test("an upload that breaks off leaves no folder behind", async (t) => {
  const root = tmp(t, "att-store-");
  const store = new AttachmentStore({ root });
  const broken = new Readable({ read() { this.destroy(new Error("client went away")); } });
  await assert.rejects(store.save(broken, "a.bin", ""), /client went away/);
  assert.deepEqual(fs.readdirSync(root), []);
});

// ---- images ----

test("the plan: the four API types within the API limits go as they are; anything else is converted", () => {
  assert.deepEqual(planImage({ mime: "image/png", width: 3024, height: 1964, bytes: 4_000_000 }), { action: "as-is" });
  assert.deepEqual(planImage({ mime: "image/heic", width: 4032, height: 3024, bytes: 2_000_000 }), {
    action: "convert", format: "jpeg", fitSide: 2000, why: "image/heic is not a format the model accepts",
  });
  assert.deepEqual(planImage({ mime: "image/png", width: 9000, height: 100, bytes: 1000 }), {
    action: "convert", format: "png", fitSide: 2000, why: "a side is longer than 8000px",
  });
  const tooMany = Math.ceil((API_MAX_BASE64_BYTES / 4) * 3) + 3;
  assert.ok(base64Length(tooMany) > API_MAX_BASE64_BYTES);
  assert.deepEqual(planImage({ mime: "image/jpeg", width: 1500, height: 1500, bytes: tooMany }), {
    action: "convert", format: "jpeg", fitSide: null, why: "over base64 10MB",
  });
  assert.deepEqual(planImage({ mime: "image/tiff", width: 800, height: 600, bytes: 10 }).action, "convert");
});

test("sips -g output is read; anything else is not a picture", () => {
  assert.deepEqual(parseSipsInfo("/x.heic\n  pixelWidth: 4032\n  pixelHeight: 3024\n  format: heic\n"), { width: 4032, height: 3024, format: "heic" });
  assert.equal(parseSipsInfo("/etc/hosts\n"), null);
});

test("prepareImage with the real sips: as-is, TIFF to PNG, an oversized side fitted, a non-picture refused", { skip: process.platform !== "darwin" }, async (t) => {
  const dir = tmp(t, "att-img-");
  const small = path.join(dir, "small.png");
  fs.writeFileSync(small, png(40, 20));
  assert.deepEqual(await prepareImage(small, "image/png", dir), { ok: true, path: small, mime: "image/png", width: 40, height: 20 });

  const tiff = path.join(dir, "scan.tiff");
  execFileSync("/usr/bin/sips", ["-s", "format", "tiff", small, "--out", tiff], { stdio: "ignore" });
  const fromTiff = await prepareImage(tiff, "image/tiff", dir);
  assert.ok(fromTiff.ok);
  assert.deepEqual([fromTiff.mime, fromTiff.width, fromTiff.height, path.basename(fromTiff.path)], ["image/png", 40, 20, "image.png"], "a small picture is not enlarged");

  const wideDir = path.join(dir, "wide");
  fs.mkdirSync(wideDir);
  const wide = path.join(wideDir, "wide.png");
  fs.writeFileSync(wide, png(8100, 10));
  const fitted = await prepareImage(wide, "image/png", wideDir);
  assert.ok(fitted.ok);
  assert.deepEqual([fitted.width, fitted.mime], [2000, "image/png"]);

  const notPic = path.join(dir, "x.png");
  fs.writeFileSync(notPic, "not a picture");
  const refused = await prepareImage(notPic, "image/png", dir);
  assert.equal(refused.ok, false);

  // The bytes decide, not the name or the browser: a ".png" that holds a TIFF is converted.
  const liarDir = path.join(dir, "liar");
  fs.mkdirSync(liarDir);
  const liar = path.join(liarDir, "scan.png");
  fs.copyFileSync(tiff, liar);
  const fromLiar = await prepareImage(liar, "image/png", liarDir);
  assert.ok(fromLiar.ok);
  assert.deepEqual([fromLiar.mime, path.basename(fromLiar.path)], ["image/png", "image.png"]);
});

// ---- transcript blob ----

test("JSON paths of the projector, and nothing else", () => {
  assert.deepEqual(parseJsonPath("$.message.content[0].source.data"), ["message", "content", 0, "source", "data"]);
  assert.equal(parseJsonPath("message.content"), null);
  assert.equal(parseJsonPath("$.a['b']"), null);
  assert.equal(valueAt({ a: [{ b: 1 }] }, ["a", 0, "b"]), 1);
  assert.equal(valueAt({ a: 1 }, ["a", "b"]), undefined);
});

test("the image a transcript line carries comes back decoded, from a line longer than one read", (t) => {
  const dir = tmp(t, "att-blob-");
  const file = path.join(dir, "s.jsonl");
  const pic = png(400, 400);
  const first = `${JSON.stringify({ type: "summary", pad: "y".repeat(300_000) })}\n`;
  const line = JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: "image/png", data: pic.toString("base64") } }] },
    pad: "z".repeat(600_000),
  });
  fs.writeFileSync(file, `${first}${line}\n{"type":"x"}\n`);
  const offset = Buffer.byteLength(first);
  const roots = [dir];
  assert.equal(readLineAt(file, offset), line);
  const blob = readTranscriptBlob(file, String(offset), "$.message.content[1].source.data", roots);
  assert.equal(blob.mime, "image/png");
  assert.ok(blob.bytes.equals(pic));
  assert.equal(blobStatus(() => readTranscriptBlob(file, String(offset), "$.message.content[0].text", roots)), 400);
  assert.equal(blobStatus(() => readTranscriptBlob(file, String(offset), "$.message.content[0].source.data", roots)), 404);
  assert.equal(blobStatus(() => readTranscriptBlob(file, "1", "$.message.content[1].source.data", roots)), 404);
  assert.equal(blobStatus(() => readTranscriptBlob(file, "-1", "$.x.data", roots)), 400);
  assert.equal(blobStatus(() => readTranscriptBlob(path.join(dir, "none.jsonl"), "0", "$.x.data", roots)), 404);
});

const blobStatus = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof FileError ? err.status : -1;
  }
  return 200;
};

test("the blob route reads only regular .jsonl files under the transcript roots, before reading a byte", { skip: process.platform === "win32" }, (t) => {
  const root = tmp(t, "att-root-");
  const outside = tmp(t, "att-out-");
  const ok = path.join(root, "p", "s.jsonl");
  fs.mkdirSync(path.dirname(ok));
  fs.writeFileSync(ok, `${JSON.stringify({ message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png(1, 1).toString("base64") } }] } })}\n`);
  const roots = [root];
  assert.equal(blobStatus(() => readTranscriptBlob(ok, "0", "$.message.content[0].source.data", roots)), 200);
  // A device: reading it to a newline never ends (memory) or never returns (a FIFO). Refused by place.
  assert.equal(blobStatus(() => readTranscriptBlob("/dev/zero", "0", "$.data", roots)), 403);
  const elsewhere = path.join(outside, "s.jsonl");
  fs.copyFileSync(ok, elsewhere);
  assert.equal(blobStatus(() => readTranscriptBlob(elsewhere, "0", "$.message.content[0].source.data", roots)), 403);
  // A link inside the root that points out is judged by where it points.
  const link = path.join(root, "p", "link.jsonl");
  fs.symlinkSync(elsewhere, link);
  assert.equal(blobStatus(() => readTranscriptBlob(link, "0", "$.message.content[0].source.data", roots)), 403);
  // Not a transcript name.
  const other = path.join(root, "p", "notes.txt");
  fs.writeFileSync(other, "x");
  assert.equal(blobStatus(() => readTranscriptBlob(other, "0", "$.data", roots)), 403);
  // A FIFO named like a transcript inside the root: refused without opening it (opening would block).
  const fifo = path.join(root, "p", "pipe.jsonl");
  execFileSync("/usr/bin/mkfifo", [fifo]);
  assert.equal(blobStatus(() => readTranscriptBlob(fifo, "0", "$.data", roots)), 415);
  // No roots: nothing is readable.
  assert.equal(blobStatus(() => readTranscriptBlob(ok, "0", "$.message.content[0].source.data", [])), 403);
});
