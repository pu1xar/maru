// The text a composer sends. Shared so the web's composers and the Android app's input trim a
// message the same way (DESIGN.md 7: the input drops only the trailing whitespace).

/**
 * The text a composer sends: as typed, without the trailing whitespace, or null when nothing but
 * whitespace was typed. The start stays, as Claude Code's own prompt keeps it, so a message that
 * opens with indented code keeps its first line's indentation.
 */
export function messageToSend(raw: string): string | null {
  const body = raw.trimEnd();
  return body.trim() === "" ? null : body;
}
