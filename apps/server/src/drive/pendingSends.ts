// Messages sent to a session that the model has not taken in yet (DESIGN.md 4.4). This server is
// the one place that knows them: every tab and device gets the session's whole list
// (`session.queued`) on each change and right after hello.
//
// Where the message itself waits (measured 2026-11-16, Claude Code 2.1.325 with Agent SDK 0.3.321,
// codex-cli 0.169.0):
// - Claude: in the CLI's command queue, inside the session host's process, so a restart of this
//   server leaves it there. The CLI reports each client uuid with `command_lifecycle` messages:
//   queued when it arrives, started when the model gets it (between tool rounds of a running
//   turn, or as the next turn), completed when that turn ended, cancelled when taken back with
//   the cancel_async_message control request (Query.cancelAsyncMessage).
// - Codex: turn/steer goes into the running turn at once; the daemon records the userMessage item
//   with the clientUserMessageId 30 ms after the steer is answered. There is no way to take a steer
//   back, in the TUI or over the daemon.
//
// This module keeps its own record of what it sent (id, text, state) in the state file, since the
// CLI's transcript names a waiting message only by its text. After a restart reconcile() checks
// the transcript and the runs the host still has.
import fs from "node:fs";
import path from "node:path";
import fsp from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { deliveredIdsOfLine } from "@maru/shared";
import type { PendingSend, PendingSendState, ProviderId, UploadedAttachment } from "@maru/shared";
import { isNotFound } from "../claude/meta.ts";
import { readTail } from "../transcript/claudeTranscript.ts";

/** What this server keeps per message. */
export interface StoredSend {
  id: string;
  text: string;
  attachments: UploadedAttachment[];
  sentAt: number;
  state: PendingSendState;
  error: string | null;
}

/**
 * A change to a session's list.
 * queued    the provider holds the message (the send was handed over, the CLI said queued)
 * taken     the model got it
 * done      its turn is over, or it was taken back: the row goes
 * cancelled the CLI took it out of its queue (cancelled): the row goes, unless a Send now is
 *           replacing it (PendingSends.replacing), then it goes on under the new id
 * failed    the send failed before the model got it
 * turnEnded a Codex turn ended, or this server let the thread go: what the daemon took goes
 *           (queued, taken: a steer or turn/start it answered is in that turn's input)
 */
export type PendingEvent =
  | { kind: "queued"; id: string }
  | { kind: "taken"; id: string }
  | { kind: "done"; id: string }
  | { kind: "cancelled"; id: string }
  | { kind: "failed"; id: string; error: string }
  | { kind: "turnEnded" };

export const ENDED_BEFORE_TAKEN = "The session ended before the model received it";
export const LOST_IN_RESTART = "Sent while the web server was restarting, so delivery is unknown";
export const NOT_DELIVERED = "Not delivered to the model";

/** The session's list after one event. Pure; an event for an id not in the list changes nothing. */
export function applyPendingEvent(list: readonly StoredSend[], ev: PendingEvent): StoredSend[] {
  switch (ev.kind) {
    case "queued":
      return list.map((s) => (s.id === ev.id && (s.state === "sending" || s.state === "failed") ? { ...s, state: "queued", error: null } : s));
    case "taken":
      return list.map((s) => (s.id === ev.id && s.state !== "taken" ? { ...s, state: "taken", error: null } : s));
    case "done":
    case "cancelled":
      return list.filter((s) => s.id !== ev.id);
    case "failed":
      return list.map((s) => (s.id === ev.id && (s.state === "sending" || s.state === "queued") ? { ...s, state: "failed", error: ev.error } : s));
    case "turnEnded":
      return list.filter((s) => s.state !== "taken" && s.state !== "queued");
  }
}

/**
 * The list with message `from` under the id `to`, in the same place, as a message the provider has
 * not got yet. Send now sends a taken-back message again under a new uuid: the CLI drops a message
 * whose uuid it has seen (measured 2026-11-18), so the old uuid cannot go in again. Pure; a list
 * without `from` is unchanged.
 */
