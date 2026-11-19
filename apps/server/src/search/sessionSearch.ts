// Search over every session's conversation (DESIGN.md 6u): GET /api/search.
//
// An index in memory holds the user and assistant texts of every top-level transcript the server
// lists: Claude `projects/*/<session>.jsonl`, Codex `sessions/**/rollout-*.jsonl`. The texts are
// small next to the transcripts (2.6 GB of Claude transcripts hold about 8 million characters of
// messages; tool output is the bulk), so a search is a scan of those strings.
//
// Each search first catches the index up with the files: a file whose size and mtime are as read
// is left as it is, a file that grew is read from where the last read stopped (whole lines), and a
// file that shrank or was replaced is read again. The first search reads every file once.
//
// The texts are the projection's own, so a hit names the item the conversation shows:
// - Claude: each line goes through extractLine (the projector's per-line step) with the session key
//   as the thread id; a user or assistant item's id and text are the projection's.
// - Codex: `item_completed` records of UserMessage and AgentMessage give the item id the daemon
//   serves (codexItemRowId) and its text. A rollout from before item records has `user_message` and
//   `agent_message` events without ids; their hits carry the time only, and the find in the opened
//   thread picks the same role's nearest occurrence (threadSearch.ts hintedFindIndex).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { SearchHit, SearchResponse, SearchRole, SessionSummary } from "@maru/shared";
import { findOccurrences, hasSearchText, sessionKey, snippetAt } from "@maru/shared";
import type { ClaudeAccount, CodexAccount } from "../config.ts";
import { extractLine, type ExtractCtx } from "../claude/projection/extract.ts";
import { codexItemRowId } from "../codex/projection/mapItems.ts";
import { mapRolloutItem } from "../codex/projection/rolloutItems.ts";

/** Bytes read per step while catching a file up: an I/O step, not a limit (the file is read to its end). */
const READ_CHUNK = 8 * 1024 * 1024;
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const NEWLINE = 0x0a;

interface IndexText {
  itemId: string | null;
  role: SearchRole;
  at: string | null;
  text: string;
  /** `text` folded once, so a search compares without folding every text again. */
  lower: string;
}

interface IndexedFile {
  path: string;
  provider: "claude" | "codex";
  account: string;
  /** The session key; a Codex rollout learns it from its first line (session_meta). */
  key: string | null;
  size: number;
  mtimeMs: number;
  ino: number;
  /** Bytes read so far: the start of the first line not read yet. */
  offset: number;
  texts: IndexText[];
  /** Codex: the event-only texts of a rollout from before item records (used when it has no item texts). */
  legacy: IndexText[];
}

export interface SessionSearchDeps {
  claudeAccounts: readonly ClaudeAccount[];
  codexAccounts: readonly CodexAccount[];
  /** Every session the server lists (the scan, not only the chosen ones), by key. */
  session: (key: string) => SessionSummary | undefined;
}

export interface SearchOptions {
  offset?: number;
  limit?: number;
}

export class SessionSearch {
  private deps: SessionSearchDeps;
  private files = new Map<string, IndexedFile>();
  private refreshing: Promise<number> | null = null;

  constructor(deps: SessionSearchDeps) {
    this.deps = deps;
  }

