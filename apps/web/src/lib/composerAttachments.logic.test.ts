import assert from "node:assert/strict";
import { test } from "node:test";
import { attachmentNoteLine, splitAttachmentNotes, textWithAttachmentNotes } from "@maru/shared";
import {
  attachmentPreviewUrl, distinctNames, formatBytes, looksLikeImage, pasteAttaches, pastedFileName, sentMessageAttachments,
  terminalAttachmentLabel, uploadFailureReason,
} from "./composerAttachments.logic.ts";

test("an upload failure says why: maru's own error, else what the proxy's status means", () => {
  assert.equal(uploadFailureReason(400, '{"error":"name이 필요합니다"}'), "name이 필요합니다");
  assert.match(uploadFailureReason(413, "<html><h1>413 Request Entity Too Large</h1></html>"), /proxy between this device and the server refused it.*127\.0\.0\.1/);
  assert.match(uploadFailureReason(524, "<html>timeout</html>"), /did not get an answer in time/);
  assert.match(uploadFailureReason(408, ""), /took too long/);
  assert.match(uploadFailureReason(0, ""), /disconnected/);
  assert.equal(uploadFailureReason(502, "<html><body>Bad <b>Gateway</b></body></html>"), "HTTP 502: Bad Gateway");
});

test("names pasted in one batch stay apart", () => {
  assert.deepEqual(distinctNames(["pasted-1.png", "pasted-1.png", "a.txt", "pasted-1.png", "x"]), ["pasted-1.png", "pasted-1-2.png", "a.txt", "pasted-1-3.png", "x"]);
});

test("notes go after a blank line and come back off the text", () => {
  const notes = [
    { kind: "image" as const, name: "shot.png", path: "/s/a/shot.png" },
    { kind: "file" as const, name: "보고서.pdf", path: "/s/b/보고서.pdf" },
  ];
  const text = textWithAttachmentNotes("이거 봐줘\n\n두 줄", notes);
  assert.equal(text, '이거 봐줘\n\n두 줄\n\n[Attached image "shot.png" is saved at: /s/a/shot.png]\n[Attached file "보고서.pdf" is saved at: /s/b/보고서.pdf]');
  assert.deepEqual(splitAttachmentNotes(text), { text: "이거 봐줘\n\n두 줄", notes });
  // Only notes: the whole text is notes, nothing left.
  assert.deepEqual(splitAttachmentNotes(textWithAttachmentNotes("", notes)), { text: "", notes });
  assert.equal(textWithAttachmentNotes("hi", []), "hi");
});

test("a note line the user typed in the middle, or without the blank line, stays text", () => {
  const line = attachmentNoteLine({ kind: "file", name: "a", path: "/x" });
  assert.deepEqual(splitAttachmentNotes(`${line}\nmore`).notes, []);
  assert.deepEqual(splitAttachmentNotes(`words\n${line}`).notes, []);
  // A quote in a name cannot end the quoted part.
  assert.equal(attachmentNoteLine({ kind: "file", name: 'a"b\nc', path: "/x" }), '[Attached file "a_b_c" is saved at: /x]');
  // CR line endings (a CLI paste) still split.
  assert.equal(splitAttachmentNotes(`hi\r\n\r\n${line}\r`).notes.length, 1);
});

test("a paste attaches pictures always, other files only without text", () => {
  const png = { name: "image.png", type: "image/png" };
  const pdf = { name: "a.pdf", type: "application/pdf" };
  assert.equal(pasteAttaches([png], "cell text"), true);
  assert.equal(pasteAttaches([pdf], "cell text"), false);
  assert.equal(pasteAttaches([pdf], ""), true);
  assert.equal(pasteAttaches([], "x"), false);
  // T3's split: a picture the model takes, or a HEIC, attaches; a TIFF with text is the text's.
  assert.equal(pasteAttaches([{ name: "cells.tiff", type: "image/tiff" }], "a\tb"), false);
  assert.equal(pasteAttaches([{ name: "cells.tiff", type: "image/tiff" }], ""), true);
  assert.equal(pasteAttaches([{ name: "IMG_1.HEIC", type: "" }], "caption"), true);
  // Finder drags HEIC with no type; SVG is markup, not a picture the model reads.
  assert.equal(looksLikeImage({ name: "IMG_1.HEIC", type: "" }), true);
  assert.equal(looksLikeImage({ name: "logo.svg", type: "image/svg+xml" }), false);
});

test("a clipboard picture gets the paste time in its name; a real name stays", () => {
  const at = new Date(2026, 10, 16, 9, 5, 7);
  assert.equal(pastedFileName("image.png", "image/png", at), "pasted-20261116-090507.png");
  assert.equal(pastedFileName("", "image/jpeg", at), "pasted-20261116-090507.jpg");
  assert.equal(pastedFileName("diagram.png", "image/png", at), "diagram.png");
});

test("sizes and the terminal labels", () => {
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(terminalAttachmentLabel("image", 2, "x.png"), "[Image #2]");
  assert.equal(terminalAttachmentLabel("file", 1, "a.pdf"), "[File a.pdf]");
});

