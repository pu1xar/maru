// What the rewind screen (DESIGN.md 6o) needs from a Claude transcript: the user's messages of the
// current conversation, the file checkpoint of each, and the edits after each.
//
// Rules, from the CLI 2.1.325 bundle (MessageSelector, rewindConversationTo, xN) and measurements:
// - The current conversation is the parentUuid chain from the newest leaf back to its root. A
//   compaction starts a new root, so messages before it are not in the chain (the CLI cannot go
//   back to them either: they are no longer in the model's context).
// - A message on that chain can be picked when the CLI's selector would list it: a user line that
//   is not a tool result, not meta, not a compact summary, written by a person (origin absent or
//   "human"), and not a command's output.
// - Going back to a message continues from its parent line. The first message of a session has no
//   parent, and the SDK's resumeSessionAt needs one, so the conversation cannot go back to before it.
// - The file checkpoint of a message is the `file-history-snapshot` line whose messageId is the
//   message's uuid. The CLI writes one per message only while checkpointing is on (the terminal's
//   default; the SDK's enableFileCheckpointing). It keeps the newest 100 of a session and deletes
//   the backups only older ones used (its dnr and NIr), so an older line stands for no checkpoint.
// - Edits are the tool results the CLI's rewind screen sums (its Zjt): a result with a filePath and
//   a structuredPatch, or a created file's content. Bash changes are not tracked (nor restored).
// - After a conversation rewind and before the next message, the transcript is unchanged: the
//   marker (RewindMarker) stands in for the next message under the kept line (rewindLeaf).
import fs from "node:fs/promises";
import { readTail } from "../transcript/claudeTranscript.ts";
import { isOpener } from "./projection/extract.ts";

/** A conversation rewind waiting for the session's next message (state/sessionRewinds.ts). */
export interface RewindMarker {
  /** The message the conversation went back to before. */
  atUuid: string;
  /** Its parent line: the next process resumes up to here (resumeSessionAt). */
  keepUuid: string;
  /**
   * The newest line with a uuid when the rewind was made: a run opener written after it ends the
   * marker. A uuid, not a byte offset, since a rehome rewrites every line (its cwd) in place.
   */
  lastUuid: string;
  createdAt: number;
}

export interface ScanNode {
  uuid: string;
  parentUuid: string | null;
  /** The line's `type` (user, assistant, attachment, system). */
  kind: string;
  opener: boolean;
  offset: number;
}

export interface ScanMessage {
  uuid: string;
  text: string;
  timestamp: string | null;
}

export interface ScanEdit {
  /** uuid of the tool result line. */
  uuid: string;
  offset: number;
  file: string;
  insertions: number;
  deletions: number;
}

export interface RewindTranscript {
  /** Lines with a uuid, file order. */
  nodes: ScanNode[];
  /** Messages the selector lists, by uuid. */
  messages: Map<string, ScanMessage>;
  /** messageIds of the file-history-snapshot lines, in the order of their latest line. */
  snapshots: Set<string>;
  edits: ScanEdit[];
}

/** Checkpoints the CLI keeps per session (2.1.325 `dnr`): the newest ones, older backups are deleted. */
export const CLI_CHECKPOINTS_KEPT = 100;

/** The messages whose checkpoint the CLI still has: the newest CLI_CHECKPOINTS_KEPT snapshot lines. */
export function keptCheckpoints(t: RewindTranscript): Set<string> {
  const ids = [...t.snapshots];
  return new Set(ids.slice(Math.max(0, ids.length - CLI_CHECKPOINTS_KEPT)));
}

