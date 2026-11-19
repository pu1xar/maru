// Builder for synthetic Claude Code transcripts (the JSONL that the CLI writes under
// `<config dir>/projects/<encoded cwd>/<session id>.jsonl`), used by scripts/screenshots.
// The records follow the shapes maru's projection reads (apps/server/src/claude/projection).
import { randomUUID } from "node:crypto";

const hex = (n) => randomUUID().replaceAll("-", "").slice(0, n);

export function toolUseId() {
  return `toolu_01${hex(22)}`;
}

/**
 * One transcript. `clock` is ms since epoch of the first line; every line moves it forward.
 * `agentId` makes a subagent transcript (isSidechain lines).
 */
export class Transcript {
  constructor({ sessionId, cwd, startMs, model = "claude-opus-5-5", agentId, gitBranch = "main" }) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.clock = startMs;
    this.model = model;
    this.agentId = agentId;
    this.gitBranch = gitBranch;
    this.lines = [];
    this.parent = null;
    this.msgN = 0;
    this.prompt = 0;
  }

  base() {
    const b = { sessionId: this.sessionId, cwd: this.cwd, version: "2.1.0", userType: "external", entrypoint: "cli", gitBranch: this.gitBranch };
    if (this.agentId) b.agentId = this.agentId;
    return b;
  }

  push(o, stepMs = 3000) {
    const uuid = randomUUID();
    this.clock += stepMs;
    this.lines.push({ parentUuid: this.parent, isSidechain: !!this.agentId, ...this.base(), ...o, uuid, timestamp: new Date(this.clock).toISOString() });
    this.parent = uuid;
    return uuid;
  }

  /** A prompt the person typed. */
  user(text, stepMs = 20_000) {
    this.turnStart = this.clock + stepMs;
    return this.push({ type: "user", message: { role: "user", content: text }, promptId: `p${++this.prompt}`, ...(this.agentId ? {} : { origin: { kind: "human" } }) }, stepMs);
  }

  assistantBlock(block, stepMs) {
    const id = `msg_01${hex(22)}`;
    return this.push({
      type: "assistant",
      requestId: `req_011${hex(21)}`,
      message: {
        model: this.model, id, type: "message", role: "assistant", content: [block], stop_reason: null,
        usage: { input_tokens: 4, cache_creation_input_tokens: 1200, cache_read_input_tokens: 38000 + this.msgN++ * 900, output_tokens: 180 },
      },
    }, stepMs);
  }

  text(text, stepMs = 6000) {
    return this.assistantBlock({ type: "text", text }, stepMs);
  }

  thinking(text, stepMs = 4000) {
    return this.assistantBlock({ type: "thinking", thinking: text, signature: hex(32) }, stepMs);
  }

  /** A tool call without a result yet (a running tool). Returns the tool_use id. */
  toolUse(name, input, stepMs = 2500) {
    const id = toolUseId();
    const uuid = this.assistantBlock({ type: "tool_use", id, name, input }, stepMs);
    this.lastToolAssistant = uuid;
    return id;
  }

  toolResult(id, content, structured, { isError = false, stepMs = 2000 } = {}) {
    return this.push({
      type: "user",
      message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content, is_error: isError }] },
      ...(structured === undefined ? {} : { toolUseResult: structured }),
      sourceToolAssistantUUID: this.lastToolAssistant,
    }, stepMs);
  }

  tool(name, input, content, structured, opts) {
    const id = this.toolUse(name, input);
    this.toolResult(id, content, structured, opts);
    return id;
  }

  read(filePath, fileText) {
    const lines = fileText.replace(/\n$/, "").split("\n");
    const numbered = lines.map((l, i) => `${String(i + 1).padStart(6)}→${l}`).join("\n");
    return this.tool("Read", { file_path: filePath }, numbered, {
      type: "text",
      file: { filePath, content: fileText, numLines: lines.length, startLine: 1, totalLines: lines.length },
    });
  }

  bash(command, description, stdout, { stderr = "", isError = false } = {}) {
    return this.tool("Bash", { command, description }, isError ? `${stdout}${stderr}` : stdout, { stdout, stderr, interrupted: false, isImage: false }, { isError });
  }

  grep(pattern, path, filenames) {
    return this.tool("Grep", { pattern, path, output_mode: "files_with_matches" }, `Found ${filenames.length} files\n${filenames.join("\n")}`, {
      mode: "files_with_matches", filenames, numFiles: filenames.length,
    });
  }

  /** An Edit with its unified hunks. `hunks`: [{ oldStart, newStart, lines: [" ctx", "-old", "+new"] }]. */
  edit(filePath, oldString, newString, originalFile, hunks) {
    const structuredPatch = hunks.map((h) => ({
      oldStart: h.oldStart,
      oldLines: h.lines.filter((l) => !l.startsWith("+")).length,
      newStart: h.newStart,
      newLines: h.lines.filter((l) => !l.startsWith("-")).length,
      lines: h.lines,
    }));
    return this.tool("Edit", { file_path: filePath, old_string: oldString, new_string: newString, replace_all: false },
      `The file ${filePath} has been updated successfully.`,
      { filePath, oldString, newString, originalFile, structuredPatch, userModified: false, replaceAll: false });
  }

  write(filePath, content) {
    return this.tool("Write", { file_path: filePath, content }, `File created successfully at: ${filePath}`, {
      type: "create", filePath, content, structuredPatch: [],
    });
  }

  taskCreate(id, subject, description) {
    return this.tool("TaskCreate", { subject, description, activeForm: subject }, `Task #${id} created successfully: ${subject}`, { task: { id: String(id), subject } });
  }

  taskUpdate(id, status) {
    return this.tool("TaskUpdate", { taskId: String(id), status }, `Updated task #${id} status`, { success: true, taskId: String(id), updatedFields: ["status"] });
  }

  /** End of a turn, as the CLI records it. */
  turnEnd() {
    const durationMs = this.turnStart ? this.clock - this.turnStart + 1500 : 30_000;
    this.push({ type: "system", subtype: "turn_duration", durationMs, messageCount: 6, isMeta: false }, 1500);
  }

  /** The session's generated title, as a running CLI appends it. */
  title(aiTitle) {
    this.lines.push({ type: "ai-title", aiTitle, sessionId: this.sessionId });
  }

  jsonl() {
    return this.lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  }
}