export function renameSend(list: readonly StoredSend[], from: string, to: string): StoredSend[] {
  return list.map((s): StoredSend => (s.id === from ? { ...s, id: to, state: "sending", error: null } : s));
}

export function providerOf(key: string): ProviderId | null {
  return key.startsWith("claude:") ? "claude" : key.startsWith("codex:") ? "codex" : null;
}

/** Whether the message can go back to the composer now, and why not. */
export function recallOf(provider: ProviderId | null, s: StoredSend): PendingSend["recall"] {
  switch (s.state) {
    case "failed":
      return { enabled: true, reason: null };
    case "sending":
      return { enabled: false, reason: "Still sending, cannot take back yet" };
    case "taken":
      return { enabled: false, reason: "The model already received it, cannot take back" };
    case "queued":
      return provider === "claude"
        ? { enabled: true, reason: null }
        : { enabled: false, reason: "Codex puts sent text into the running turn right away, so it cannot be taken back" };
  }
}

export function viewOf(provider: ProviderId | null, s: StoredSend): PendingSend {
  return { id: s.id, text: s.text, attachments: s.attachments, sentAt: s.sentAt, state: s.state, error: s.error, recall: recallOf(provider, s) };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * What one SDK message of a Claude run says about the messages sent to it. `command_lifecycle`
 * is not in SDK 0.3.321's SDKMessage type; the CLI sends it (capability msg_lifecycle_v1).
 */
export function claudeMessageEvents(m: unknown): PendingEvent[] {
  if (!m || typeof m !== "object") return [];
  const o = m as Record<string, unknown>;
  if (o.type === "command_lifecycle") {
    const id = str(o.command_uuid);
    if (id === null) return [];
    switch (o.state) {
      case "queued":
        return [{ kind: "queued", id }];
      case "started":
        return [{ kind: "taken", id }];
      case "completed":
        return [{ kind: "done", id }];
      case "cancelled":
        return [{ kind: "cancelled", id }];
      default:
        return [];
    }
  }
  if (o.type === "result") {
    // Every message this turn consumed, also the ones folded in between tool rounds.
    const ids = Array.isArray(o.user_message_uuids) ? o.user_message_uuids.map(str) : [str(o.user_message_uuid)];
    return ids.filter((id): id is string => id !== null).map((id) => ({ kind: "done", id }));
  }
  return [];
}

export interface PendingSendsOptions {
  /** state.sqlite (":memory:" in tests). */
  file: string;
  /** The session's list changed: send it to every UI. */
  publish: (key: string, sends: PendingSend[]) => void;
  now?: () => number;
}

export interface RecallResult {
  /** What came back, oldest first. */
  messages: Array<{ id: string; text: string; attachments: UploadedAttachment[] }>;
  /** One line per message that could not be taken back. */
  errors: string[];
}

export class PendingSends {
  private db: DatabaseSync;
  private byKey = new Map<string, StoredSend[]>();
  /** Send now replacements under way: session key and old id (joined by a NUL) to the new id (replacing). */
  private successors = new Map<string, string>();
  private publish:(key: string, sends: PendingSend[]) => void;
  private now: () => number;

  constructor(opts: PendingSendsOptions) {
    if (opts.file !== ":memory:") fs.mkdirSync(path.dirname(opts.file), { recursive: true });
    this.db = new DatabaseSync(opts.file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS pending_sends (
        session_key TEXT NOT NULL,
        id TEXT NOT NULL,
        text TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        error TEXT,
        attachments TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (session_key, id)
      );
    `);
    // The first build of this table had no attachments column.
    const columns = this.db.prepare("PRAGMA table_info(pending_sends)").all().map((c) => String(c.name));
    if (!columns.includes("attachments")) this.db.exec("ALTER TABLE pending_sends ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
    for (const row of this.db.prepare("SELECT session_key, id, text, sent_at, state, error, attachments FROM pending_sends ORDER BY rowid").all()) {
      const key = String(row.session_key);
      const list = this.byKey.get(key) ?? [];
      list.push({
        id: String(row.id), text: String(row.text), attachments: parseAttachments(row.attachments), sentAt: Number(row.sent_at),
        state: String(row.state) as PendingSendState, error: row.error === null ? null : String(row.error),
      });
      this.byKey.set(key, list);
    }
    this.publish = opts.publish;
    this.now = opts.now ?? Date.now;
  }

  close(): void {
    this.db.close();
  }

  /** A message the server got for the session, before it goes to the provider. */
  sent(key: string, id: string, text: string, attachments: UploadedAttachment[] = []): void {
    const list = this.byKey.get(key) ?? [];
    if (list.some((s) => s.id === id)) return;
    this.set(key, [...list, { id, text, attachments, sentAt: this.now(), state: "sending", error: null }]);
  }

  /**
   * Send now is about to take message `from` out of the CLI's queue and send it again as `to`.
   * Called before the take-out, since the CLI's `cancelled` message can reach apply() ahead of the
   * take-out's answer: apply() then renames the row instead of removing it, so the row never
   * leaves the list and no UI sees it vanish and come back.
   */
  replacing(key: string, from: string, to: string): void {
    this.successors.set(`${key}\0${from}`, to);
  }

  /** The take-out did not happen (the model has the message already, or the call failed): `from` stays as it is. */
  kept(key: string, from: string): void {
    this.successors.delete(`${key}\0${from}`);
  }

  /**
   * The CLI let go of `from`: the row is `to` from now on, a message the provider is being handed
   * (state sending). No effect when the `cancelled` message renamed it already, or the row is gone.
   */
  replaced(key: string, from: string, to: string): void {
    this.successors.delete(`${key}\0${from}`);
    const before = this.byKey.get(key);
    if (!before?.some((s) => s.id === from)) return;
    this.set(key, renameSend(before, from, to));
  }

  apply(key: string, ev: PendingEvent): void {
    const before = this.byKey.get(key);
    if (ev.kind === "cancelled") {
      const successor = `${key}\0${ev.id}`;
      const to = this.successors.get(successor);
      if (to !== undefined) {
        this.successors.delete(successor);
        if (before?.some((s) => s.id === ev.id)) this.set(key, renameSend(before, ev.id, to));
        return;
      }
    }
    if (!before?.length) return;
    const after = applyPendingEvent(before, ev);
    if (after.length === before.length && after.every((s, i) => s === before[i])) return;
    this.set(key, after);
  }

  /** The session's list as the UI shows it. */
  list(key: string): PendingSend[] {
    const provider = providerOf(key);
    return (this.byKey.get(key) ?? []).map((s) => viewOf(provider, s));
  }

  /** Every session with messages waiting, for a UI that just connected. */
  all(): Array<{ key: string; sends: PendingSend[] }> {
    return [...this.byKey.keys()].map((key) => ({ key, sends: this.list(key) }));
  }

  /** What this server keeps for the session (reconcile, tests). */
  stored(key: string): readonly StoredSend[] {
    return this.byKey.get(key) ?? [];
  }

  keys(): string[] {
    return [...this.byKey.keys()];
  }

  /**
   * Takes messages back, oldest first. A failed one comes back as it is; a Claude message the CLI
   * still queues is cancelled there first (`cancel` answers whether the CLI took it out). The texts
   * that came back go to the composer of the UI that asked.
   */
  async recall(key: string, ids: readonly string[], cancel: (id: string) => Promise<boolean>): Promise<RecallResult> {
    const provider = providerOf(key);
    const wanted = new Set(ids);
    const out: RecallResult = { messages: [], errors: [] };
    for (const id of ids) {
      if (!this.stored(key).some((s) => s.id === id)) out.errors.push("Already received by the model, or not found");
    }
    for (const id of this.stored(key).filter((x) => wanted.has(x.id)).map((x) => x.id)) {
      // The state as it is now: a lifecycle message or another recall may have moved it meanwhile.
      const s = this.find(key, id);
      if (!s) {
        out.errors.push("Already taken back elsewhere, or received by the model");
        continue;
      }
      const can = recallOf(provider, s);
      if (!can.enabled) {
        out.errors.push(`${clip(s.text)}: ${can.reason}`);
        continue;
      }
      if (s.state === "queued") {
        let cancelled: boolean;
        try {
          cancelled = await cancel(s.id);
        } catch (err) {
          out.errors.push(`${clip(s.text)}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (!cancelled) {
          const now = this.find(key, id);
          out.errors.push(`${clip(s.text)}: ${
            !now ? "Already taken back elsewhere, or received by the model"
              : now.state === "taken" ? "The model received it in the meantime, so it could not be taken back"
                : "It has not reached the CLI yet, so it could not be taken back. Try again shortly"}`);
          continue;
        }
      } else if (provider === "claude") {
        // A failed message the CLI may hold after all (a restart, a host that came back): take it out
        // there too, so it does not also run. No run answers with an error, which is fine here.
        await cancel(s.id).catch(() => false);
        if (this.find(key, id)?.state === "taken") {
          out.errors.push(`${clip(s.text)}: the model received it in the meantime, so it could not be taken back`);
          continue;
        }
      }
      this.apply(key, { kind: "done", id });
      out.messages.push({ id, text: s.text, attachments: s.attachments });
    }
    return out;
  }

  private find(key: string, id: string): StoredSend | undefined {
    return this.byKey.get(key)?.find((s) => s.id === id);
  }

  private set(key: string, list: StoredSend[]): void {
    const before = new Map((this.byKey.get(key) ?? []).map((s) => [s.id, s]));
    if (list.length) this.byKey.set(key, list);
    else this.byKey.delete(key);
    const kept = new Set(list.map((s) => s.id));
    const del = this.db.prepare("DELETE FROM pending_sends WHERE session_key = ? AND id = ?");
    for (const id of before.keys()) if (!kept.has(id)) del.run(key, id);
    const upsert = this.db.prepare(`
      INSERT INTO pending_sends (session_key, id, text, sent_at, state, error, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_key, id) DO UPDATE SET state = excluded.state, error = excluded.error
    `);
    for (const s of list) if (before.get(s.id) !== s) upsert.run(key, s.id, s.text, s.sentAt, s.state, s.error, JSON.stringify(s.attachments));
    this.publish(key, this.list(key));
  }
}