export interface RewindTargetFacts {
  uuid: string;
  parentUuid: string | null;
  offset: number;
  text: string;
  timestamp: string | null;
  checkpoint: boolean;
  turnChanges: { files: string[]; insertions: number; deletions: number };
  restore: { files: string[]; insertions: number; deletions: number };
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

const NODE_TYPES = new Set(["user", "assistant", "attachment", "system"]);
const COMMAND_OUTPUT = ["<local-command-stdout>", "<local-command-stderr>", "<bash-stdout>", "<bash-stderr>", "<local-command-caveat>", "[Request interrupted"];

function joined(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((b) => (rec(b)?.type === "text" && typeof rec(b)!.text === "string" ? [rec(b)!.text as string] : [])).join("\n");
}

function tag(text: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(text);
  return m === null ? null : m[1]!;
}

/**
 * The text a person typed, as the composer would hold it again: a slash command as `/name args`
 * (the transcript wraps it in command tags), a shell command typed with `!` as `!command`.
 */
export function promptText(content: unknown): string {
  const s = joined(content);
  const name = tag(s, "command-name");
  if (name !== null) {
    const args = tag(s, "command-args")?.trim() ?? "";
    const cmd = name.trim().startsWith("/") ? name.trim() : `/${name.trim()}`;
    return args ? `${cmd} ${args}` : cmd;
  }
  const bash = tag(s, "bash-input");
  if (bash !== null) return `!${bash}`;
  return s;
}

/** The CLI selector's test (vK over jvo "text"): a person's own message. */
export function isRewindMessage(d: Rec): boolean {
  if (d.type !== "user" || d.isMeta === true || d.isCompactSummary === true || d.isVisibleInTranscriptOnly === true) return false;
  if (d.isSidechain === true || d.stackedExpansion !== undefined) return false;
  const kind = rec(d.origin)?.kind;
  if (kind !== undefined && kind !== "human") return false;
  const content = rec(d.message)?.content;
  if (Array.isArray(content) && rec(content[0])?.type === "tool_result") return false;
  const s = joined(content).trimStart();
  if (COMMAND_OUTPUT.some((t) => s.startsWith(t))) return false;
  return true;
}

/** Lines of `text` as the CLI counts a created file (no line for a final newline). */
function lineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

/** The CLI's sle and ile: one edit of a tool result, or null when the result is no tracked edit. */
export function editOf(result: unknown): { file: string; insertions: number; deletions: number } | null {
  const r = rec(result);
  if (!r || r.staged === true || typeof r.filePath !== "string") return null;
  const patch = Array.isArray(r.structuredPatch) ? r.structuredPatch : [];
  const created = r.type === "create" && typeof r.content === "string";
  if (patch.length === 0 && !created) return null;
  if (patch.length === 0) return { file: r.filePath, insertions: lineCount(r.content as string), deletions: 0 };
  let insertions = 0;
  let deletions = 0;
  for (const hunk of patch) {
    for (const line of (rec(hunk)?.lines as unknown[] | undefined) ?? []) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) insertions++;
      else if (line.startsWith("-")) deletions++;
    }
  }
  return { file: r.filePath, insertions, deletions };
}

/** Folds one parsed line into `t`. */
export function addLine(t: RewindTranscript, offset: number, value: unknown): void {
  const d = rec(value);
  if (!d) return;
  if (d.type === "file-history-snapshot") {
    const id = str(d.messageId) ?? str(rec(d.snapshot)?.messageId);
    if (id) {
      // An update line moves the snapshot to the newest place, as the CLI's list does.
      t.snapshots.delete(id);
      t.snapshots.add(id);
    }
    return;
  }
  const uuid = str(d.uuid);
  if (!uuid || typeof d.type !== "string" || !NODE_TYPES.has(d.type)) return;
  t.nodes.push({ uuid, parentUuid: str(d.parentUuid) ?? null, kind: d.type, opener: isOpener(d), offset });
  if (d.type !== "user") return;
  if (isRewindMessage(d)) {
    t.messages.set(uuid, { uuid, text: promptText(rec(d.message)?.content), timestamp: str(d.timestamp) ?? null });
    return;
  }
  const edit = editOf(d.toolUseResult);
  if (edit) t.edits.push({ uuid, offset, ...edit });
}

export function emptyTranscript(): RewindTranscript {
  return { nodes: [], messages: new Map(), snapshots: new Set(), edits: [] };
}

