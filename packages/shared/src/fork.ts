// Fork from a message (DESIGN.md 6q): a new session that holds the conversation up to one of the
// user's messages and that message's answer, in the same account and folder and the same Group.
// The original session is not touched.
//
//   POST /api/session-fork  SessionForkRequest -> SessionForkResult (errors: { error })

export interface SessionForkRequest {
  /** The session the message belongs to. */
  key: string;
  /**
   * The message, as the rewind screen names it (SessionRewindRequest.id): the transcript uuid of a
   * Claude message, the turn id of a Codex one.
   */
  id: string;
}

export interface SessionForkResult {
  ok: true;
  /** Key of the new session, which the UI opens. */
  key: string;
  /** The name the new session got (the original's name with a fork mark). */
  name: string;
  /** One line to show when something besides the fork itself needs saying (a name that could not be set); null otherwise. */
  notice: string | null;
}
