// Whether a Claude session's last turn ended on an error (DESIGN.md 6j): the newest message of its
// transcript is the CLI's synthetic API error (`isApiErrorMessage`, the same records the
// conversation draws as an error item, claude/projection/extract.ts) or a refusal without a
// fallback model. Lines the CLI writes around a turn (turn_duration, notices, queue operations,
// titles, snapshots) and local commands (`/rate-limit-options`) do not end it; anything the user
// or the model said after the error does.
import { isParseError, readTail } from "../transcript/claudeTranscript.ts";

export interface LastError {
  message: string;
  /** Claude's error kind (`rate_limit`, `server_error`, `invalid_request`, ...), `refusal`. */
  code: string | null;
  /** The record's timestamp, ms. */
  at: number | null;
}

/** Records read from the end. An error is followed by a handful of bookkeeping lines (measured: up to 9). */
export const TAIL_RECORDS = 64;

const LOCAL_COMMAND = /^\s*<(command-name|command-message|local-command-stdout|local-command-stderr|local-command-caveat)>/;

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (rec(b)?.type === "text" && typeof rec(b)?.text === "string" ? (rec(b)!.text as string) : ""))
    .filter(Boolean)
    .join("\n");
}

function timeOf(d: Record<string, unknown>): number | null {
  const t = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * The error that ends these records (oldest first), or null when the newest message is not one.
 * Records the walk passes over: anything that is not a user or assistant message, except the
 * refusal notice; user messages the CLI wrote (`isMeta`) and local commands.
 */
export function lastTurnError(records: readonly unknown[]): LastError | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const d = rec(records[i]);
    if (!d || isParseError(d) || d.isSidechain === true) continue;
    if (d.type === "system") {
      if (d.subtype !== "model_refusal_no_fallback") continue;
      const message = (typeof d.apiRefusalExplanation === "string" && d.apiRefusalExplanation) || textOf(d.content) || "Response was refused";
      return { message, code: "refusal", at: timeOf(d) };
    }
    if (d.type === "user") {
      if (d.isMeta === true) continue;
      const content = rec(d.message)?.content;
      if (typeof content === "string" && LOCAL_COMMAND.test(content)) continue;
      return null;
    }
    if (d.type === "assistant") {
      if (d.isApiErrorMessage !== true) return null;
      const message = textOf(rec(d.message)?.content) || "API error";
      return { message, code: typeof d.error === "string" ? d.error : null, at: timeOf(d) };
    }
  }
  return null;
}

/** The error that ends the transcript's last TAIL_RECORDS records, or null. */
export async function readLastError(file: string): Promise<LastError | null> {
  const page = await readTail(file, { maxRecords: TAIL_RECORDS });
  return lastTurnError(page.records.map((r) => r.value));
}