test("a picture's URL: a Claude transcript blob, a Codex local path or web URL, else none", () => {
  const blobs = {
    a: { raw: { source: "claude-transcript", key: "k", path: "/t/s.jsonl", byteOffset: 120 }, jsonPath: "$.message.content[0].source.data", mediaType: "image/png" },
    pdf: { raw: { path: "/t/s.jsonl", byteOffset: 1 }, jsonPath: "$.message.content[1].source.data", mediaType: "application/pdf" },
  };
  assert.equal(
    attachmentPreviewUrl("a", { attachmentBlobs: blobs }),
    "/api/file/blob?path=%2Ft%2Fs.jsonl&offset=120&pointer=%24.message.content%5B0%5D.source.data",
  );
  assert.equal(attachmentPreviewUrl("pdf", { attachmentBlobs: blobs }), null);
  assert.equal(attachmentPreviewUrl("c", { attachmentSources: { c: { path: "/s/x/image.jpg" } } }), "/api/file/raw?path=%2Fs%2Fx%2Fimage.jpg");
  assert.equal(attachmentPreviewUrl("d", { attachmentSources: { d: { url: "https://e.com/a.png" } } }), "https://e.com/a.png");
  assert.equal(attachmentPreviewUrl("e", { attachmentSources: { e: { dataUrlChars: 100 } } }), null);
  assert.equal(attachmentPreviewUrl("f", undefined), null);
});

test("a sent message: the notes name the recorded pictures in order and add the files", () => {
  const notes = [
    { kind: "image" as const, name: "one.png", path: "/s/1/one.png" },
    { kind: "file" as const, name: "spec.pdf", path: "/s/2/spec.pdf" },
    { kind: "image" as const, name: "two.heic", path: "/s/3/two.heic" },
  ];
  const text = textWithAttachmentNotes("look", notes);
  const recorded = [
    { id: "m:att:0", type: "image", name: "image-1", mimeType: "image/png" },
    { id: "m:att:1", type: "image", name: "image-2", mimeType: "image/jpeg" },
  ];
  const data = {
    attachmentBlobs: {
      "m:att:0": { raw: { path: "/t.jsonl", byteOffset: 5 }, jsonPath: "$.message.content[0].source.data", mediaType: "image/png" },
      "m:att:1": { raw: { path: "/t.jsonl", byteOffset: 5 }, jsonPath: "$.message.content[1].source.data", mediaType: "image/jpeg" },
    },
  };
  const out = sentMessageAttachments(text, recorded, data);
  assert.equal(out.text, "look");
  assert.deepEqual(out.attachments.map((a) => [a.kind, a.name, a.path, a.url !== null]), [
    ["image", "one.png", "/s/1/one.png", true],
    ["image", "two.heic", "/s/3/two.heic", true],
    ["file", "spec.pdf", "/s/2/spec.pdf", false],
  ]);
  // A CLI paste: recorded pictures, no notes.
  const cli = sentMessageAttachments("[Image #1] what is this", recorded.slice(0, 1), data);
  assert.deepEqual(cli.attachments.map((a) => [a.name, a.path]), [["image-1", null]]);
  assert.equal(cli.text, "[Image #1] what is this");
  // A provider that kept only the text: the image note still shows from its stored file.
  const textOnly = sentMessageAttachments(textWithAttachmentNotes("", notes.slice(0, 1)), [], undefined);
  assert.deepEqual(textOnly.attachments.map((a) => [a.kind, a.url]), [["image", "/api/file/raw?path=%2Fs%2F1%2Fone.png"]]);
});

test("notes and recorded images that do not count the same are not paired by order", () => {
  const notes = [
    { kind: "image" as const, name: "one.png", path: "/s/1/one.png" },
    { kind: "image" as const, name: "two.heic", path: "/s/2/two.heic" },
  ];
  const text = textWithAttachmentNotes("look", notes);
  // Claude kept one of two (the CLI could not process the other): the recorded one keeps its own
  // name, and both notes show from their stored files.
  const claude = sentMessageAttachments(text, [{ id: "c0", type: "image", name: "image-1", mimeType: "image/png" }], {
    attachmentBlobs: { c0: { raw: { path: "/t.jsonl", byteOffset: 1 }, jsonPath: "$.message.content[0].source.data", mediaType: "image/png" } },
  });
  assert.deepEqual(claude.attachments.map((a) => [a.name, a.path]), [["image-1", null], ["one.png", "/s/1/one.png"], ["two.heic", "/s/2/two.heic"]]);
  // Codex names each localImage by its path: the note from the same upload folder is its own.
  const codex = sentMessageAttachments(text, [{ id: "x1", type: "image", name: "image.jpg", mimeType: "image/*" }], {
    attachmentSources: { x1: { path: "/s/2/image.jpg" } },
  });
  assert.deepEqual(codex.attachments.map((a) => [a.name, a.path]), [["two.heic", "/s/2/two.heic"], ["one.png", "/s/1/one.png"]]);
});
