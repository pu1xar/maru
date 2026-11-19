// Session rename (DESIGN.md 6, 이름 변경). The name the user types is kept in maru's own state
// (state/sessionNames.ts) and is what every screen shows, so a rename never waits for or fails on
// a provider. It is also written to the provider's own store, where its terminal tools read it,
// when that is safe:
// - Claude: two lines appended to the transcript. custom-title is what the `claude --resume`
//   list shows (the last one, over any ai-title); agent-name is what a reopened TUI and its
//   sessions json show (the last one). Both carry the same value so the surfaces agree. Only a
//   closed session is written: an open process keeps its name in memory and can write it back
//   over ours. For an open one only maru's row is written (stored "maru").
// - Codex: the daemon's thread/name/set, which writes threads.name, appends to
//   session_index.jsonl and announces thread/name/updated to every client. Without a daemon, or
//   for a thread the daemon cannot find and has not loaded (archived: its rollout moved to
//   archived_sessions/), the same two records are written directly, unless a codex process has
//   the rollout open (then only maru's row is written).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RenameSession, RenameSessionResult } from "@maru/shared";
import { sessionKey } from "@maru/shared";
import type { ClaudeAccount, CodexAccount } from "../config.ts";
import type { SessionIndex } from "../index/store.ts";
import type { SessionNameStore } from "../state/sessionNames.ts";
import type { Registration } from "../claude/registry.ts";
import { RpcError, connect, controlSocketExists, controlSocketPath } from "../codex/rpc.ts";
import type { CodexRpc } from "../codex/rpc.ts";
import { STATE_DB_FILE, subagentParent } from "../codex/source.ts";
import { SESSION_ID, claudeHolder, findTranscript } from "./claudeFiles.ts";
import { DB_BUSY_WAIT_MS, SESSION_INDEX_FILE, codexOpenJsonl } from "./codexFiles.ts";
import { appendLines } from "./fsUtil.ts";

export { SESSION_INDEX_FILE, codexOpenJsonl };

/** A refused or failed rename. `status` is the HTTP status, `message` the text the UI shows. */
export class RenameError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RenameError";
    this.status = status;
  }
}

/** Shown with a rename that only maru stored. */
export const MARU_ONLY_NOTICE = "Saved in maru only. The name in the CLI list stays the same";

export interface RenameDeps {
  /** maru's own names (the name every screen shows). */
  names: Pick<SessionNameStore, "set">;
  claudeAccounts: ClaudeAccount[];
  codexAccounts: CodexAccount[];
  /** The session index. A Codex subagent thread is known by its parentKey. */
  index: Pick<SessionIndex, "get">;
  /** True while a run of this server holds the Claude session (ClaudeDriver.holds). */
  heldByServer?: (sessionId: string) => boolean;
  /** pids of the Claude processes this server started, so a refusal names the right holder. */
  ownPids?: () => Set<number>;
  /** Default: isRegistrationLive (pid alive and still the process that wrote the file). */
  isRegistrationLive?: (reg: Registration) => boolean;
  /** Paths of the .jsonl files codex processes have open. Default: codexOpenJsonl (lsof). */
  codexOpenFiles?: () => Promise<Set<string>>;
  /** After a transcript append, so the index takes the new name now. */
  claudeWritten?: (accountId: string, file: string) => Promise<void> | void;
  /** After a direct state database write. */
  codexWritten?: (accountId: string) => void;
}

export class SessionRenamer {
  private deps: RenameDeps;

  constructor(deps: RenameDeps) {
    this.deps = deps;
  }

  /** `req` is the request body as received; every field is checked here. */
  async rename(req: RenameSession): Promise<RenameSessionResult> {
    const r = (req ?? {}) as Partial<Record<keyof RenameSession, unknown>>;
    if (r.provider !== "claude" && r.provider !== "codex") {
      throw new RenameError(400, "provider must be claude or codex");
    }
    if (typeof r.id !== "string" || !SESSION_ID.test(r.id)) throw new RenameError(400, "Not a valid session ID");
    if (typeof r.name !== "string") throw new RenameError(400, "name is required");
    const name = r.name.trim();
    if (name === "") throw new RenameError(400, "The name is empty");
    const accountId = typeof r.account === "string" ? r.account : "";
    if (r.provider === "claude") {
      const account = this.deps.claudeAccounts.find((a) => a.id === accountId);
      if (!account) throw new RenameError(400, `Unknown Claude account: ${accountId}`);
      return this.renameClaude(account, r.id, name);
    }
    const account = this.deps.codexAccounts.find((a) => a.id === accountId);
    if (!account) throw new RenameError(400, `Unknown Codex account: ${accountId}`);
    return this.renameCodex(account, r.id, name);
  }

  // ---- Claude ----

  private async renameClaude(account: ClaudeAccount, id: string, name: string): Promise<RenameSessionResult> {
    const file = findTranscript(account.dir, id);
    if (file === null) throw new RenameError(404, `Could not find this session's transcript in account ${account.id}`);
    // The holder check and the append run without an await in between. The driver checks and
    // claims a session the same way, so a resume from this server cannot start between them.
    const open = claudeHolder(this.deps, id) !== null;
    const before = this.providerNameOf(sessionKey("claude", account.id, id));
    if (open) {
      this.deps.names.set("claude", id, name, [before]);
      return { ok: true, name, stored: "maru", notice: MARU_ONLY_NOTICE };
    }
    appendLines(file, [
      { type: "custom-title", customTitle: name, sessionId: id },
      { type: "agent-name", agentName: name, sessionId: id },
    ]);
    // The index reads the new name before the row exists, so the row never sees a name it does not expect.
    await this.deps.claudeWritten?.(account.id, file);
    this.deps.names.set("claude", id, name, [name]);
    return { ok: true, name, stored: "transcript" };
  }