function parseAttachments(v: unknown): UploadedAttachment[] {
  try {
    const parsed: unknown = JSON.parse(String(v ?? "[]"));
    return Array.isArray(parsed) ? (parsed as UploadedAttachment[]) : [];
  } catch {
    return [];
  }
}

function clip(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  if (!line) return "Attachment-only message";
  return line.length > 30 ? `${line.slice(0, 30)}…` : line;
}


/**
 * For each wanted id a transcript read found: the byte offset of the oldest line that names it
 * (see deliveredIdsOfLine). An id the read did not find is absent.
 */
export type SendsInTranscript = ReadonlyMap<string, number>;

/**
 * Reads a session's transcript for these ids, or null when it could not be read through (an
 * unread part may hold them, so a caller leaves its messages as they are). `sinceMs` is the oldest
 * send among them (scanPages stops there).
 */
export type TranscriptReader = (key: string, ids: ReadonlySet<string>, sinceMs: number) => Promise<SendsInTranscript | null>;

/** The offset up to which a thread's rows have gone out to its subscribers, per session: Infinity when no thread holds the session. */
export type SettleLimit = (key: string) => number;
const NO_LIMIT: SettleLimit = () => Infinity;

/**
 * A Claude run ended: what it held is settled by its transcript. The CLI drops its queue as it
 * exits, but a 닫기 interrupts first, and a queued message then opens the next turn and is written
 * as its prompt before the process goes (measured 2026-11-16): the conversation shows it, so it
 * went in. A message still on its way here (a send right after 닫기 waits for the next run) stays.
 * The transcript is read once for all the queued ids. A line beyond `settleLimit` (its row is not
 * out yet) leaves the message to the thread's delivery hook, so the row reaches the UI first.
 */
