import { test } from "node:test";
import assert from "node:assert/strict";
import type { UploadedAttachment } from "@maru/shared";
import { attachmentsToSend, UPLOADING } from "../../../web/src/lib/composerAttachments.logic.ts";
import {
  chipDetail,
  fromUploaded,
  isUploadedAttachment,
  nameFromUri,
  prepended,
  restored,
  waitingFrom,
  withFailure,
  withProgress,
  withRetry,
  withUploaded,
  type WaitingAttachment,
} from "./composerAttachments.logic.ts";
import { composerState } from "./composerState.ts";
import { attachmentsToPutBack } from "./recallQueue.ts";

const up = (id: string, name = "a.png", kind: "image" | "file" = "image"): UploadedAttachment => ({
  id: `20261117-${id}`, kind, name, mimeType: kind === "image" ? "image/png" : "text/plain", sizeBytes: 2048, path: `/x/${id}/${name}`,
});
let n = 0;
const nextId = () => `local-${++n}`;
const NOW = new Date(2026, 10, 17, 9, 5, 7);

test("picked files become uploading items named as the web names a batch", () => {
  const items = waitingFrom(
    [
      { uri: "file:///cache/ImagePicker/abc.jpeg", name: "image.jpg", mimeType: "image/jpeg", sizeBytes: 1000 },
      { uri: "file:///cache/ImagePicker/def.jpeg", name: "image.jpg", mimeType: "image/jpeg", sizeBytes: 1000 },
      { uri: "file:///cache/DocumentPicker/%EB%A9%94%EB%AA%A8.txt", name: null, mimeType: null, sizeBytes: null },
    ],
    NOW,
    nextId,
  );
  assert.deepEqual(items.map((i) => i.name), ["pasted-20261117-090507.jpg", "pasted-20261117-090507-2.jpg", "메모.txt"]);
  assert.deepEqual(items.map((i) => [i.image, i.status, i.mimeType]), [[true, "uploading", "image/jpeg"], [true, "uploading", "image/jpeg"], [false, "uploading", "application/octet-stream"]]);
  assert.equal(items[2]!.sizeBytes, null);
  assert.equal(nameFromUri("file:///a/b%20c.txt?x=1"), "b c.txt");
});

test("an upload moves an item uploading, ready, failed and back, and a send waits for it", () => {
  let list: readonly WaitingAttachment[] = waitingFrom([{ uri: "file:///a.txt", name: "a.txt", mimeType: "text/plain", sizeBytes: 4000 }], NOW, nextId);
  const id = list[0]!.localId;
  assert.equal(attachmentsToSend(list).blocked, UPLOADING);
  list = withProgress(list, id, 1000);
  assert.equal(chipDetail(list[0]!), "Uploading 25%");
  list = withFailure(list, id, "Could not upload to the server (disconnected)");
  assert.equal(attachmentsToSend(list).blocked, "Some attachments failed to upload. Remove them and send");
  assert.equal(chipDetail(list[0]!), "Could not upload to the server (disconnected)");
  // Progress that arrives after a failure changes nothing.
  assert.equal(withProgress(list, id, 3000)[0]!.sentBytes, 1000);
  list = withRetry(list, id);
  assert.deepEqual([list[0]!.status, list[0]!.error, list[0]!.sentBytes], ["uploading", undefined, 0]);
  const u = up("1111", "a.txt", "file");
  list = withUploaded(list, id, u);
  assert.deepEqual(attachmentsToSend(list), { ids: [u.id], blocked: null, uploading: false });
  assert.equal(chipDetail(list[0]!), "2.0 KB");
  // Only a failed item retries, and only from a picked file.
  assert.equal(withRetry(list, id)[0]!.status, "ready");
  assert.equal(withRetry([fromUploaded(u)], u.id)[0]!.status, "ready");
  assert.equal(withRetry([{ ...fromUploaded(u), status: "failed" }], u.id)[0]!.status, "failed", "nothing on the phone to send again");
});

test("the composer sends attachments alone, and holds the send while they upload", () => {
  const session = { key: "claude:a:1", provider: "claude", account: "a", id: "1", cwd: "/x", name: null, title: null, preview: null, status: "open-idle", owner: "ui", pid: null, tmuxPane: null, parentKey: null, updatedAt: 0, createdAt: null, sizeBytes: null, entrypoint: null } as const;
  const ready = [fromUploaded(up("2222"))];
  const only = composerState({ session, online: true, text: "  ", attachments: ready });
  assert.deepEqual([only.send, only.attachmentIds, only.blocked], ["", [ready[0]!.uploaded!.id], null]);
  assert.equal(composerState({ session, online: true, text: "" }).send, null, "nothing typed, nothing attached");
  const busy = [...ready, ...waitingFrom([{ uri: "file:///b.txt", name: "b.txt" }], NOW, nextId)];
  const held = composerState({ session, online: true, text: "hi", attachments: busy });
  assert.deepEqual([held.send, held.blocked], [null, UPLOADING]);
  assert.equal(composerState({ session, online: false, text: "hi", attachments: ready }).send, null);
});

test("a refused send's uploads come back to an empty list only, a recall's go in front", () => {
  const a = up("3333");
  const b = up("4444", "b.txt", "file");
  assert.deepEqual(restored([], [a, b]).map((x) => x.localId), [a.id, b.id]);
  const waiting = [fromUploaded(b)];
  assert.equal(restored(waiting, [a]), waiting);
  assert.deepEqual(prepended(waiting, [a, b]).map((x) => x.localId), [a.id, b.id], "one already waiting is not added twice");
  const asked = { key: "k", id: "m1", discard: false };
  assert.deepEqual(attachmentsToPutBack(asked, [{ attachments: [a] }, { attachments: [b] }]), [a, b]);
  assert.deepEqual(attachmentsToPutBack({ ...asked, discard: true }, [{ attachments: [a] }]), []);
});

test("the upload answer is checked before it is trusted", () => {
  assert.equal(isUploadedAttachment(up("5555")), true);
  assert.equal(isUploadedAttachment({ id: "x" }), false);
  assert.equal(isUploadedAttachment(null), false);
});
