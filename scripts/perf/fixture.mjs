// Synthetic Claude account folder for the idle-cost measurement (scripts/perf/measure.mjs).
// Everything is written under a scratch root: transcripts, session registrations, subagent files.
// Nothing here touches the real ~/.claude or any live service.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const hex = (n) => randomUUID().replaceAll("-", "").slice(0, n);

/** One session's transcript lines. `running` leaves a Bash and an Agent call without a result. */
export function transcriptLines({ sessionId, cwd, turns, running, title }) {
  const lines = [];
  let parent = null;
  let t = Date.now() - (turns + 5) * 20_000;
  const base = () => ({ sessionId, cwd, version: "2.1.0", userType: "external", entrypoint: "cli" });
  const push = (o) => {
    const uuid = randomUUID();
    t += 4000;
    lines.push({ parentUuid: parent, isSidechain: false, ...base(), ...o, uuid, timestamp: new Date(t).toISOString() });
    parent = uuid;
    return uuid;
  };
  const assistant = (msgId, idx, block) =>
    push({
      type: "assistant",
      message: {
        model: "claude-opus-5-5", id: msgId, type: "message", role: "assistant", content: [block],
        usage: { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 5000, output_tokens: 50 },
      },
      apiBlockIndex: idx,
    });
  const tag = sessionId.slice(0, 6);
  for (let i = 0; i < turns; i++) {
    push({ type: "user", message: { role: "user", content: `${title} step ${i}: look at the files and report` }, promptId: `p${i}`, origin: { kind: "human" } });
    assistant(`msg_${tag}_${i}_a`, 0, { type: "text", text: `Step ${i}. I will inspect the folder and then summarize what I find.\n\n- item one\n- item two` });
    const toolId = `toolu_${hex(12)}`;
    const use = assistant(`msg_${tag}_${i}_b`, 0, { type: "tool_use", id: toolId, name: "Bash", input: { command: `ls -la dir${i}`, description: "list" } });
    push({
      type: "user",
      message: { role: "user", content: [{ tool_use_id: toolId, type: "tool_result", content: "a\nb\nc", is_error: false }] },
      toolUseResult: { stdout: "a\nb\nc", stderr: "", interrupted: false, isImage: false },
      sourceToolAssistantUUID: use,
    });
    assistant(`msg_${tag}_${i}_c`, 0, { type: "text", text: `Found three entries in dir${i}.` });
    push({ type: "system", subtype: "turn_duration", durationMs: 9000, messageCount: 4 });
  }
  let agentToolId = null;
  if (running) {
    push({ type: "user", message: { role: "user", content: `${title}: now run the long job and also research in a subagent` }, promptId: "plast", origin: { kind: "human" } });
    assistant(`msg_${tag}_r0`, 0, { type: "text", text: "Starting the long job and a research subagent." });
    assistant(`msg_${tag}_r1`, 0, { type: "tool_use", id: `toolu_${hex(12)}`, name: "Bash", input: { command: "python3 -c 'import time; time.sleep(3600)'", description: "long job" } });
    agentToolId = `toolu_${hex(12)}`;
    assistant(`msg_${tag}_r2`, 0, { type: "tool_use", id: agentToolId, name: "Agent", input: { description: "Market research", subagent_type: "general-purpose", model: "sonnet", prompt: "research prices" } });
  }
  return { lines, lastUuid: parent, agentToolId };
}

/**
 * Build `<home>/.claude` with the given sessions and return what the runner needs.
 * sessions: [{ title, running, turns }]. Each running session gets a registration file whose
 * pid belongs to a process the caller started (`pids[i]`), so the server sees a live holder.
 */
export function buildFixture({ home, sessions, pids }) {
  const dir = path.join(home, ".claude");
  const out = [];
  let runningSeen = 0;
  sessions.forEach((s, i) => {
    const cwd = path.join(home, "work", `proj${i % 3}`);
    fs.mkdirSync(cwd, { recursive: true });
    const enc = cwd.replace(/[^A-Za-z0-9]/g, "-");
    const projDir = path.join(dir, "projects", enc);
    fs.mkdirSync(projDir, { recursive: true });
    const sessionId = randomUUID();
    const { lines, lastUuid, agentToolId } = transcriptLines({ sessionId, cwd, turns: s.turns ?? 12, running: s.running, title: s.title });
    const file = path.join(projDir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    if (s.running) {
      const sub = path.join(projDir, sessionId, "subagents");
      fs.mkdirSync(sub, { recursive: true });
      const agentId = `a${hex(16)}`;
      fs.writeFileSync(path.join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ description: "Market research", agentType: "general-purpose", model: "sonnet", toolUseId: agentToolId, finished: false }));
      fs.writeFileSync(path.join(sub, `agent-${agentId}.jsonl`), JSON.stringify({ parentUuid: null, isSidechain: true, agentId, type: "user", message: { role: "user", content: "research prices" }, uuid: randomUUID(), sessionId, cwd, timestamp: new Date().toISOString() }) + "\n");
      fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
      const pid = pids[runningSeen++];
      fs.writeFileSync(path.join(dir, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, status: "busy", entrypoint: "cli", cwd, updatedAt: Date.now(), statusUpdatedAt: Date.now() }));
    }
    out.push({ sessionId, file, cwd, running: !!s.running, lastUuid, key: `claude:perf:${sessionId}`, turns: s.turns ?? 12 });
  });
  return { dir, sessions: out };
}

/** Append one assistant text line to a transcript (simulates a streaming turn). */
export function appendAssistantLine(sess, n) {
  const uuid = randomUUID();
  const line = {
    parentUuid: sess.lastUuid, isSidechain: false, sessionId: sess.sessionId, cwd: sess.cwd, version: "2.1.0",
    type: "assistant",
    message: { model: "claude-opus-5-5", id: `msg_live_${n}`, type: "message", role: "assistant", content: [{ type: "text", text: `Progress update ${n}: still working on the long job.` }], usage: { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 5000, output_tokens: 20 } },
    apiBlockIndex: 0, uuid, timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(sess.file, JSON.stringify(line) + "\n");
  sess.lastUuid = uuid;
}