export async function settleEndedRun(store: PendingSends, key: string, read: TranscriptReader, settleLimit: SettleLimit = NO_LIMIT): Promise<void> {
  const list = [...store.stored(key)];
  const queued = list.filter((s) => s.state === "queued");
  const found = queued.length === 0 ? new Map<string, number>() : await read(key, new Set(queued.map((s) => s.id)), Math.min(...queued.map((s) => s.sentAt)));
  const limit = settleLimit(key);
  for (const s of list) {
    if (s.state !== "queued" && s.state !== "taken") continue;
    if (store.stored(key).find((x) => x.id === s.id) !== s) continue;
    if (s.state === "taken") {
      store.apply(key, { kind: "done", id: s.id });
      continue;
    }
    if (found === null) continue;
    const at = found.get(s.id);
    if (at === undefined) store.apply(key, { kind: "failed", id: s.id, error: ENDED_BEFORE_TAKEN });
    else if (at < limit) store.apply(key, { kind: "done", id: s.id });
  }
}

/**
 * The conversation shows these ids (a user row's `clientId` or `mergedClientIds`): the messages
 * they name are in it for good, so the rows go from the list. Settling by the id and not by what a
 * client window holds is what lets a message whose row scrolled far up the transcript (a turn of
 * hours) leave the list. A row with the id is proof the provider has the message in every state: a
 * failed one went in after all, and a sending one was taken before this server heard the provider's
 * answer (a Codex row can reach the thread's connection ahead of the steer's reply); the lifecycle
 * events that follow name an id no longer listed and change nothing.
 */
