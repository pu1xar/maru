import assert from "node:assert/strict";
import { test } from "node:test";
import type { UploadedAttachment } from "@maru/shared";

// A browser-shaped global with localStorage, set before the module loads.
const stored = new Map<string, string>();
Object.assign(globalThis, {
  window: {
    localStorage: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k),
    },
  },
});

const att = await import("./composerAttachments.ts");
const upload = (id: string, kind: "image" | "file", name: string): UploadedAttachment => ({
  id, kind, name, mimeType: kind === "image" ? "image/png" : "application/pdf", sizeBytes: 3, path: `/s/${id}/${name}`,
});

test("a refused send's attachments come back while the list is empty, and are kept across a reload", () => {
  const key = "claude:a:s1";
  const shot = upload("20261116-00000000-0000-4000-8000-000000000001", "image", "shot.png");
  att.restoreComposerAttachments(key, [shot, upload("20261116-00000000-0000-4000-8000-000000000002", "file", "a.pdf")]);
  const list = att.getComposerAttachments(key);
  assert.deepEqual(list.map((a) => [a.name, a.status, a.previewUrl]), [
    ["shot.png", "ready", "/api/attachments/20261116-00000000-0000-4000-8000-000000000001/image"],
    ["a.pdf", "ready", null],
  ]);
  assert.deepEqual(att.attachmentsToSend(list), { ids: [shot.id, "20261116-00000000-0000-4000-8000-000000000002"], blocked: null, uploading: false });
  assert.equal(JSON.parse(stored.get(`maru_composer_attachments:${key}`) ?? "[]").length, 2);
});

test("what was added since the send stays: a restore into a list that is not empty does nothing", () => {
  const key = "claude:a:s2";
  att.restoreComposerAttachments(key, [upload("20261116-00000000-0000-4000-8000-000000000003", "file", "new.txt")]);
  att.restoreComposerAttachments(key, [upload("20261116-00000000-0000-4000-8000-000000000004", "file", "old.txt")]);
  assert.deepEqual(att.getComposerAttachments(key).map((a) => a.name), ["new.txt"]);
  att.clearComposerAttachments(key);
  assert.deepEqual(att.getComposerAttachments(key), []);
  assert.equal(stored.has(`maru_composer_attachments:${key}`), false);
});
