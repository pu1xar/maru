// The process forkClaudeTranscript (forkTranscript.ts) runs: the SDK's forkSession for one account.
// argv[2] is JSON {sessionId, upToMessageId}; the account is CLAUDE_CONFIG_DIR. It prints one JSON
// line, {sessionId} for the new session or {error}, and exits 0 or 1.
import { forkSession } from "@anthropic-ai/claude-agent-sdk";

try {
  const a = JSON.parse(process.argv[2] ?? "") as { sessionId: string; upToMessageId?: string };
  const r = await forkSession(a.sessionId, a.upToMessageId ? { upToMessageId: a.upToMessageId } : {});
  process.stdout.write(`${JSON.stringify({ sessionId: r.sessionId })}\n`);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`);
  process.exitCode = 1;
}
