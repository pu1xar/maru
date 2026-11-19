import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lastTurnError, readLastError } from "./lastError.ts";

const apiError = {
  type: "assistant", isApiErrorMessage: true, error: "rate_limit", timestamp: "2026-10-29T14:34:19.774Z",
  message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your 5-hour limit" }] },
};
const reply = { type: "assistant", timestamp: "2026-10-29T14:30:00.000Z", message: { content: [{ type: "text", text: "done" }] } };
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", message: { content }, ...extra });

test("an API error that the CLI's bookkeeping lines follow ends the turn on an error", () => {
  // The lines after a rate limit, as measured in a real transcript (2026-10-29).
  const records = [
    user("go"),
    apiError,
    { type: "system", subtype: "informational", content: "Usage limit reached" },
    { type: "system", subtype: "turn_duration" },
    { type: "queue-operation" },
    user("<local-command-caveat>The command below was run directly", { isMeta: true }),
    user("<command-name>/rate-limit-options</command-name>"),
    user("<local-command-stdout>Claude Code will continue automatically</local-command-stdout>"),
    { type: "file-history-snapshot" },
    { type: "last-prompt" },
    { type: "custom-title" },
    { type: "ai-title" },
  ];
  assert.deepEqual(lastTurnError(records), { message: "You've hit your 5-hour limit", code: "rate_limit", at: Date.parse("2026-10-29T14:34:19.774Z") });
});

test("anything said after the error, or a normal last reply, is not an error", () => {
  assert.equal(lastTurnError([apiError, user("continue")]), null);
  assert.equal(lastTurnError([apiError, user("Your usage limit has reset", { isMeta: true }), reply]), null);
  assert.equal(lastTurnError([user("hi"), reply, { type: "system", subtype: "turn_duration" }]), null);
  assert.equal(lastTurnError([apiError, user([{ type: "tool_result", content: "x" }])]), null);
  assert.equal(lastTurnError([]), null);
});

test("a refusal without a fallback model ends the turn on an error", () => {
  const refusal = { type: "system", subtype: "model_refusal_no_fallback", apiRefusalExplanation: "blocked", timestamp: "2026-11-01T00:00:00Z" };
  assert.deepEqual(lastTurnError([user("x"), refusal]), { message: "blocked", code: "refusal", at: Date.parse("2026-11-01T00:00:00Z") });
});

test("readLastError reads the transcript's tail; a torn last line is skipped", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "le-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "s.jsonl");
  const filler = Array.from({ length: 200 }, (_, i) => JSON.stringify(user(`m${i}`)));
  fs.writeFileSync(file, [...filler, JSON.stringify(apiError), JSON.stringify({ type: "system", subtype: "turn_duration" }), '{"type":"us'].join("\n"));
  assert.equal((await readLastError(file))?.code, "rate_limit");
  fs.appendFileSync(file, `er"}\n${JSON.stringify(user("again"))}\n`);
  assert.equal(await readLastError(file), null);
});
