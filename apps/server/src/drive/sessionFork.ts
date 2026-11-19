// Fork from a message (DESIGN.md 6q): POST /api/session-fork {key, id} makes a new session that
// holds the conversation up to the message and its answer, and answers with the new key for the
// UI to open. The original session is not touched, also while it runs.
//
// Claude (SDK 0.3.321 forkSession, measured with throwaway sessions 2026-11-16): the transcript is
// copied up to a line into a new file (claude/forkTranscript.ts). No Claude process runs for the
// fork or the original, so the session host is not involved and a session this server or a
// terminal holds can be forked. The newest message of a conversation whose turn is still running
// is refused: its stretch of the transcript is half written (a tool call without its result).
// Codex (codex-cli 0.169.0): thread/fork with lastTurnId, which the daemon refuses for a turn in progress.
//
// The new session is chosen (it shows in the list), takes the original's Group, and is named like
// the original with a fork mark and the next free fork number. The name is stored in maru's own
// name table (the rename call), which every screen shows.
import type http from "node:http";
import type { RenameSession, RenameSessionResult, SessionForkRequest, SessionForkResult, SessionSummary } from "@maru/shared";
import { sessionKey } from "@maru/shared";
import type { ClaudeAccount } from "../config.ts";
import type { SessionIndex } from "../index/store.ts";
import type { ProjectStore } from "../projects/store.ts";
import type { ChosenStore } from "../state/chosen.ts";
import type { SessionRewindStore } from "../state/sessionRewinds.ts";
import { forkClaudeTranscript } from "../claude/forkTranscript.ts";
import { forkCut, markerActive, readRewindTranscript } from "../claude/rewindScan.ts";
import type { ClaudeRuns } from "./claudeRuns.ts";
import { DriveError } from "./claudeRuns.ts";
import type { CodexRuns } from "./codexRuns.ts";
import { transcriptOf } from "./transcriptFacts.ts";

export class ForkError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface SessionForkDeps {
  claudeAccounts: ClaudeAccount[];
  index: Pick<SessionIndex, "get" | "snapshot">;
  runs: Pick<ClaudeRuns, "rewindState">;
  codexRuns: Pick<CodexRuns, "forkAt">;
  /** Conversation rewinds waiting for the next message: the fork keeps only what the rewind kept. */
  store: Pick<SessionRewindStore, "get">;
  chosen: Pick<ChosenStore, "set">;
  projects: Pick<ProjectStore, "projectOf" | "assign">;
  /** The session renamer (sessions/rename.ts). */
  rename: (req: RenameSession) => Promise<RenameSessionResult>;
  /** After a transcript was written, so the index takes the new session now. */
  claudeWritten: (accountId: string, file: string) => Promise<void> | void;
  /** Default: the SDK's forkSession in a process of its own (claude/forkTranscript.ts). */
  forkTranscript?: (account: ClaudeAccount, sessionId: string, upToMessageId: string | null) => Promise<string>;
}

const FORK_MARK = /\s*\(fork(?: (\d+))?\)$/;

/**
 * The new session's name. The base is the original's name, else its title, else its first prompt
 * (whitespace runs are one space) with a trailing "(fork N)" mark removed, so a fork of a fork
 * numbers within the same family. The number is one past the highest already used by a name in
 * `existing` ("<base> (fork)" counts as 1, "<base> (fork N)" as N): the first fork is
 * "<base> (fork)", then "(fork 2)", "(fork 3)". The original's own name counts too. A number below
 * the highest is not handed out again; the number of a deleted highest fork is.
 */