  /** The provider's own user name the index last saw (the one maru's name is laid over). */
  private providerNameOf(key: string): string | null {
    return this.deps.index.get(key)?.providerName ?? null;
  }

  // ---- Codex ----

  private async renameCodex(account: CodexAccount, id: string, name: string): Promise<RenameSessionResult> {
    const row = readThreadRow(account.home, id);
    const indexed = this.deps.index.get(sessionKey("codex", account.id, id));
    if (indexed?.parentKey || (row !== null && subagentParent(row.source) !== null)) {
      throw new RenameError(409, "Cannot rename a subagent thread. Rename the parent session");
    }
    const before = this.providerNameOf(sessionKey("codex", account.id, id));
    const maruOnly = (): RenameSessionResult => {
      this.deps.names.set("codex", id, name, [before]);
      return { ok: true, name, stored: "maru", notice: MARU_ONLY_NOTICE };
    };
    // The daemon's own notification reaches the index a moment after this call, so a row written
    // next to a provider write accepts the old and the new provider name.
    let daemon: boolean;
    try {
      daemon = await daemonSetName(account.home, id, name);
    } catch (err) {
      if (!(err instanceof RenameError)) throw err;
      return maruOnly(); // the daemon holds the thread and refused, or did not answer
    }
    if (daemon) {
      this.deps.names.set("codex", id, name, [before, name]);
      return { ok: true, name, stored: "daemon" };
    }
    if (row === null) throw new RenameError(404, `Could not find this thread in account ${account.id}`);
    let open: Set<string>;
    try {
      open = await (this.deps.codexOpenFiles ?? codexOpenJsonl)();
    } catch {
      return maruOnly(); // could not tell whether a process has the rollout open
    }
    if (row.rolloutPath !== null && open.has(row.rolloutPath)) return maruOnly();
    writeNameDirect(account.home, id, name);
    this.deps.codexWritten?.(account.id);
    this.deps.names.set("codex", id, name, [before, name]);
    return { ok: true, name, stored: "direct" };
  }
}

interface ThreadRow {
  rolloutPath: string | null;
  source: string | null;
}

/** The thread's row in the state database, read-only. null when the database or the row is missing. */
function readThreadRow(home: string, id: string): ThreadRow | null {
  const file = path.join(home, STATE_DB_FILE);
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT rollout_path, source FROM threads WHERE id = ?").get(id);
    if (!row) return null;
    return {
      rolloutPath: typeof row.rollout_path === "string" && row.rollout_path !== "" ? row.rollout_path : null,
      source: typeof row.source === "string" ? row.source : null,
    };
  } finally {
    db.close();
  }
}

/**
 * thread/name/set on the home's daemon. true: the daemon renamed the thread. false: no daemon
 * answers for this home, or the daemon cannot find the thread and has not loaded it, so the
 * direct write may go ahead. A daemon that holds the thread and refuses is not bypassed.
 */
async function daemonSetName(home: string, id: string, name: string): Promise<boolean> {
  if (!controlSocketExists(controlSocketPath(home))) return false;
  let rpc: CodexRpc;
  try {
    rpc = await connect(home);
  } catch {
    return false; // a socket file left behind with no daemon on it
  }
  try {
    await rpc.request("thread/name/set", { threadId: id, name });
    return true;
  } catch (err) {
    if (!(err instanceof RpcError)) throw new RenameError(502, `Codex daemon communication failed: ${errorMessage(err)}`);
    let loaded: boolean;
    try {
      loaded = await isLoaded(rpc, id);
    } catch (listErr) {
      throw new RenameError(502, `Codex daemon communication failed: ${errorMessage(listErr)}`);
    }
    if (loaded) throw new RenameError(502, `Codex daemon refused the rename: ${err.message}`);
    return false;
  } finally {
    await rpc.close();
  }
}

async function isLoaded(rpc: CodexRpc, id: string): Promise<boolean> {
  let cursor: string | null = null;
  do {
    const page: { data: string[]; nextCursor: string | null } = await rpc.request("thread/loaded/list", { cursor });
    if (page.data.includes(id)) return true;
    cursor = page.nextCursor;
  } while (cursor);
  return false;
}

/** The two records thread/name/set writes: threads.name and a session_index.jsonl line. */
function writeNameDirect(home: string, id: string, name: string): void {
  const db = new DatabaseSync(path.join(home, STATE_DB_FILE), { timeout: DB_BUSY_WAIT_MS });
  try {
    const r = db.prepare("UPDATE threads SET name = ? WHERE id = ?").run(name, id);
    if (Number(r.changes) === 0) throw new RenameError(404, "Could not find this thread");
  } finally {
    db.close();
  }
  appendLines(path.join(home, SESSION_INDEX_FILE), [{ id, thread_name: name, updated_at: new Date().toISOString() }]);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