export function settleDelivered(store: PendingSends, key: string, ids: ReadonlySet<string>): void {
  if (ids.size === 0) return;
  for (const s of [...store.stored(key)]) {
    if (ids.has(s.id)) store.apply(key, { kind: "done", id: s.id });
  }
}

export { deliveredIdsOfLine };

const SCAN_PAGE = 2000;
/** A line older than the oldest wanted send by more than this cannot be its row (sentAt and line time come from one clock). */
const SCAN_SLACK_MS = 10 * 60_000;

export interface TranscriptScan {
  found: Map<string, number>;
  /** Where the newest complete line ended when the read began (0 when even the first page failed). */
  end: number;
  /** False when a page failed to read: lines before the last page read may name more of the ids. */
  complete: boolean;
}

/**
 * Which of `wanted` the transcript shows as delivered, read from its end backwards. The file is
 * append-only, so a send's row is after the time it was sent: the read stops at the first page
 * whose oldest line is older than `sinceMs` minus a slack, at `stopAt` (an offset an earlier read
 * already covered), or at the file's start. `end` is where the newest complete line ends. A page
 * that fails to read ends the scan with `complete` false and a log line.
 */
async function scanPages(
  file: string, wanted: ReadonlySet<string>, sinceMs: number, stopAt: number, readPage: typeof readTail = readTail,
): Promise<TranscriptScan> {
  const found = new Map<string, number>();
  let end = 0;
  if (wanted.size === 0) return { found, end, complete: true };
  let before: number | undefined;
  try {
    for (;;) {
      const page = await readPage(file, { maxRecords: SCAN_PAGE, ...(before !== undefined ? { beforeOffset: before } : {}) });
      if (before === undefined) end = page.endOffset;
      for (const r of page.records) {
        for (const id of deliveredIdsOfLine(r.value)) {
          if (!wanted.has(id)) continue;
          const seen = found.get(id);
          if (seen === undefined || r.offset < seen) found.set(id, r.offset);
        }
      }
      if (found.size === wanted.size || !page.hasMoreBefore || page.startOffset <= stopAt) break;
      const oldest = page.records.map((r) => lineTime(r.value)).find((t) => t !== null) ?? null;
      if (oldest !== null && oldest < sinceMs - SCAN_SLACK_MS) break;
      before = page.startOffset;
    }
  } catch (err) {
    console.error(`pending sends: transcript read failed, not remembered as read (${file})`, err);
    return { found, end, complete: false };
  }
  return { found, end, complete: true };
}