  /** Hits for `query` over every listed session, newest first, `limit` of them from `offset`. */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
    const limit = Math.max(1, Math.trunc(opts.limit ?? 50));
    const refreshMs = await this.refresh();
    const t0 = performance.now();
    const all: Array<{ hit: SearchHit; sort: string }> = [];
    let searchedSessions = 0;
    let searchedTexts = 0;
    let unlistedFiles = 0;
    const seenSessions = new Set<string>();
    const q = query.toLowerCase();
    for (const f of this.files.values()) {
      if (!f.key || !this.deps.session(f.key)) {
        unlistedFiles++;
        continue;
      }
      if (!seenSessions.has(f.key)) {
        seenSessions.add(f.key);
        searchedSessions++;
      }
      const texts = f.texts.length > 0 || f.legacy.length === 0 ? f.texts : f.legacy;
      searchedTexts += texts.length;
      if (!hasSearchText(query)) continue;
      for (const t of texts) {
        if (!t.lower.includes(q)) continue;
        const at = findOccurrences(t.text, query);
        const first = at[0] ?? 0;
        all.push({
          sort: t.at ?? "",
          hit: { key: f.key, itemId: t.itemId, role: t.role, at: t.at, count: Math.max(1, at.length), snippet: snippetAt(t.text, first, query.length) },
        });
      }
    }
    all.sort((a, b) => (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0));
    const hits = all.slice(offset, offset + limit).map((x) => x.hit);
    const keys = [...new Set(hits.map((h) => h.key))];
    const sessions = keys.map((k) => this.deps.session(k)).filter((s): s is SessionSummary => s !== undefined);
    return {
      query, hits, sessions, total: all.length, offset,
      searchedSessions, searchedTexts, unlistedFiles,
      refreshMs: Math.round(refreshMs), searchMs: Math.round(performance.now() - t0),
    };
  }

  /** Brings the index up to the files; concurrent searches share one pass. Resolves to its ms. */
  refresh(): Promise<number> {
    if (!this.refreshing) {
      const t0 = performance.now();
      this.refreshing = this.catchUp()
        .then(() => performance.now() - t0)
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  /** What the index holds now, for measurements. */
  stats(): { files: number; texts: number; chars: number; bytes: number } {
    let texts = 0;
    let chars = 0;
    let bytes = 0;
    for (const f of this.files.values()) {
      texts += f.texts.length + f.legacy.length;
      for (const t of f.texts) chars += t.text.length;
      for (const t of f.legacy) chars += t.text.length;
      bytes += f.offset;
    }
    return { files: this.files.size, texts, chars, bytes };
  }

  private async catchUp(): Promise<void> {
    const seen = new Set<string>();
    for (const a of this.deps.claudeAccounts) {
      for (const file of claudeTranscripts(a.dir)) {
        seen.add(file);
        await this.catchUpFile(file, "claude", a.id);
      }
    }
    for (const a of this.deps.codexAccounts) {
      for (const file of codexRollouts(path.join(a.home, "sessions"))) {
        seen.add(file);
        await this.catchUpFile(file, "codex", a.id);
      }
    }
    for (const file of [...this.files.keys()]) if (!seen.has(file)) this.files.delete(file);
  }

  private async catchUpFile(file: string, provider: "claude" | "codex", account: string): Promise<void> {
    let st: fs.Stats;
    try {
      st = await fsp.stat(file);
    } catch {
      this.files.delete(file);
      return;
    }
    let f = this.files.get(file);
    if (f && f.size === st.size && f.mtimeMs === st.mtimeMs && f.ino === st.ino) return;
    // Grown in place: read on from the last whole line. Shrunk or replaced: read again.
    if (!f || f.ino !== st.ino || st.size < f.offset) {
      const m = provider === "claude" ? SESSION_FILE.exec(path.basename(file)) : null;
      f = {
        path: file, provider, account,
        key: m ? sessionKey("claude", account, m[1]!) : null,
        size: 0, mtimeMs: 0, ino: st.ino, offset: 0, texts: [], legacy: [],
      };
      this.files.set(file, f);
    }
    await readLines(file, f.offset, st.size, (line, offset) => this.take(f!, line, offset), (end) => {
      f!.offset = end;
    });
    f.size = st.size;
    f.mtimeMs = st.mtimeMs;
  }

  /** One line of a transcript into the file's texts. */
  private take(f: IndexedFile, line: Buffer, offset: number): void {
    if (f.provider === "claude") return takeClaudeLine(f, line, offset);
    return takeCodexLine(f, line);
  }
}

const USER = Buffer.from('"type":"user"');
const ASSISTANT = Buffer.from('"type":"assistant"');

function takeClaudeLine(f: IndexedFile, line: Buffer, offset: number): void {
  if (!f.key || (line.indexOf(USER) < 0 && line.indexOf(ASSISTANT) < 0)) return;
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    return;
  }
  const sessionId = f.key.split(":")[2]!;
  const ctx: ExtractCtx = { threadId: f.key, kind: "top", path: f.path, providerInstanceId: `claude:${f.account}`, providerThreadId: sessionId };
  const facts = extractLine({ offset, length: line.length + 1, line: null, value }, ctx);
  for (const op of facts.ops) {
    if (op.op !== "item") continue;
    const item = op.t.item;
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    if (item.text.length === 0) continue;
    pushText(f.texts, item.id, item.type === "user_message" ? "user" : "assistant", item.startedAt ?? item.updatedAt ?? facts.timestamp, item.text);
  }
}

