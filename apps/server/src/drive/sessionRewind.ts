// Rewind (DESIGN.md 6o): the Claude Code CLI's Esc Esc screen for the sessions this server drives.
// GET /api/session-rewind?key= lists the user's messages of the current conversation with what
// can go back for each; POST /api/session-rewind {key, id, mode} goes back.
//
// Claude (CLI 2.1.325 and SDK 0.3.321, measured with throwaway sessions 2026-11-16):
// - The CLI goes back in memory and the transcript changes only with the next message, whose
//   parent is the kept line. The SDK has no control request for it (the CLI's own
//   `rewind_conversation` is not in the SDK's Query), so a rewind ends the session's process and
//   the next process resumes up to the kept line (resumeSessionAt). Until the next message the
//   marker (state/sessionRewinds.ts) says where the conversation stands.
// - Files go back with Query.rewindFiles(message uuid) on a process that keeps file checkpoints.
//   A resumed process reads the checkpoints from the transcript, so a closed session gets a new
//   process (resume, enableFileCheckpointing) for it. A message sent while checkpointing was off
//   has no checkpoint and its code cannot go back.
// - A turn, a question or a terminal that holds the session refuses a rewind (the CLI opens the
//   screen only between turns). Background tasks refuse what needs the process ended or replaced.
//
// Codex (codex-cli 0.169.0): thread/revert drops the history from one turn on, as the TUI's
// backtrack does; files stay. Only a paginated thread takes it, only a turn's first message can
// be picked (a steer belongs to its turn), and a closed thread is resumed first (CodexRuns.revert).
import type http from "node:http";
import type {
  RewindFileStats, RewindMode, RewindPart, RewindTarget, SessionRewindList, SessionRewindPreview, SessionRewindRequest, SessionRewindResult, SessionSummary,
} from "@maru/shared";
import type { RewindFilesResult } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAccount } from "../config.ts";
import type { SessionIndex } from "../index/store.ts";
import { HostDownError } from "../claude/hostLink.ts";
import { markerActive, markerActiveIn, newestNodeUuid, readRewindTranscript, rewindTargets, type RewindMarker, type RewindTargetFacts } from "../claude/rewindScan.ts";
import type { SessionRewindStore } from "../state/sessionRewinds.ts";
import type { Turn } from "../codex/protocol/v2/Turn.ts";
import type { ClaudeRuns } from "./claudeRuns.ts";
import { DriveError } from "./claudeRuns.ts";
import type { CodexRuns } from "./codexRuns.ts";
import { transcriptOf } from "./transcriptFacts.ts";

export class RewindError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface SessionRewindDeps {
  claudeAccounts: ClaudeAccount[];
  index: Pick<SessionIndex, "get">;
  runs: Pick<ClaudeRuns, "rewindState" | "open" | "close" | "call" | "refreshTurns" | "exclusive">;
  codexRuns: Pick<CodexRuns, "rewindTurns" | "revert">;
  store: SessionRewindStore;
  hostUp: () => boolean;
  /** Whether a process for the account and folder keeps checkpoints (claude/checkpointing.ts). Default: yes. */
  fileCheckpointing?: (accountDir: string, cwd: string) => boolean;
}

const MODES: readonly RewindMode[] = ["both", "conversation", "code"];
const ON: RewindPart = { enabled: true, reason: null };
const off = (reason: string): RewindPart => ({ enabled: false, reason });

/** Why a Claude session cannot go back now at all; null when it can. */
export function claudeBlocked(s: SessionSummary, state: ReturnType<ClaudeRuns["rewindState"]>, hostUp: boolean): string | null {
  if (s.parentKey) return "Cannot rewind a subagent conversation";
  if (s.owner === "terminal" && s.status !== "closed") return "Open in a terminal, so it cannot be rewound here";
  if (state?.pending) return "A question is waiting for an answer, so it cannot be rewound";
  if (state?.busy || ((s.status === "running" || s.status === "waiting-input") && s.owner === "ui")) return "A turn is running, so it cannot be rewound";
  if (!hostUp) return "Claude session host is down";
  return null;
}

