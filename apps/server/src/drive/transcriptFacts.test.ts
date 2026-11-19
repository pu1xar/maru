import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lastModelOf, lastTurnModeOf, transcriptOf } from "./transcriptFacts.ts";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5-5";

const prompt = (text: string, permissionMode?: string) => ({ type: "user", message: { role: "user", content: text }, ...(permissionMode ? { permissionMode } : {}) });
const answer = (model: string, extra: Record<string, unknown> = {}) => ({ type: "assistant", message: { model, content: [] }, ...extra });
const result = () => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });

function write(lines: unknown[]): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-model-"));
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return { dir, file };
}

async function modelOf(lines: unknown[]): Promise<string | null> {
  const { dir, file } = write(lines);
  try {
    return await lastModelOf(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the newest turn outside plan mode names the session's model; plan-mode turns run another model", async () => {
  // A Haiku session runs Sonnet in plan mode (measured on CLI 2.1.325, 2026-11-16).
  assert.equal(await modelOf([
    prompt("one", "bypassPermissions"), answer(HAIKU),
    prompt("two", "plan"), answer(SONNET), result(), answer(SONNET),
  ]), HAIKU);
  // A switch to plan mode inside a turn comes after the turn's first line.
  assert.equal(await modelOf([
    prompt("one", "bypassPermissions"), answer(HAIKU), result(), answer(SONNET), answer(SONNET),
  ]), HAIKU);
  // A task notification opens a turn and records its mode too.
  assert.equal(await modelOf([
    prompt("one", "plan"), answer(SONNET),
    { type: "user", isMeta: true, permissionMode: "bypassPermissions", message: { role: "user", content: "<task-notification>x</task-notification>" } }, answer(HAIKU),
  ]), HAIKU);
});

test("lines without the mode, sidechains, synthetic messages; a transcript of plan turns only; none", async () => {
  assert.equal(await modelOf([prompt("old cli"), answer(HAIKU), answer("claude-opus-5-5", { isSidechain: true }), answer("<synthetic>")]), HAIKU);
  assert.equal(await modelOf([prompt("p", "plan"), answer(SONNET)]), SONNET, "the newest line when no turn ran outside plan mode");
  assert.equal(await modelOf([prompt("p", "default")]), null);
  assert.equal(await modelOf([]), null);
});

test("the newest turn wins over older ones, also across pages", async () => {
  const lines: unknown[] = [prompt("first", "default"), answer("claude-opus-5-5")];
  for (let i = 0; i < 450; i++) lines.push(result());
  lines.push(prompt("second", "default"), answer(HAIKU));
  for (let i = 0; i < 450; i++) lines.push({ type: "queue-operation", operation: "enqueue" });
  assert.equal(await modelOf(lines), HAIKU);
  lines.push(prompt("third", "plan"));
  for (let i = 0; i < 450; i++) lines.push(answer(SONNET));
  assert.equal(await modelOf(lines), HAIKU, "found two pages back");
});

test("lastTurnModeOf: the mode the newest turn started in", async () => {
  const modeOf = async (lines: unknown[]) => {
    const { dir, file } = write(lines);
    try {
      return await lastTurnModeOf(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.equal(await modeOf([prompt("a", "bypassPermissions"), answer(HAIKU), prompt("b", "plan"), answer(SONNET), result()]), "plan");
  assert.equal(await modeOf([prompt("a", "acceptEdits"), answer(HAIKU), result(), answer(HAIKU)]), "acceptEdits");
  assert.equal(await modeOf([prompt("a", "default"), prompt("old cli without the field")]), "default", "a prompt without the field is passed over");
  assert.equal(await modeOf([prompt("a"), answer(HAIKU)]), null);
});

test("transcriptOf finds the session file in any project folder of the account", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-model-acct-"));
  try {
    fs.mkdirSync(path.join(root, "projects", "-a"), { recursive: true });
    fs.mkdirSync(path.join(root, "projects", "-b"), { recursive: true });
    fs.writeFileSync(path.join(root, "projects", "-b", "sid.jsonl"), "");
    assert.equal(transcriptOf(root, "sid"), path.join(root, "projects", "-b", "sid.jsonl"));
    assert.equal(transcriptOf(root, "other"), null);
    assert.equal(transcriptOf(path.join(root, "missing"), "sid"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
