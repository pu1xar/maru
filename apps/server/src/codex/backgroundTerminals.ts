// The background terminals of a Codex thread, for the right panel's "작업" tab (DESIGN.md 6i).
//
// What the daemon gives (codex-cli 0.169.0, measured 2026-11-16):
// - `thread/backgroundTerminals/list` (experimental: only a connection that declared
//   `experimentalApi` gets an answer) lists the terminals running now: itemId, processId, command,
//   cwd. No start time, no output; one that ended is gone from the list. It answers for any loaded
//   thread, also from a connection that never subscribed to it, and says "thread not found" for a
//   thread the daemon has unloaded (its terminals died with it).
// - `thread/backgroundTerminals/terminate {threadId, processId}` ends one terminal ({terminated}).
//   A processId that is gone answers terminated false.
// - The terminal's `commandExecution` item (id = the list's itemId) is not among the thread's items
//   while it runs. It appears when the process ends: status "completed" with its exitCode, or
//   status "failed" with exitCode -1 for a process the daemon killed (terminate, or the thread
//   unloading), with durationMs, startedAtMs, completedAtMs and, when it printed something,
//   aggregatedOutput (null for a killed one).
//
// So a row is built from what this server saw: each terminal the list showed is remembered, and
// when it leaves the list its item is looked up (`thread/items/list`, newest first) for how it
// ended. A terminal this server never saw running is not shown, and the memory is gone with a
// restart of this server.
//
// The connection is its own (one per account, opened at the first read): declaring `experimentalApi`
// changes what the daemon sends that connection (DESIGN.md 3.2), and this one subscribes to nothing,
// so no other part of the server is touched.
import type { SessionAgentView, SessionTaskOutput } from "@maru/shared";
import type { CodexAccount } from "../config.ts";
import { CodexRpc, RpcError, controlSocketExists, controlSocketPath } from "./rpc.ts";
import type { ClientMethod, ParamsOf, ResultOf } from "./rpc.ts";
import { OUTPUT_TAIL_BYTES, plainOutput } from "../claude/sessionBackgroundTasks.ts";

/** The part of CodexRpc this reads with (a test gives its own). */
export interface TerminalRpc {
  request<M extends ClientMethod>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;
  close(): Promise<void>;
}

export interface BackgroundTerminalsDeps {
  accounts: readonly CodexAccount[];
  /** Opens a connection that declared experimentalApi; null when the daemon cannot be reached. */
  open?: (account: CodexAccount) => Promise<TerminalRpc | null>;
  now?: () => number;
}

/** How a terminal ended, from its item (`itemEnd`) or, with no item, from its absence. */
export interface TerminalEnd {
  status: Extract<SessionAgentView["status"], "completed" | "failed" | "cancelled" | "interrupted">;
  exitCode: number | null;
  /** ms, null when the item says none. */
  startedAt: number | null;
  completedAt: number;
  /** The end of the output (OUTPUT_TAIL_BYTES), null when the item holds none. */
  output: { text: string; totalBytes: number; truncated: boolean } | null;
}

interface Seen {
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  /** ms: when this server first saw it running. */
  firstSeen: number;
  /** ms: the last read that listed it. */
  lastRunning: number;
  end: TerminalEnd | null;
}

interface ItemEntry {
  startedAtMs?: number | null;
  completedAtMs?: number | null;
  item?: { type?: string; id?: string; status?: string; exitCode?: number | null; durationMs?: number | null; aggregatedOutput?: string | null };
}

interface ItemsPage {
  data: ItemEntry[];
  nextCursor?: string | null;
}

/** How long a terminal that left the list with no item found is looked up again, ms. */
const SETTLE_MS = 10_000;