export function forkName(original: Pick<SessionSummary, "name" | "title" | "preview">, existing: Iterable<string> = []): string {
  const raw = (original.name ?? original.title ?? original.preview ?? "").replace(/\s+/g, " ").trim();
  const base = raw.replace(FORK_MARK, "").trim();
  const family = new RegExp(`^${escapeRegExp(base)}\\s*\\(fork(?: (\\d+))?\\)$`);
  let highest = 0;
  for (const name of [raw, ...existing]) {
    const m = family.exec(name.replace(/\s+/g, " ").trim());
    if (m) highest = Math.max(highest, m[1] === undefined ? 1 : Number(m[1]));
  }
  const mark = highest === 0 ? "(fork)" : `(fork ${highest + 1})`;
  return base === "" ? mark : `${base} ${mark}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class SessionFork {
  private deps: SessionForkDeps;

  constructor(deps: SessionForkDeps) {
    this.deps = deps;
  }

  /** The route; true when the request was it. */
  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    io: { readJson: (req: http.IncomingMessage) => Promise<unknown>; sendJson: (res: http.ServerResponse, code: number, body: unknown) => void },
  ): Promise<boolean> {
    if (url.pathname !== "/api/session-fork") return false;
    try {
      if (req.method !== "POST") {
        io.sendJson(res, 405, { error: "Only POST is accepted" });
        return true;
      }
      io.sendJson(res, 200, await this.fork((await io.readJson(req)) as SessionForkRequest));
    } catch (err) {
      const status = err instanceof ForkError ? err.status : err instanceof DriveError ? 409 : 502;
      if (status === 502) console.error("session fork failed", err);
      io.sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  async fork(req: SessionForkRequest): Promise<SessionForkResult> {
    if (!req || typeof req.key !== "string" || typeof req.id !== "string" || req.id === "") {
      throw new ForkError(400, "key and id are required");
    }
    const s = this.deps.index.get(req.key);
    if (!s) throw new ForkError(404, `Session not found: ${req.key}`);
    if (s.parentKey) throw new ForkError(409, "Cannot fork a subagent conversation");
    const newKey = s.provider === "codex" ? await this.forkCodex(s, req.id) : await this.forkClaude(s, req.id);
    const name = forkName(s, this.deps.index.snapshot().flatMap((x) => (x.name ? [x.name] : [])));
    let notice: string | null = null;
    try {
      await this.deps.rename({ provider: s.provider, account: s.account, id: newKey.split(":")[2]!, name });
    } catch (err) {
      notice = `The fork was created but could not be named: ${err instanceof Error ? err.message : String(err)}`;
    }
    return { ok: true, key: newKey, name, notice };
  }

  // ---- Claude ----

  private async forkClaude(s: SessionSummary, id: string): Promise<string> {
    const account = this.deps.claudeAccounts.find((a) => a.id === s.account);
    if (!account) throw new ForkError(404, `Unknown account: ${s.account}`);
    const file = transcriptOf(account.dir, s.id);
    if (!file) throw new ForkError(404, "Transcript not found");
    const scan = await readRewindTranscript(file);
    const stored = this.deps.store.get(s.id);
    const marker = stored && markerActive(scan, stored) ? stored : null;
    const at = forkCut(scan, marker, id);
    if (!at) throw new ForkError(404, "This message is no longer in the conversation. Reload the view");
    if (at.last && this.turnRuns(s)) throw new ForkError(409, "Cannot fork the last message while its turn is running (the reply is still being written)");
    const forkTranscript = this.deps.forkTranscript ?? forkClaudeTranscript;
    const newId = await forkTranscript(account, s.id, at.cut);
    const written = transcriptOf(account.dir, newId);
    if (!written) throw new ForkError(502, "Could not find the forked transcript");
    await this.deps.claudeWritten(account.id, written);
    const key = sessionKey("claude", account.id, newId);
    this.join(s, "claude", newId);
    return key;
  }

  /** A turn of the session runs or waits on an answer, by this server's process or a terminal's. */
  private turnRuns(s: SessionSummary): boolean {
    const state = this.deps.runs.rewindState(s.key);
    return Boolean(state?.busy || state?.pending || s.status === "running" || s.status === "waiting-input");
  }

  // ---- Codex ----

  private async forkCodex(s: SessionSummary, id: string): Promise<string> {
    // A steer message is named `${turn}:${item}` by the rewind screen; it belongs to its turn.
    const turnId = id.split(":")[0]!;
    try {
      // CodexRuns makes the fork chosen and gives it the original's Group.
      return await this.deps.codexRuns.forkAt(s.key, turnId);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      // The daemon's refusals as codex-cli 0.169.0 words them (measured 2026-11-16).
      if (/identifies an in-progress turn/.test(text)) throw new ForkError(409, "Cannot fork a message while its turn is running (fork after the reply ends)");
      if (/turn not found/.test(text)) throw new ForkError(404, "This message is no longer in the conversation. Reload the view");
      throw err;
    }
  }

  /** The new session shows in the list and sits in the original's Group. */
  private join(from: SessionSummary, provider: "claude" | "codex", id: string): void {
    this.deps.chosen.set(provider, id, true);
    const project = this.deps.projects.projectOf(provider, from.id);
    if (!project) return;
    try {
      this.deps.projects.assign(provider, id, project);
    } catch {
      // The Group was deleted meanwhile: the fork stays in 미분류.
    }
  }
}