const ITEM_COMPLETED = Buffer.from('"item_completed"');
const USER_EVENT = Buffer.from('"user_message"');
const AGENT_EVENT = Buffer.from('"agent_message"');
const SESSION_META = Buffer.from('"session_meta"');

function takeCodexLine(f: IndexedFile, line: Buffer): void {
  const meta = f.key === null && line.indexOf(SESSION_META) >= 0;
  const item = line.indexOf(ITEM_COMPLETED) >= 0;
  const legacy = !item && (line.indexOf(USER_EVENT) >= 0 || line.indexOf(AGENT_EVENT) >= 0);
  if (!meta && !item && !legacy) return;
  let v: Record<string, any>;
  try {
    v = JSON.parse(line.toString("utf8"));
  } catch {
    return;
  }
  const payload = v?.payload;
  if (meta && v.type === "session_meta" && typeof payload?.id === "string") {
    f.key = sessionKey("codex", f.account, payload.id);
    return;
  }
  if (!f.key || v.type !== "event_msg" || typeof payload !== "object" || payload === null) return;
  if (payload.type === "item_completed") {
    const raw = payload.item;
    const mapped = mapRolloutItem(raw, { startedAtMs: num(payload.started_at_ms), completedAtMs: num(payload.completed_at_ms) });
    if (!mapped) return;
    const at = mapped.startedAtMs != null ? new Date(mapped.startedAtMs).toISOString() : (typeof v.timestamp === "string" ? v.timestamp : null);
    if (mapped.type === "userMessage") {
      const text = mapped.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
      if (text) pushText(f.texts, codexItemRowId(f.key, mapped.id), "user", at, text);
    } else if (mapped.type === "agentMessage" && mapped.text) {
      pushText(f.texts, codexItemRowId(f.key, mapped.id), "assistant", at, mapped.text);
    }
    return;
  }
  if ((payload.type === "user_message" || payload.type === "agent_message") && typeof payload.message === "string" && payload.message) {
    pushText(f.legacy, null, payload.type === "user_message" ? "user" : "assistant", typeof v.timestamp === "string" ? v.timestamp : null, payload.message);
  }
}

function pushText(into: IndexText[], itemId: string | null, role: SearchRole, at: string | null, text: string): void {
  // A copy of its own, so the text does not keep the whole parsed line alive (V8 sliced strings).
  const own = Buffer.from(text, "utf8").toString("utf8");
  into.push({ itemId, role, at, text: own, lower: own.toLowerCase() });
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Reads whole lines of [start, end) in READ_CHUNK steps; `done` gets the offset after the last whole line. */
async function readLines(
  file: string, start: number, end: number,
  onLine: (line: Buffer, offset: number) => void,
  done: (offset: number) => void,
): Promise<void> {
  if (start >= end) return;
  const fh = await fsp.open(file, "r");
  try {
    let pos = start;
    let carry: Buffer | null = null;
    let carryStart = start;
    while (pos < end) {
      const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, end - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead <= 0) break;
      const chunk = buf.subarray(0, bytesRead);
      const data: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
      const dataStart = carry ? carryStart : pos;
      let lineStart = 0;
      for (let nl = data.indexOf(NEWLINE); nl >= 0; nl = data.indexOf(NEWLINE, lineStart)) {
        if (nl > lineStart) onLine(data.subarray(lineStart, nl), dataStart + lineStart);
        lineStart = nl + 1;
      }
      done(dataStart + lineStart);
      carry = lineStart < data.length ? data.subarray(lineStart) : null;
      carryStart = dataStart + lineStart;
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
}

/** Top-level Claude transcripts: `projects/<folder>/<session id>.jsonl`. */
function claudeTranscripts(accountDir: string): string[] {
  const projects = path.join(accountDir, "projects");
  const out: string[] = [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return out;
  }
  for (const d of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(projects, d));
    } catch {
      continue;
    }
    for (const n of names) if (SESSION_FILE.test(n)) out.push(path.join(projects, d, n));
  }
  return out;
}

/** Codex rollouts under `sessions/` (dated folders). */
function codexRollouts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return out;
}
