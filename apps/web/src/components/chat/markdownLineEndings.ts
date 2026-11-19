/**
 * CommonMark reads CR, CRLF and LF alike as line endings, but a code block keeps the ending as
 * typed, and a browser draws a CR inside `<pre>` as nothing: text the CLI stored with CR breaks
 * showed its code lines run together. Every ending becomes LF before the parse.
 */
export function normalizeMarkdownLineEndings(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}