/** Reads the whole transcript in chunks, yielding to the event loop between them (578 MB: about 1 s). */
export async function readRewindTranscript(file: string): Promise<RewindTranscript> {
  const t = emptyTranscript();
  const fh = await fs.open(file, "r");
  try {
    const CHUNK = 4 * 1024 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    let carry: Buffer[] = [];
    let lineStart = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (bytesRead <= 0) break;
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(10, start);
        if (nl < 0 || nl >= bytesRead) {
          carry.push(Buffer.from(buf.subarray(start, bytesRead)));
          break;
        }
        const part = buf.subarray(start, nl);
        const line = carry.length ? Buffer.concat([...carry, part]) : part;
        carry = [];
        let value: unknown = null;
        try {
          value = JSON.parse(line.toString("utf8"));
        } catch {
          // A broken line (one in progress at the end) is no node.
        }
        addLine(t, lineStart, value);
        lineStart = pos + nl + 1;
        start = nl + 1;
      }
      pos += bytesRead;
      await new Promise<void>((r) => setImmediate(r));
    }
  } finally {
    await fh.close();
  }
  return t;
}

/**
 * The marker still waits for the next message: its last line is in the transcript and no run
 * opener was written after it. A message sent after the rewind (on the kept line or anywhere
 * else, also from the terminal) ends it; so does a transcript that lost its last line.
 */
export function markerActive(t: RewindTranscript, marker: RewindMarker | null): boolean {
  if (!marker) return false;
  for (let i = t.nodes.length - 1; i >= 0; i--) {
    const n = t.nodes[i]!;
    if (n.uuid === marker.lastUuid) return true;
    if (n.opener) return false;
  }
  return false;
}

/**
 * Reads lines newest first (pages of the transcript's tail) until `stop` answers; the pages are a
 * page size, not a cap: they go on to the file's start.
 */
export async function scanBackwards(file: string, stop: (value: Record<string, unknown>) => boolean | null): Promise<boolean | null> {
  let before: number | undefined;
  for (;;) {
    const page = await readTail(file, { maxRecords: 500, ...(before === undefined ? {} : { beforeOffset: before }) });
    for (let i = page.records.length - 1; i >= 0; i--) {
      const v = page.records[i]!.value;
      const d = rec(v);
      if (!d) continue;
      const answer = stop(d);
      if (answer !== null) return answer;
    }
    if (!page.hasMoreBefore) return null;
    before = page.startOffset;
  }
}

/** The newest line with a uuid (a node), or null for a transcript without one. */
export async function newestNodeUuid(file: string): Promise<string | null> {
  let found: string | null = null;
  await scanBackwards(file, (d) => {
    const uuid = str(d.uuid);
    if (uuid && typeof d.type === "string" && NODE_TYPES.has(d.type)) {
      found = uuid;
      return true;
    }
    return null;
  });
  return found;
}

/** markerActive on the file, reading from its end only as far as the marker's last line. */
export async function markerActiveIn(file: string, marker: RewindMarker): Promise<boolean> {
  const answer = await scanBackwards(file, (d) => {
    if (str(d.uuid) === marker.lastUuid) return true;
    if (str(d.uuid) && typeof d.type === "string" && NODE_TYPES.has(d.type) && isOpener(d)) return false;
    return null;
  });
  return answer === true;
}

/**
 * The newest line of the current conversation. With an active marker it is the kept line. Else
 * the newest line under the newest run opener (the main lane's P*, claude/projection/lanes.ts),
 * or the newest line when there is no opener.
 */
export function rewindLeaf(t: RewindTranscript, marker: RewindMarker | null): string | null {
  if (marker && markerActive(t, marker)) return marker.keepUuid;
  let pstar = -1;
  for (let i = t.nodes.length - 1; i >= 0; i--) {
    if (t.nodes[i]!.opener) {
      pstar = i;
      break;
    }
  }
  if (pstar < 0) return t.nodes.at(-1)?.uuid ?? null;
  const under = new Set([t.nodes[pstar]!.uuid]);
  let leaf = t.nodes[pstar]!.uuid;
  for (let i = pstar + 1; i < t.nodes.length; i++) {
    const n = t.nodes[i]!;
    if (n.parentUuid !== null && under.has(n.parentUuid)) {
      under.add(n.uuid);
      leaf = n.uuid;
    }
  }
  return leaf;
}