/** What decides the code part besides the message itself. */
export interface CodeGate {
  /** The settings let a process keep checkpoints (fileCheckpointingEnabled). */
  checkpointingOn: boolean;
  /** A conversation rewind waits: a code restore needs a process that read the whole conversation. */
  rewindWaits: boolean;
}

/**
 * The parts of a Claude message that can go back. The conversation needs a parent line to resume
 * up to and the session's process ended; the code needs the message's checkpoint and a process
 * that keeps checkpoints and read every one (a process without them, or one that resumed only up
 * to a waiting rewind's line, is replaced). Whether anything would change is the dry run's call:
 * the transcript misses edits a subagent made.
 */
export function claudeParts(
  t: Pick<RewindTargetFacts, "parentUuid" | "checkpoint">,
  state: ReturnType<ClaudeRuns["rewindState"]>,
  gate: CodeGate = { checkpointingOn: true, rewindWaits: false },
): { conversation: RewindPart; code: RewindPart } {
  const background = (state?.backgroundTasks ?? 0) > 0;
  const conversation = t.parentUuid === null ? off("Cannot rewind the conversation to before the first message")
    : background ? off("Background tasks are running, so the conversation cannot be rewound")
    : ON;
  const replaced = state !== null && (!state.fileCheckpointing || gate.rewindWaits);
  const code = !t.checkpoint ? off("No file checkpoint for this message")
    : !gate.checkpointingOn ? off("Settings for this account or folder (fileCheckpointingEnabled false) turn off file checkpoints")
    : background && replaced ? off("Background tasks are running, so the run cannot be changed")
    : ON;
  return { conversation, code };
}

/** The text of a Codex user message's inputs, as the composer would hold it. */
function codexText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: string; text?: string; name?: string; path?: string }) =>
      c.type === "text" ? (c.text ?? "") : c.type === "skill" || c.type === "mention" ? `$${c.name ?? ""}` : c.type === "localImage" ? `[image ${c.path ?? ""}]` : c.type === "image" ? "[image]" : "")
    .filter((s) => s !== "")
    .join("\n");
}

/** Codex targets: each turn's user messages; a turn's first one can go back (the TUI's rule). */
export function codexTargets(turns: readonly Turn[]): RewindTarget[] {
  const out: RewindTarget[] = [];
  for (const turn of turns) {
    let seen = 0;
    for (const item of turn.items) {
      if (item.type !== "userMessage") continue;
      const text = codexText((item as { content?: unknown }).content);
      if (!text.trim()) continue;
      const first = seen === 0;
      seen++;
      const conversation = !first ? off("Sent as a steer message during a turn, so it cannot be rewound on its own")
        : turn.status === "inProgress" ? off("Turn in progress")
        : ON;
      out.push({
        id: first ? turn.id : `${turn.id}:${item.id}`,
        text,
        createdAt: turn.startedAt === null ? null : new Date(turn.startedAt * (turn.startedAt < 1e12 ? 1000 : 1)).toISOString(),
        checkpoint: false,
        turnChanges: null,
        restore: null,
        conversation,
        code: off(CODEX_CODE_NOTE),
      });
    }
  }
  return out;
}

const CODEX_CODE_NOTE = "Codex rewinds the conversation only, not files (thread/revert changes the conversation record)";

function stats(r: RewindFilesResult): RewindFileStats {
  return { files: r.filesChanged ?? [], insertions: r.insertions ?? 0, deletions: r.deletions ?? 0 };
}

/** "2 files +1 -2", each count only when not zero (the CLI's fR). */
function statsText(s: RewindFileStats): string {
  const counts = [s.insertions > 0 ? `+${s.insertions}` : null, s.deletions > 0 ? `-${s.deletions}` : null].filter((x) => x !== null);
  return [`${s.files.length} ${s.files.length === 1 ? "file" : "files"}`, ...counts].join(" ");
}

