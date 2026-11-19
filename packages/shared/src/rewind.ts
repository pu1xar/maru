// Rewind (DESIGN.md 6o): going back to the point before one of the user's messages, as the Claude
// Code CLI's Esc Esc screen does. The conversation goes back (the next message continues from
// there) and, for Claude, the files the session edited go back through its file checkpoints.
//
//   GET  /api/session-rewind?key=<session key>   -> SessionRewindList
//   POST /api/session-rewind  SessionRewindRequest -> SessionRewindResult (errors: { error })

/**
 * both          code and conversation (the CLI's "Restore code and conversation")
 * conversation  the conversation only ("Restore conversation")
 * code          the files only ("Restore code")
 */
export type RewindMode = "both" | "conversation" | "code";

/** Whether one part (code, conversation) can go back, and why not. */
export interface RewindPart {
  enabled: boolean;
  /** Why it is off, a short label; null when enabled. */
  reason: string | null;
}

/** Files and line counts, as the CLI's rewind screen sums the session's edits. */
export interface RewindFileStats {
  /** Absolute paths, in the order the session first edited them. */
  files: string[];
  insertions: number;
  deletions: number;
}

export interface RewindTarget {
  /** Claude: the user message's transcript uuid. Codex: the id of the turn the message opened. */
  id: string;
  /** The message as sent (the composer gets it back after a conversation rewind). */
  text: string;
  createdAt: string | null;
  /**
   * The file checkpoint the CLI took when this message was sent (Claude, a process with file
   * checkpointing on). Without it the code of this point cannot be restored.
   */
  checkpoint: boolean;
  /** Edits made from this message until the next one (the CLI's row line); null when not known (Codex). */
  turnChanges: RewindFileStats | null;
  /**
   * The edits written after this message, summed as the transcript has them (also on lines a
   * conversation rewind left). Its files are the ones a code restore may touch; its counts are the
   * edits made, not what a restore changes (that is the preview's dry run). Null when not known (Codex).
   */
  restore: RewindFileStats | null;
  conversation: RewindPart;
  code: RewindPart;
}

export interface SessionRewindList {
  key: string;
  /** Why nothing can go back now (a turn runs, a terminal holds the session); null when it can. */
  blocked: string | null;
  /** Why code never goes back in this session (Codex), shown once; null for Claude. */
  codeNote: string | null;
  /** The user's messages of the current conversation, oldest first. */
  targets: RewindTarget[];
}

/**
 * `GET /api/session-rewind/preview?key=&id=`: what restoring the code to before the message changes,
 * from the CLI's dry run (Query.rewindFiles dryRun) on the session's process when one that keeps
 * checkpoints runs. `restore` is null when no such process runs (a closed session): the screen
 * then names the files edited after the message (RewindTarget.restore) without line counts, since
 * the transcript's edits are not what a restore would change (earlier restores, net effect).
 */
export interface SessionRewindPreview {
  restore: RewindFileStats | null;
  /** Why the dry run refused, when it did (the CLI's error). */
  error: string | null;
}

export interface SessionRewindRequest {
  key: string;
  /** RewindTarget.id */
  id: string;
  mode: RewindMode;
}

export interface SessionRewindResult {
  ok: true;
  /**
   * The message's text, for the composer draft, when the conversation went back (the CLI puts the
   * message back into its prompt); null otherwise.
   */
  prefill: string | null;
  /** What the code restore changed (a dry run just before it); null when the code stayed. */
  restored: RewindFileStats | null;
  /** One line for the composer's notice. */
  notice: string;
}
