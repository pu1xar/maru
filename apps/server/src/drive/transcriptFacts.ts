// What a process this server starts or takes over for a Claude session inherits from the
// session's transcript.
//
// The model a session last ran on, so a new process for the session keeps it. The CLI resumes on
// the account's default model otherwise: a session created on Haiku ran its second turn, in a new
// process, on claude-opus-5-5 (measured 2026-11-16).
//
// A session whose model setting is haiku (or opusplan) runs another model in plan mode (CLI
// 2.1.325: Sonnet 5.5 for a Haiku session, measured 2026-11-16), so the newest assistant line can
// name the plan-mode model. The session's own model is that of the first assistant line of the
// newest turn that started outside plan mode: a user line that opens a turn records the mode it
// started in (`permissionMode`), and a switch to plan mode inside a turn comes after its first line.
import fs from "node:fs";
import path from "node:path";
import { readTail } from "../transcript/claudeTranscript.ts";

/** Lines per page while reading backwards. A page size, not a cap: pages go on to the file's start. */
const PAGE_RECORDS = 200;

/** `<config dir>/projects/<enc>/<sid>.jsonl` of the session, or null when no project dir has it. */
export function transcriptOf(accountDir: string, sessionId: string): string | null {
  const projects = path.join(accountDir, "projects");
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = path.join(projects, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

interface Line {
  type?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  permissionMode?: unknown;
  message?: { model?: unknown; content?: unknown };
}

/** A user line that starts a turn: a prompt, or a line the CLI wrote with the turn's mode. */
function turnStart(line: Line): boolean {
  if (line.type !== "user" || line.isSidechain === true || line.isCompactSummary === true) return false;
  if (typeof line.permissionMode === "string") return true;
  return line.isMeta !== true && typeof line.message?.content === "string";
}

/**
 * The session's model (see above), or null when the transcript has no assistant line of the main
 * conversation. Sidechain lines and synthetic messages (model "<synthetic>") are left out. When
 * every turn ran in plan mode, the newest assistant line's model is the answer.
 */
export async function lastModelOf(file: string): Promise<string | null> {
  let before: number | undefined;
  /** The earliest assistant model seen since the last turn start passed (reading backwards). */
  let candidate: string | null = null;
  let newest: string | null = null;
  for (;;) {
    const page = await readTail(file, { maxRecords: PAGE_RECORDS, ...(before === undefined ? {} : { beforeOffset: before }) });
    for (let i = page.records.length - 1; i >= 0; i--) {
      const v = page.records[i]!.value;
      if (!v || typeof v !== "object") continue;
      const line = v as Line;
      if (line.type === "assistant" && line.isSidechain !== true) {
        const model = line.message?.model;
        if (typeof model === "string" && model !== "" && !model.startsWith("<")) {
          candidate = model;
          newest ??= model;
        }
        continue;
      }
      if (!turnStart(line)) continue;
      if (line.permissionMode !== "plan" && candidate !== null) return candidate;
      candidate = null;
    }
    if (!page.hasMoreBefore) return candidate ?? newest;
    before = page.startOffset;
  }
}

/**
 * The permission mode the newest turn started in (its opening user line's `permissionMode`), or
 * null when no turn recorded one. A process this server takes over after a restart reports its
 * mode only at its next turn (system/init) or change (system/status); until then this stands in.
 */
export async function lastTurnModeOf(file: string): Promise<string | null> {
  let before: number | undefined;
  for (;;) {
    const page = await readTail(file, { maxRecords: PAGE_RECORDS, ...(before === undefined ? {} : { beforeOffset: before }) });
    for (let i = page.records.length - 1; i >= 0; i--) {
      const v = page.records[i]!.value;
      if (!v || typeof v !== "object") continue;
      const line = v as Line;
      if (!turnStart(line)) continue;
      if (typeof line.permissionMode === "string" && line.permissionMode !== "") return line.permissionMode;
    }
    if (!page.hasMoreBefore) return null;
    before = page.startOffset;
  }
}