const KEY_RE = /^codex:([^:]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** How a commandExecution item says its terminal ended. The exit code -1 is a process the daemon killed. */
export function endOfItem(entry: ItemEntry, now: number): TerminalEnd | null {
  const item = entry.item;
  if (!item || item.type !== "commandExecution") return null;
  const completedAt = entry.completedAtMs ?? now;
  const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
  const status: TerminalEnd["status"] =
    item.status === "completed" ? "completed" : item.status === "failed" && exitCode === -1 ? "cancelled" : "failed";
  let output: TerminalEnd["output"] = null;
  if (typeof item.aggregatedOutput === "string" && item.aggregatedOutput) {
    const bytes = Buffer.from(item.aggregatedOutput, "utf8");
    const from = Math.max(0, bytes.length - OUTPUT_TAIL_BYTES);
    let tail = bytes.subarray(from);
    let skip = 0;
    // The cut may fall inside a multibyte character: skip its continuation bytes.
    while (from > 0 && skip < tail.length && skip < 4 && (tail[skip]! & 0xc0) === 0x80) skip++;
    tail = tail.subarray(skip);
    output = { text: plainOutput(tail.toString("utf8")), totalBytes: bytes.length, truncated: from > 0 };
  }
  const startedAt = typeof item.durationMs === "number" && entry.completedAtMs != null ? entry.completedAtMs - item.durationMs : (entry.startedAtMs ?? null);
  return { status, exitCode, startedAt, completedAt, output };
}

/** The rows a thread's remembered terminals make (no actions yet: SessionAgentControl adds them). */
export function terminalRows(seen: readonly Seen[]): SessionAgentView[] {
  return seen.map((s) => {
    const first = s.command.split("\n", 1)[0] ?? "";
    return {
      id: s.itemId,
      kind: "shell",
      title: first || "Command",
      status: s.end ? s.end.status : "running",
      agentType: null,
      model: null,
      parentAgentId: null,
      childThreadId: null,
      startedAt: s.end?.startedAt != null ? new Date(s.end.startedAt).toISOString() : null,
      updatedAt: new Date(s.end?.completedAt ?? s.firstSeen).toISOString(),
      completedAt: s.end ? new Date(s.end.completedAt).toISOString() : null,
      command: s.command,
      cwd: s.cwd,
      // -1 is the daemon's own kill, not a code the command returned.
      ...(s.end ? { exitCode: s.end.status === "cancelled" ? null : s.end.exitCode } : {}),
      ...(s.end?.status === "interrupted" ? { endSummary: "Could not find the end of this terminal in the daemon's records" } : {}),
    } satisfies SessionAgentView;
  });
}

export class CodexBackgroundTerminals {
  private readonly deps: BackgroundTerminalsDeps;
  private readonly conns = new Map<string, Promise<TerminalRpc | null>>();
  private readonly seen = new Map<string, Map<string, Seen>>();
  /** Reads in flight per key, so the list and the count asked together make one request. */
  private readonly reading = new Map<string, Promise<void>>();

  constructor(deps: BackgroundTerminalsDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The rows of a Codex session key: terminals running now and those this server saw end. */
  async rows(key: string): Promise<SessionAgentView[]> {
    await this.refresh(key);
    return terminalRows([...(this.seen.get(key)?.values() ?? [])]);
  }

  /** The end of an ended terminal's output; null for one that is running or printed nothing. */
  output(key: string, itemId: string): SessionTaskOutput | null {
    const o = this.seen.get(key)?.get(itemId)?.end?.output;
    return o ? { output: o.text, totalBytes: o.totalBytes, truncated: o.truncated } : null;
  }

  /** Whether the terminal of this row is one this server saw (a stop names it by its item id). */
  knows(key: string, itemId: string): boolean {
    return this.seen.get(key)?.has(itemId) ?? false;
  }

  /** Ends one running terminal. Resolves false when it already ended. */
  async terminate(key: string, itemId: string): Promise<boolean> {
    const s = this.seen.get(key)?.get(itemId);
    const m = KEY_RE.exec(key);
    if (!s || !m) return false;
    const rpc = await this.conn(m[1]!);
    if (!rpc) throw new Error("Could not connect to the Codex daemon");
    const res = await rpc.request("thread/backgroundTerminals/terminate", { threadId: m[2]!, processId: s.processId });
    return res.terminated;
  }

  async close(): Promise<void> {
    const conns = [...this.conns.values()];
    this.conns.clear();
    for (const c of conns) await (await c)?.close().catch(() => {});
  }

  private refresh(key: string): Promise<void> {
    let p = this.reading.get(key);
    if (!p) {
      p = this.read(key).finally(() => this.reading.delete(key));
      this.reading.set(key, p);
    }
    return p;
  }

  private conn(accountId: string): Promise<TerminalRpc | null> {
    let c = this.conns.get(accountId);
    if (!c) {
      const account = this.deps.accounts.find((a) => a.id === accountId);
      c = account ? (this.deps.open ?? openExperimental)(account) : Promise.resolve(null);
      this.conns.set(accountId, c);
      // A daemon that could not be reached is tried again at the next read.
      void c.then((rpc) => {
        if (rpc === null && this.conns.get(accountId) === c) this.conns.delete(accountId);
      }, () => {
        if (this.conns.get(accountId) === c) this.conns.delete(accountId);
      });
    }
    return c;
  }

  private async read(key: string): Promise<void> {
    const m = KEY_RE.exec(key);
    if (!m) return;
    const rpc = await this.conn(m[1]!);
    if (!rpc) return;
    const threadId = m[2]!;
    let running: Awaited<ResultOf<"thread/backgroundTerminals/list">>["data"] = [];
    try {
      let cursor: string | null = null;
      do {
        const page: ResultOf<"thread/backgroundTerminals/list"> = await rpc.request("thread/backgroundTerminals/list", { threadId, ...(cursor ? { cursor } : {}) });
        running = running.concat(page.data);
        cursor = page.nextCursor;
      } while (cursor);
    } catch (err) {
      // An unloaded thread has no terminals; its terminal's end is still looked up below.
      if (!(err instanceof RpcError && /thread not found/i.test(err.message))) throw err;
      running = [];
    }
    const mine = this.seen.get(key) ?? new Map<string, Seen>();
    this.seen.set(key, mine);
    const now = this.now();
    const live = new Set<string>();
    for (const t of running) {
      live.add(t.itemId);
      const prev = mine.get(t.itemId);
      mine.set(t.itemId, prev
        ? { ...prev, processId: t.processId, lastRunning: now, end: null }
        : { itemId: t.itemId, processId: t.processId, command: t.command, cwd: t.cwd, firstSeen: now, lastRunning: now, end: null });
    }
    // A terminal's item can reach the thread's items a moment after the terminal left the list, so
    // one marked "interrupted" is looked up again for SETTLE_MS.
    const gone = [...mine.values()].filter((s) => !live.has(s.itemId) && (s.end === null || (s.end.status === "interrupted" && now - s.lastRunning < SETTLE_MS)));
    if (gone.length) await this.resolve(rpc, threadId, gone, mine, now);
  }

  /**
   * How the terminals that left the list ended: their items, newest first, until each is found.
   * An item completes after the terminal was first seen, so the walk stops at the first page whose
   * items all completed before the earliest first sighting; a terminal not found by then ended
   * without a record ("interrupted").
   */
  private async resolve(rpc: TerminalRpc, threadId: string, gone: Seen[], mine: Map<string, Seen>, now: number): Promise<void> {
    const wanted = new Map(gone.map((s) => [s.itemId, s]));
    const earliest = Math.min(...gone.map((s) => s.firstSeen));
    let cursor: string | null = null;
    for (;;) {
      const page = (await rpc.request("thread/items/list", {
        threadId, sortDirection: "desc", limit: 50, ...(cursor ? { cursor } : {}),
      })) as ItemsPage;
      let older = page.data.length > 0;
      for (const e of page.data) {
        const id = e.item?.id;
        const s = id ? wanted.get(id) : undefined;
        if (s) {
          const end = endOfItem(e, now);
          if (end) {
            mine.set(s.itemId, { ...s, end });
            wanted.delete(s.itemId);
          }
        }
        if (e.completedAtMs == null || e.completedAtMs >= earliest) older = false;
      }
      cursor = page.nextCursor ?? null;
      if (wanted.size === 0 || !cursor || older) break;
    }
    for (const s of wanted.values()) {
      mine.set(s.itemId, { ...s, end: { status: "interrupted", exitCode: null, startedAt: null, completedAt: now, output: null } });
    }
  }
}

async function openExperimental(account: CodexAccount): Promise<TerminalRpc | null> {
  if (!controlSocketExists(controlSocketPath(account.home))) return null;
  const rpc = new CodexRpc(account.home, {
    clientInfo: { name: "maru", title: null, version: "0.0.0" },
    experimentalApi: true,
  });
  if (await rpc.start()) return rpc;
  await rpc.close();
  return null;
}