export class SessionRewind {
  private deps: SessionRewindDeps;
  private chains = new Map<string, Promise<unknown>>();

  constructor(deps: SessionRewindDeps) {
    this.deps = deps;
  }

  /** The routes; true when the request was one of them. */
  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    io: { readJson: (req: http.IncomingMessage) => Promise<unknown>; sendJson: (res: http.ServerResponse, code: number, body: unknown) => void },
  ): Promise<boolean> {
    if (url.pathname !== "/api/session-rewind" && url.pathname !== "/api/session-rewind/preview") return false;
    try {
      if (url.pathname === "/api/session-rewind/preview") {
        io.sendJson(res, 200, await this.preview(url.searchParams.get("key") ?? "", url.searchParams.get("id") ?? ""));
        return true;
      }
      if (req.method === "GET") {
        io.sendJson(res, 200, await this.list(url.searchParams.get("key") ?? ""));
        return true;
      }
      if (req.method === "POST") {
        io.sendJson(res, 200, await this.rewind((await io.readJson(req)) as SessionRewindRequest));
        return true;
      }
      io.sendJson(res, 405, { error: "Only GET and POST are accepted" });
    } catch (err) {
      const status = err instanceof RewindError ? err.status : err instanceof HostDownError ? 503 : err instanceof DriveError ? 409 : 502;
      if (status === 502) console.error("session rewind failed", err);
      io.sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  async list(key: string): Promise<SessionRewindList> {
    const s = this.session(key);
    if (s.provider === "codex") return this.codexList(s);
    const { targets, state, gate } = await this.claudeTargets(s);
    return {
      key,
      blocked: claudeBlocked(s, state, this.deps.hostUp()),
      codeNote: null,
      targets: targets.map((t) => ({
        id: t.uuid,
        text: t.text,
        createdAt: t.timestamp,
        checkpoint: t.checkpoint,
        turnChanges: t.turnChanges,
        restore: t.restore,
        ...claudeParts(t, state, gate),
      })),
    };
  }

  /**
   * The CLI's dry run for the code of one message, on the session's process when one that keeps
   * checkpoints runs between turns. No process is started for it (a preview should not open the
   * session, run its SessionStart hooks or hold it against the terminal): without one it answers
   * restore null and the screen names the files instead.
   */
  async preview(key: string, id: string): Promise<SessionRewindPreview> {
    const s = this.session(key);
    const state = s.provider === "claude" ? this.deps.runs.rewindState(key) : null;
    // With a rewind waiting, a running process may have resumed short of later checkpoints.
    if (!state || !state.fileCheckpointing || state.busy || state.closing || !id || this.deps.store.get(s.id)) return { restore: null, error: null };
    const dry = await this.deps.runs.call<RewindFilesResult>(key, "rewindFiles", id, { dryRun: true });
    return dry.canRewind ? { restore: stats(dry), error: null } : { restore: null, error: dry.error ?? null };
  }

  /** Goes back; one rewind per session at a time. */
  rewind(req: SessionRewindRequest): Promise<SessionRewindResult> {
    if (!req || typeof req.key !== "string" || typeof req.id !== "string" || !MODES.includes(req.mode)) {
      return Promise.reject(new RewindError(400, "key, id, and mode (both, conversation, code) are required"));
    }
    const prev = this.chains.get(req.key) ?? Promise.resolve();
    const run = prev.then(() => this.rewindNow(req), () => this.rewindNow(req));
    const tail = run.then(() => {}, () => {});
    this.chains.set(req.key, tail);
    void tail.then(() => {
      if (this.chains.get(req.key) === tail) this.chains.delete(req.key);
    });
    return run;
  }

  /**
   * The line a new process for the session resumes up to, while a conversation rewind waits for
   * the next message; null otherwise. A marker the session went past (a run opener written after
   * it, here or in the terminal) is dropped.
   */
  async resumeAt(sessionId: string, transcript: string | null): Promise<string | null> {
    const marker = this.deps.store.get(sessionId);
    if (!marker) return null;
    if (!transcript || !(await markerActiveIn(transcript, marker))) {
      // Only this marker: a rewind made meanwhile on another screen stays.
      this.deps.store.clearIf(sessionId, marker.createdAt);
      return null;
    }
    return marker.keepUuid;
  }

  // ---- Claude ----

  private async claudeTargets(s: SessionSummary): Promise<{
    targets: RewindTargetFacts[]; state: ReturnType<ClaudeRuns["rewindState"]>; file: string; marker: RewindMarker | null; gate: CodeGate;
  }> {
    const account = this.deps.claudeAccounts.find((a) => a.id === s.account);
    if (!account) throw new RewindError(404, `Unknown account: ${s.account}`);
    const file = transcriptOf(account.dir, s.id);
    if (!file) throw new RewindError(404, "Transcript not found");
    const scan = await readRewindTranscript(file);
    let marker = this.deps.store.get(s.id);
    if (marker && !markerActive(scan, marker)) {
      this.deps.store.clearIf(s.id, marker.createdAt);
      this.deps.runs.refreshTurns(s.key);
      marker = null;
    }
    const checkpointingOn = s.cwd ? (this.deps.fileCheckpointing?.(account.dir, s.cwd) ?? true) : true;
    return {
      targets: rewindTargets(scan, marker), state: this.deps.runs.rewindState(s.key), file, marker,
      gate: { checkpointingOn, rewindWaits: marker !== null },
    };
  }

  /**
   * One Claude rewind, with the session to itself (ClaudeRuns.exclusive): a send that comes
   * meanwhile waits for it, so it neither reaches a process the rewind ends nor starts one that
   * misses the rewind. The gates are read again before each step that ends a process or changes files.
   */
  private rewindClaude(key: string, req: SessionRewindRequest): Promise<SessionRewindResult> {
    return this.deps.runs.exclusive(key, async () => {
      const { targets, file, marker, gate } = await this.claudeTargets(this.session(key));
      const check = () => {
        const s = this.session(key);
        const blocked = claudeBlocked(s, this.deps.runs.rewindState(key), this.deps.hostUp());
        if (blocked) throw new RewindError(409, blocked);
      };
      check();
      const t = targets.find((x) => x.uuid === req.id);
      if (!t) throw new RewindError(404, "This message is no longer in the conversation. Reopen the list");
      const parts = claudeParts(t, this.deps.runs.rewindState(key), gate);
      const wantCode = req.mode !== "conversation";
      const wantConversation = req.mode !== "code";
      if (wantCode && !parts.code.enabled) throw new RewindError(409, parts.code.reason ?? "Cannot rewind the code");
      if (wantConversation && !parts.conversation.enabled) throw new RewindError(409, parts.conversation.reason ?? "Cannot rewind the conversation");

      let restored: RewindFileStats | null = null;
      let skipped = 0;
      if (wantCode) {
        // A process that keeps checkpoints and read every one: the running one, or a new one that
        // resumes the whole conversation (also while a conversation rewind waits) and gets no message.
        const st = this.deps.runs.rewindState(key);
        if (st && (!st.fileCheckpointing || marker !== null)) await this.deps.runs.close(key);
        await this.deps.runs.open(key, { fullResume: true });
        if (!this.deps.runs.rewindState(key)?.fileCheckpointing) {
          throw new RewindError(409, "Settings for this account or folder (fileCheckpointingEnabled false) turn off file checkpoints");
        }
        check();
        const dry = await this.deps.runs.call<RewindFilesResult>(key, "rewindFiles", t.uuid, { dryRun: true });
        if (!dry.canRewind) throw new RewindError(409, `Cannot rewind the code: ${dry.error ?? "no reason given"}`);
        check();
        const done = await this.deps.runs.call<RewindFilesResult>(key, "rewindFiles", t.uuid);
        if (!done.canRewind) throw new RewindError(502, `Failed to rewind the code: ${done.error ?? "no reason given"}`);
        restored = stats(dry);
        skipped = done.skippedLinks ?? 0;
        // The process holds the whole conversation: a waiting rewind needs the next one to resume short.
        if (marker !== null && !wantConversation) await this.deps.runs.close(key);
      }
      if (wantConversation) {
        // The process holds the conversation in memory: it ends, and the next one resumes up to the kept line.
        if (this.deps.runs.rewindState(key)) {
          check();
          await this.deps.runs.close(key);
        }
        const lastUuid = await newestNodeUuid(file);
        if (!lastUuid) throw new RewindError(502, "Could not read the last line of the transcript");
        this.deps.store.set(this.session(key).id, { atUuid: t.uuid, keepUuid: t.parentUuid!, lastUuid, createdAt: Date.now() });
        this.deps.runs.refreshTurns(key);
      }
      const what = req.mode === "both" ? "Code and conversation" : req.mode === "code" ? "Code" : "Conversation";
      const notice = [
        `${what} rewound`,
        ...(restored ? [statsText(restored)] : []),
        ...(skipped > 0 ? [`${skipped} ${skipped === 1 ? "file" : "files"} skipped (links or folders that changed)`] : []),
      ];
      return { ok: true, prefill: wantConversation ? t.text : null, restored, notice: notice.join(", ") };
    });
  }

  private async rewindNow(req: SessionRewindRequest): Promise<SessionRewindResult> {
    const s = this.session(req.key);
    if (s.provider === "codex") return this.codexRewind(s, req);
    return this.rewindClaude(req.key, req);
  }

  // ---- Codex ----

  private codexBlocked(s: SessionSummary): string | null {
    if (s.parentKey) return "Cannot rewind a subagent thread";
    if (s.status === "running" || s.status === "waiting-input") {
      return s.owner === "ui" ? "A turn is running, so it cannot be rewound" : "Another client's turn is running, so it cannot be rewound";
    }
    return null;
  }

  private async codexList(s: SessionSummary): Promise<SessionRewindList> {
    const blocked = this.codexBlocked(s);
    if (s.parentKey) return { key: s.key, blocked, codeNote: CODEX_CODE_NOTE, targets: [] };
    const { thread, turns } = await this.deps.codexRuns.rewindTurns(s.key);
    if (thread.historyMode !== "paginated") {
      return { key: s.key, blocked: "Cannot rewind this thread (Codex thread/revert accepts paginated threads only)", codeNote: CODEX_CODE_NOTE, targets: [] };
    }
    return { key: s.key, blocked, codeNote: CODEX_CODE_NOTE, targets: codexTargets(turns) };
  }

  private async codexRewind(s: SessionSummary, req: SessionRewindRequest): Promise<SessionRewindResult> {
    if (req.mode !== "conversation") throw new RewindError(409, CODEX_CODE_NOTE);
    const list = await this.codexList(s);
    if (list.blocked) throw new RewindError(409, list.blocked);
    const t = list.targets.find((x) => x.id === req.id);
    if (!t) throw new RewindError(404, "This message is no longer in the conversation. Reopen the list");
    if (!t.conversation.enabled) throw new RewindError(409, t.conversation.reason ?? "Cannot rewind the conversation");
    await this.deps.codexRuns.revert(s.key, t.id);
    return { ok: true, prefill: t.text, restored: null, notice: "Conversation rewound" };
  }

  private session(key: string): SessionSummary {
    const s = this.deps.index.get(key);
    if (!s) throw new RewindError(404, `Session not found: ${key}`);
    return s;
  }
}
