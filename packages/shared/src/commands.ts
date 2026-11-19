// The composer's `/` menu (ThreadComposer) and the commands the server runs itself instead of
// sending them as text (Codex: the daemon's own methods, DESIGN.md M2).

/** One entry of a session's `/` menu. */
export interface SessionCommand {
  /** Name without its sigil, e.g. "compact", "humanize-korean:humanize", "caveman". */
  name: string;
  /**
   * What the composer puts in front of the name.
   * /  a command: the provider (Claude) or this server (Codex) runs `/name args`
   * $  a Codex skill: the daemon reads `$name` in the message text and adds the skill
   */
  sigil: "/" | "$";
  description: string;
  /** Hint for the arguments, e.g. "<name>"; "" when the command takes none. */
  argumentHint: string;
  /** Other names that run the same command (Claude). */
  aliases: string[];
  /** builtin: the provider's own; custom: a user, project or plugin command or skill. */
  source: "builtin" | "custom";
  /**
   * maru runs it with its own picker, or does not support it (sessionControls.ts). Absent: the
   * command goes to the provider as text.
   */
  handling?: import("./sessionControls.ts").CommandHandling;
}

/**
 * GET /api/session-commands?key=<session key>[&refresh=1] -> SessionCommandsResponse
 * 400 not a top-level session key, 404 no such session, 409 the list cannot be read for it
 * (missing working folder), 502 the provider failed to answer.
 * refresh=1 reads the list again instead of answering from the server's cache.
 */
export interface SessionCommandsResponse {
  key: string;
  commands: SessionCommand[];
  /**
   * run    the process this server runs for the session answered
   * probe  a CLI started only to list them (no message, no model call) answered just now
   * cache  an earlier answer for the same account and working folder, still current
   * daemon the Codex commands this server runs, and the skills the daemon lists for the folder
   */
  from: "run" | "probe" | "cache" | "daemon";
  /** When the list was read, ms since epoch. */
  readAt: number;
}

/**
 * Server -> the UI that sent the command: a command the server ran itself finished. Sent only to
 * that UI, after the daemon answered; what the command started (a turn) shows in the conversation.
 */
export interface CommandResultMessage {
  type: "command.result";
  reqId?: string;
  threadId: string;
  /** The command name, e.g. "goal". */
  command: string;
  /** Text for the notice area above the composer (a result the conversation does not record). */
  notice?: string;
  /** Send now (`command: "sendNow"`): what happened; `moved` counts the tasks sent to background, `sent` the waiting messages sent again with priority now. */
  sendNow?: { outcome: "sent" | "moved" | "nothing" | "stopped"; moved: number; sent: number };
  /** Session key the UI opens (the thread /fork made). */
  open?: string;
  /**
   * The message as typed, when the server did not send it (a command maru does not support): the
   * composer puts it back while its input is still empty.
   */
  unsent?: string;
}