export async function scanDelivered(file: string, wanted: ReadonlySet<string>, sinceMs: number): Promise<Set<string>> {
  return new Set((await scanPages(file, wanted, sinceMs, 0)).found.keys());
}

/**
 * A TranscriptReader over a transcript file. No file (or a file that is gone) shows none of the
 * ids; a file that cannot be read through answers null.
 */
export async function readSendsInTranscript(file: string | null, ids: ReadonlySet<string>, sinceMs: number): Promise<SendsInTranscript | null> {
  if (file === null || ids.size === 0) return new Map();
  try {
    await fsp.stat(file);
  } catch (err) {
    if (isNotFound(err)) return new Map();
    console.error(`pending sends: transcript not readable (${file})`, err);
    return null;
  }
  const scan = await scanPages(file, ids, sinceMs, 0);
  return scan.complete ? scan.found : null;
}

function lineTime(value: unknown): number | null {
  const t = value && typeof value === "object" ? (value as Record<string, unknown>).timestamp : undefined;
  const ms = typeof t === "string" ? Date.parse(t) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Per session: the transcript, the offset below which an earlier read decided every line (found
 * ids settled, the rest absent), and the ids it looked for.
 */
const scanned = new Map<string, { file: string; covered: number; ids: ReadonlySet<string> }>();

export interface SettleFromTranscriptOptions {
  /** Where the session's thread has sent rows to its subscribers (default: no thread, no limit). */
  limit?: SettleLimit;
  /** The page reader (tests make it fail). */
  readPage?: typeof readTail;
}

/**
 * Settles the session's waiting messages by what its transcript shows (scanDelivered). Only the
 * queued and taken ones: a message still waiting is by definition not in the transcript yet, so
 * each read would go back to its send. A session already read for the same ids reads only what
 * was written since, and nothing when the file has not grown (a subscribe on every open and tab
 * would otherwise read hours of a long turn again). A failed message that went in after all is
 * settled by reconcilePending (start, host reconnect).
 *
 * Which lines may settle: a thread that holds the session has the rows of its lines go out to its
 * subscribers a debounce after they are written (DESIGN.md 4.4), so this read can see a line the
 * thread has not sent yet. Such a line (offset at or beyond `limit`) is left to the thread's
 * delivery hook, which settles right after the row went out. With no thread open nobody shows the
 * session's rows, and the line settles at once.
 *
 * Only a read that went through is remembered: a page that failed to read leaves the memo as it
 * was, and the next call reads those lines again.
 */
export async function settleFromTranscript(store: PendingSends, key: string, file: string | null, opts: SettleFromTranscriptOptions = {}): Promise<void> {
  if (!file) return;
  const open = store.stored(key).filter((s) => s.state === "queued" || s.state === "taken");
  if (open.length === 0) {
    scanned.delete(key);
    return;
  }
  const ids = new Set(open.map((s) => s.id));
  const memo = scanned.get(key);
  const known = memo !== undefined && memo.file === file && [...ids].every((id) => memo.ids.has(id));
  let stopAt = known ? memo.covered : 0;
  let size: number;
  try {
    size = (await fsp.stat(file)).size;
  } catch {
    return;
  }
  if (known && size === memo.covered) return;
  // A file that shrank was rewritten: read it again from the end.
  if (size < stopAt) stopAt = 0;
  const { found, end, complete } = await scanPages(file, ids, Math.min(...open.map((s) => s.sentAt)), stopAt, opts.readPage);
  // The limit as it is after the read: it only grows while rows go out, and a reload sets it back.
  const limit = (opts.limit ?? NO_LIMIT)(key);
  const settleable = new Set<string>();
  for (const [id, at] of found) if (at < limit) settleable.add(id);
  if (complete) scanned.set(key, { file, covered: Math.min(Math.max(end, stopAt), limit), ids });
  settleDelivered(store, key, settleable);
}

export interface ReconcileDeps {
  /** The run this server holds for a Claude session after the restart, or null. */
  claudeRun: (key: string) => { busy: boolean } | null;
  /** The session's transcript, read once for all the ids of its messages. */
  claudeTranscript: TranscriptReader;
  /** Where the session's thread has sent rows (see settleFromTranscript); default no limit. */
  settleLimit?: SettleLimit;
}

/**
 * What happened to the kept lists while this server could not follow them: after it started
 * (Codex and Claude), and for Claude again each time the session host connection comes back.
 * - Claude: a message the transcript names (deliveredIdsOfLine) reached the model. One it does
 *   not name still waits in the CLI if the host runs that session with a turn going; an idle CLI
 *   holds no queue, and a run that is gone dropped its queue with the process. The CLI's own
 *   `queue-operation` lines carry a send id only on `remove` (reason absorbed_mid_turn), and that
 *   line always has its `queued_command` attachment beside it, so they say nothing more.
 * - Codex: a steer or turn/start the daemon answered cannot be lost; one whose answer this server
 *   did not see may not have arrived.
 * A failed Claude message the transcript names went in after all. A message that moved on while
 * the transcript was read is left as it is, and so is every message of a session whose transcript
 * could not be read through. The transcript is read once per session, however many messages wait.
 * A line at or beyond `settleLimit` (its row has not gone out) does not remove a message: the
 * thread's delivery hook does, after the row; a busy run's message still turns "taken".
 */
export async function reconcilePending(store: PendingSends, deps: ReconcileDeps, providers: readonly ProviderId[] = ["claude", "codex"]): Promise<void> {
  for (const key of store.keys()) {
    const provider = providerOf(key);
    if (provider === null || !providers.includes(provider)) continue;
    const list = [...store.stored(key)];
    if (provider === "codex") {
      for (const s of list) {
        if (s.state !== "failed") store.apply(key, s.state === "sending" ? { kind: "failed", id: s.id, error: LOST_IN_RESTART } : { kind: "done", id: s.id });
      }
      continue;
    }
    if (list.length === 0) continue;
    const found = await deps.claudeTranscript(key, new Set(list.map((s) => s.id)), Math.min(...list.map((s) => s.sentAt)));
    if (found === null) continue;
    const limit = (deps.settleLimit ?? NO_LIMIT)(key);
    for (const s of list) {
      if (store.stored(key).find((x) => x.id === s.id) !== s) continue;
      const at = found.get(s.id);
      const seen = at !== undefined;
      const out = seen && at < limit;
      const run = deps.claudeRun(key);
      if (s.state === "failed") {
        // The conversation has it after all (it went in while this server could not see it).
        if (out) store.apply(key, { kind: "done", id: s.id });
      } else if (seen) {
        if (run?.busy) store.apply(key, { kind: "taken", id: s.id });
        else if (out) store.apply(key, { kind: "done", id: s.id });
      } else if (!run) {
        store.apply(key, s.state === "taken" ? { kind: "done", id: s.id } : { kind: "failed", id: s.id, error: ENDED_BEFORE_TAKEN });
      } else if (!run.busy) {
        store.apply(key, s.state === "taken" ? { kind: "done", id: s.id } : { kind: "failed", id: s.id, error: NOT_DELIVERED });
      } else if (s.state === "sending") {
        // The CLI may still have it; its lifecycle messages move it on from here.
        store.apply(key, { kind: "failed", id: s.id, error: LOST_IN_RESTART });
      }
    }
  }
}