/** uuids from the root to `leaf`, cycle-guarded. */
export function chainTo(t: RewindTranscript, leaf: string | null): string[] {
  if (leaf === null) return [];
  const parent = new Map(t.nodes.map((n) => [n.uuid, n.parentUuid]));
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = leaf;
  while (cur !== null && parent.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = parent.get(cur) ?? null;
  }
  return out.reverse();
}

function sumEdits(edits: ScanEdit[]): { files: string[]; insertions: number; deletions: number } {
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const e of edits) {
    if (!files.includes(e.file)) files.push(e.file);
    insertions += e.insertions;
    deletions += e.deletions;
  }
  return { files, insertions, deletions };
}

/** The messages of the current conversation that the rewind screen lists, oldest first. */
export function rewindTargets(t: RewindTranscript, marker: RewindMarker | null): RewindTargetFacts[] {
  const chain = chainTo(t, rewindLeaf(t, marker));
  const onChain = new Set(chain);
  const nodeOf = new Map(t.nodes.map((n) => [n.uuid, n]));
  const picked = chain.flatMap((uuid) => {
    const m = t.messages.get(uuid);
    const n = nodeOf.get(uuid);
    return m && n ? [{ m, n }] : [];
  });
  const chainEdits = t.edits.filter((e) => onChain.has(e.uuid));
  const kept = keptCheckpoints(t);
  return picked.map(({ m, n }, i) => {
    const next = picked[i + 1]?.n.offset ?? Number.POSITIVE_INFINITY;
    return {
      uuid: m.uuid,
      parentUuid: n.parentUuid,
      offset: n.offset,
      text: m.text,
      timestamp: m.timestamp,
      checkpoint: kept.has(m.uuid),
      turnChanges: sumEdits(chainEdits.filter((e) => e.offset > n.offset && e.offset < next)),
      // Every edit written after the message, also on lines a conversation rewind left: a code
      // restore puts each tracked file back whole, so it undoes those too unless an earlier
      // restore already did (the exact count is the dry run the rewind itself makes).
      restore: sumEdits(t.edits.filter((e) => e.offset > n.offset)),
    };
  });
}

/** Line types the SDK's forkSession finds by uuid (measured with a haiku throwaway: user, assistant, attachment). */
const FORK_CUT_KINDS = new Set(["user", "assistant", "attachment"]);

/**
 * Where a fork of the current conversation ends when it keeps the message `uuid` and what followed
 * it (the reply, the tools, up to the next message): the last line of that stretch, as the
 * `upToMessageId` of the SDK's forkSession (inclusive). `last` says the message is the
 * conversation's newest, so its stretch is still being written while a turn runs. Null when the
 * message is not on the current conversation. With a waiting rewind the conversation ends at its
 * kept line (rewindLeaf), so a fork never takes what the rewind went back over.
 */
export function forkCut(t: RewindTranscript, marker: RewindMarker | null, uuid: string): { cut: string; last: boolean } | null {
  const chain = chainTo(t, rewindLeaf(t, marker));
  const messages = chain.filter((u) => t.messages.has(u));
  const i = messages.indexOf(uuid);
  if (i < 0) return null;
  const next = messages[i + 1];
  const from = chain.indexOf(uuid);
  const end = next === undefined ? chain.length : chain.indexOf(next);
  const kind = new Map(t.nodes.map((n) => [n.uuid, n.kind]));
  for (let j = end - 1; j > from; j--) {
    if (FORK_CUT_KINDS.has(kind.get(chain[j]!) ?? "")) return { cut: chain[j]!, last: next === undefined };
  }
  return { cut: uuid, last: next === undefined };
}
