// Session management (DESIGN.md 6, 6a): deletion and the trash, orphans, subagent and workflow
// units, account moves, rehome, resume commands. A session in the user's list (the sidebar,
// archive included) is locked against deletion: the lock is derived from the list, not a value
// of its own. Ported from the dashboard this
// client replaces (`set_session_lock`, `delete_sessions`, `list_trash`, `restore_trash`,
// `purge_trash`, `_claude_orphan_sessions`, `_codex_orphan_sessions`, `session_units`,
// `claude_all_units`, `delete_session_unit`, `migrate_session`, `migrate_codex_session`,
// `rehome_session`, `_resume_command`, `fs_complete`), with these changes:
// - A session counts as open while a live process registered it (pid and its start time) or a run
//   of this server holds it, as for rename. The registration's status value does not decide.
// - The trash threshold measures the whole session: transcript plus every subtree, or a Codex
//   thread plus its subagent threads.
// - A Codex thread leaves its home through the daemon's thread/delete, which takes its subagent
//   threads along (measured), so deletion, the trash and moves all work on that family. The trash
//   keeps the rows and rollouts; it does not mark the thread archived.
// - A Codex move writes only the columns both homes' `threads` tables have.
//
// Claude steps check the holder and move files with no await in between (fsUtil.ts), so a resume
// by this server cannot start in the gap. The index learns of each change before the answer:
// Claude through ClaudeSource.reread, Codex through the daemon's notifications or
// CodexSource.refreshThreads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AllUnits, DeleteOrphanResult, DeleteSessionResult, DeleteUnitResult, FolderCompletion, MoveSessionResult, OrphanList,
  OrphanSession, ProviderId, PurgeTrashResult, RehomeSessionResult, RestoreTrashResult, ResumeCommand, SessionUnits,
  TrashList, UnitRow,
} from "@maru/shared";
import { TRASH_THRESHOLD_BYTES, assignmentKey, sessionKey } from "@maru/shared";
import type { ClaudeAccount, CodexAccount } from "../config.ts";
import type { SessionIndex } from "../index/store.ts";
import type { ChosenStore } from "../state/chosen.ts";
import { isRegistrationLive } from "../claude/registry.ts";
import type { Registration } from "../claude/registry.ts";
import { subagentParent } from "../codex/source.ts";
import type { CodexRpc } from "../codex/rpc.ts";
import {
  AGENT_UNIT, SESSION_ID, WORKFLOW_UNIT, claudeHolder, copyWithCwd, cwdToEnc, deadRegistrations, findTranscript,
  fileHistoryDirs, holderMessage, isMetadataStub, readRegistrations, scanProjects, sessionEnvDirs, sessionUnits, subtreeDirs,
  transcriptRootCwd, unitPaths,
} from "./claudeFiles.ts";
import type { HolderDeps } from "./claudeFiles.ts";
import {
  CodexStepError, appendSessionIndex, codexOpenJsonl, daemonFor, deleteRows, familyOpenProblem, insertFamilyRows,
  orphanRollouts, presentIds, readFamily, relativeToHome, removeFamily, stateDbPath,
} from "./codexFiles.ts";
import type { FamilyThread, ThreadFamily } from "./codexFiles.ts";
import { errorMessage, isInside, linkOrCopy, lstatOrNull, moveSync, treeStats } from "./fsUtil.ts";
import { completeFolder, expandHome, friendlyPath, resumeCommand } from "./resume.ts";
import { TrashError } from "./trash.ts";
import type { TrashStore } from "./trash.ts";

/** A refused or failed request. `status` is the HTTP status, `message` the text the UI shows. */
export class ManageError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ManageError";
    this.status = status;
  }
}

export interface ManageDeps extends HolderDeps {
  codexAccounts: CodexAccount[];
  index: Pick<SessionIndex, "get">;
  /** The user's list (the sidebar, archive included): a session in it is locked against deletion (DESIGN.md 6, 잠금). */
  chosen: Pick<ChosenStore, "has">;
  trash: TrashStore;
  /** Paths of the .jsonl files codex processes have open. Default: codexOpenJsonl (lsof). */
  codexOpenFiles?: () => Promise<Set<string>>;
  /** A transcript appeared at or left `file`: re-read it now (ClaudeSource.reread). */
  claudeWritten?: (accountId: string, file: string) => Promise<void> | void;
  /** These threads' rows changed in the account's state database (CodexSource.refreshThreads). */
  codexWritten?: (accountId: string, ids: string[]) => void;
  /**
   * These sessions (`provider:id`) left a place for good: deleted without the trash, purged from
   * it, or an orphan removed. Their state rows go if they are nowhere else (sessions/presence.ts).
   */
  removed?: (keys: string[]) => void;
  /** Where a metadata-only transcript goes before a move or rehome takes its place. */
  stubDir: string;
  /** Home directory, for messages and `~` paths. Default os.homedir(). */
  home?: string;
  /** Path shown in resume commands. Default: through a ~/projects symlink when one maps to it. */
  display?: (p: string) => string;
}

type Body = Record<string, unknown>;

export class SessionManager {
  private deps: ManageDeps;
  private home: string;

  constructor(deps: ManageDeps) {
    this.deps = deps;
    this.home = deps.home ?? os.homedir();
  }

  // ---- delete ----

  async deleteSession(body: unknown): Promise<DeleteSessionResult> {
    const b = obj(body);
    const provider = providerOf(b.provider);
    const id = idOf(b.id);
    if (provider === "claude") {
      const account = this.claudeAccount(b.account);
      this.refuseLocked(provider, id);
      return this.deleteClaude(account, id);
    }
    const account = this.codexAccount(b.account);
    this.refuseLocked(provider, id);
    return this.deleteCodex(account, id);
  }

  private async deleteClaude(account: ClaudeAccount, id: string): Promise<DeleteSessionResult> {
    const transcript = findTranscript(account.dir, id);
    if (transcript === null) throw new ManageError(404, `Could not find this session's transcript in account ${account.id}`);
    this.refuseClaudeHeld(id, "delete it");
    const accounts = this.deps.claudeAccounts;
    const subtrees = subtreeDirs(accounts, id);
    const sizeBytes = treeStats(transcript).bytes + subtrees.reduce((n, s) => n + treeStats(s.dir).bytes, 0);
    const registrations = deadRegistrations(accounts, id);
    const sessionEnv = sessionEnvDirs(accounts, id);
    const fileHistory = fileHistoryDirs(accounts, id);
    let trashKey: string | null = null;
    if (sizeBytes > TRASH_THRESHOLD_BYTES) {
      trashKey = asManage(() => this.deps.trash.putClaude({
        account, id, name: this.nameOf("claude", account.id, id), sizeBytes, transcript, subtrees, registrations, sessionEnv, fileHistory,
      }));
    } else {
      try {
        fs.unlinkSync(transcript);
        for (const s of subtrees) fs.rmSync(s.dir, { recursive: true, force: true });
        for (const r of registrations) fs.rmSync(r.file, { force: true });
        for (const s of sessionEnv) fs.rmSync(s.dir, { recursive: true, force: true });
        for (const s of fileHistory) fs.rmSync(s.dir, { recursive: true, force: true });
      } catch (err) {
        await this.deps.claudeWritten?.(account.id, transcript);
        throw new ManageError(500, `Delete failed: ${errorMessage(err)}`);
      }
    }
    await this.deps.claudeWritten?.(account.id, transcript);
    if (trashKey === null) this.deps.removed?.([assignmentKey("claude", id)]);
    return { ok: true, outcome: trashKey === null ? "deleted" : "trashed", sizeBytes, trashKey, ids: [id] };
  }

  private async deleteCodex(account: CodexAccount, id: string): Promise<DeleteSessionResult> {
    const family = readFamily(account.home, id);
    if (family === null) throw new ManageError(404, `Could not find this thread in ${account.id}`);
    this.refuseCodexOpenInIndex(account, family);
    const ids = family.threads.map((t) => t.id);
    const sizeBytes = family.threads.reduce((n, t) => n + (t.rolloutPath === null ? 0 : treeStats(t.rolloutPath).bytes), 0);
    let trashKey: string | null = null;
    await this.withDaemon(account.home, async (rpc) => {
      await this.refuseCodexOpen(family, rpc);
      if (sizeBytes <= TRASH_THRESHOLD_BYTES) {
        await codexStep(() => removeFamily(account.home, family, rpc));
        return;
      }
      const root = family.threads[0]!.row;
      const name = textOf(root.name) ?? textOf(root.title);
      const kept = asManage(() => this.deps.trash.keepCodex({ account, id, name, sizeBytes, family }));
      try {
        await removeFamily(account.home, family, rpc);
      } catch (err) {
        // Nothing removed yet: the entry goes. Some threads gone: the entry keeps their data.
        if (untouched(account.home, family)) kept.discard();
        else trashKey = kept.key;
        throw toManage(err, trashKey === null ? "" : ` (the thread already deleted is in the trash as ${kept.key})`);
      }
      trashKey = kept.key;
    });
    this.deps.codexWritten?.(account.id, ids);
    if (trashKey === null) this.deps.removed?.(ids.map((x) => assignmentKey("codex", x)));
    return { ok: true, outcome: trashKey === null ? "deleted" : "trashed", sizeBytes, trashKey, ids };
  }

  // ---- trash ----

  listTrash(): TrashList {
    return this.deps.trash.list();
  }

  async restoreTrash(body: unknown): Promise<RestoreTrashResult> {
    const key = obj(body).key;
    const r = asManage(() => this.deps.trash.restore(key as string));
    if (r.provider === "claude") await this.deps.claudeWritten?.(r.account, r.transcript);
    else this.deps.codexWritten?.(r.account, r.ids);
    return { ok: true, key: key as string, provider: r.provider, account: r.account, id: r.id, ids: r.provider === "codex" ? r.ids : [r.id] };
  }

  purgeTrash(body: unknown): PurgeTrashResult {
    const key = obj(body).key;
    const r = asManage(() => this.deps.trash.purge(key as string));
    this.deps.removed?.([assignmentKey(r.provider, r.id)]);
    return { ok: true, key: key as string, freedBytes: r.freedBytes };
  }

  // ---- orphans ----

  listOrphans(): OrphanList {
    const sessions: OrphanSession[] = [];
    const skipped: OrphanList["skipped"] = [];
    const scan = scanProjects(this.deps.claudeAccounts);
    const open = this.openClaudeIds();
    for (const [id, dirs] of scan.dirs) {
      if (scan.transcripts.has(id)) continue;
      const sorted = [...dirs].sort((a, b) => a.dir.localeCompare(b.dir));
      let files = 0;
      let bytes = 0;
      let mtime = 0;
      for (const d of sorted) {
        const s = treeStats(d.dir);
        files += s.files;
        bytes += s.bytes;
        mtime = Math.max(mtime, s.mtimeMs);
      }
      sessions.push({
        provider: "claude", account: sorted[0]!.account.id, id, paths: sorted.map((d) => d.dir), files, sizeBytes: bytes,
        updatedAt: Math.floor(mtime), locked: this.deps.chosen.has("claude", id), open: open.has(id),
      });
    }
    for (const a of this.deps.codexAccounts) {
      let found: Map<string, string[]> | null;
      try {
        found = orphanRollouts(a.home);
      } catch (err) {
        skipped.push({ account: a.id, reason: `Could not read the state DB: ${errorMessage(err)}` });
        continue;
      }
      if (found === null) {
        skipped.push({ account: a.id, reason: "State DB not found (every rollout would look orphaned, so the scan is skipped)" });
        continue;
      }
      for (const [id, files] of found) {
        let bytes = 0;
        let mtime = 0;
        for (const f of files) {
          const s = treeStats(f);
          bytes += s.bytes;
          mtime = Math.max(mtime, s.mtimeMs);
        }
        sessions.push({
          provider: "codex", account: a.id, id, paths: [...files].sort(), files: files.length, sizeBytes: bytes,
          updatedAt: Math.floor(mtime), locked: this.deps.chosen.has("codex", id), open: false,
        });
      }
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return { sessions, skipped };
  }

  async deleteOrphan(body: unknown): Promise<DeleteOrphanResult> {
    const b = obj(body);
    const provider = providerOf(b.provider);
    const id = idOf(b.id);
    if (provider === "claude") {
      this.claudeAccount(b.account);
      this.refuseLocked(provider, id);
      for (const a of this.deps.claudeAccounts) {
        if (findTranscript(a.dir, id) !== null) throw new ManageError(409, `Account ${a.id} has a transcript for this session, so it is not an orphan`);
      }
      this.refuseClaudeHeld(id, "delete it");
      const dirs = subtreeDirs(this.deps.claudeAccounts, id);
      if (dirs.length === 0) throw new ManageError(404, "Could not find this session's subtree");
      let freedBytes = 0;
      for (const d of dirs) {
        freedBytes += treeStats(d.dir).bytes;
        fs.rmSync(d.dir, { recursive: true, force: true });
      }
      this.deps.removed?.([assignmentKey("claude", id)]);
      return { ok: true, removed: dirs.length, freedBytes };
    }
    const account = this.codexAccount(b.account);
    this.refuseLocked(provider, id);
    const files = orphanRollouts(account.home)?.get(id) ?? [];
    if (files.length === 0) throw new ManageError(404, `Account ${account.id} has no orphaned rollout for this thread`);
    const open = await this.codexOpenFiles();
    if (files.some((f) => open.has(f))) throw new ManageError(409, "A running codex process has this rollout open");
    const root = path.join(account.home, "sessions");
    let freedBytes = 0;
    let removed = 0;
    for (const f of files) {
      if (!isInside(root, f)) continue;
      freedBytes += treeStats(f).bytes;
      fs.unlinkSync(f);
      removed++;
    }
    this.deps.removed?.([assignmentKey("codex", id)]);
    return { ok: true, removed, freedBytes };
  }

  // ---- units ----

  sessionUnits(q: URLSearchParams): SessionUnits {
    if (q.get("provider") !== "claude") throw new ManageError(400, "Sub-units exist only for Claude sessions");
    const account = this.claudeAccount(q.get("account"));
    const id = idOf(q.get("id"));
    const subtrees = subtreeDirs(this.deps.claudeAccounts, id);
    if (subtrees.length === 0 && findTranscript(account.dir, id) === null) throw new ManageError(404, "Could not find this session");
    return {
      account: account.id, id, open: claudeHolder(this.deps, id) !== null, locked: this.deps.chosen.has("claude", id),
      ...sessionUnits(subtrees),
    };
  }

  allUnits(): AllUnits {
    const scan = scanProjects(this.deps.claudeAccounts);
    const open = this.openClaudeIds();
    const rows: UnitRow[] = [];
    for (const [id, dirs] of scan.dirs) {
      const units = sessionUnits(dirs).units;
      if (units.length === 0) continue;
      const sorted = [...dirs].sort((a, b) => a.dir.localeCompare(b.dir));
      const owner = this.deps.claudeAccounts.find((a) => this.deps.index.get(sessionKey("claude", a.id, id)) !== undefined);
      const account = owner?.id ?? sorted[0]!.account.id;
      for (const u of units) {
        rows.push({
          ...u, account, id, name: this.nameOf("claude", account, id), enc: sorted[0]!.enc, open: open.has(id),
          locked: this.deps.chosen.has("claude", id),
        });
      }
    }
    rows.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return { units: rows };
  }

  deleteUnit(body: unknown): DeleteUnitResult {
    const b = obj(body);
    if (b.provider !== "claude") throw new ManageError(400, "Sub-units exist only for Claude sessions");
    this.claudeAccount(b.account);
    const id = idOf(b.id);
    const unitId = typeof b.unitId === "string" ? b.unitId : "";
    if (b.kind === "subagent") {
      if (!AGENT_UNIT.test(unitId)) throw new ManageError(400, "Not a valid subagent id");
    } else if (b.kind === "workflow") {
      if (!WORKFLOW_UNIT.test(unitId)) throw new ManageError(400, "Not a valid workflow id");
    } else {
      throw new ManageError(400, "kind must be subagent or workflow");
    }
    // The lock (the session is in the list) guards the whole session; its leftover units stay prunable. An open session's do not.
    this.refuseClaudeHeld(id, "delete it");
    const paths = unitPaths(subtreeDirs(this.deps.claudeAccounts, id), b.kind, unitId);
    if (paths.length === 0) throw new ManageError(404, "Could not find this unit");
    let freedBytes = 0;
    for (const p of paths) {
      freedBytes += treeStats(p).bytes;
      fs.rmSync(p, { recursive: true, force: true });
    }
    return { ok: true, removed: paths.length, freedBytes };
  }

  // ---- move between accounts ----

  async move(body: unknown): Promise<MoveSessionResult> {
    const b = obj(body);
    const provider = providerOf(b.provider);
    const id = idOf(b.id);
    if (provider === "claude") {
      const from = this.claudeAccount(b.from);
      const to = this.claudeAccount(b.to);
      if (from.id === to.id) throw new ManageError(400, "The source and destination accounts are the same");
      return this.moveClaude(from, to, id);
    }
    const from = this.codexAccount(b.from);
    const to = this.codexAccount(b.to);
    if (from.id === to.id) throw new ManageError(400, "The source and destination accounts are the same");
    return this.moveCodex(from, to, id);
  }

  private async moveClaude(from: ClaudeAccount, to: ClaudeAccount, id: string): Promise<MoveSessionResult> {
    const src = findTranscript(from.dir, id);
    if (src === null) throw new ManageError(404, `Could not find this session's transcript in account ${from.id}`);
    this.refuseClaudeHeld(id, "move it");
    const enc = path.basename(path.dirname(src));
    const dst = path.join(to.dir, "projects", enc, `${id}.jsonl`);
    const other = findTranscript(to.dir, id);
    if (other !== null && other !== dst) throw new ManageError(409, `Account ${to.id} has the same session in another project folder: ${other}`);
    const cwd = this.deps.index.get(sessionKey("claude", from.id, id))?.cwd ?? transcriptRootCwd(src);
    const replacedStub = this.clearStub(dst, to.id, id, `Account ${to.id} already has a transcript for the same session`);
    moveSync(src, dst);
    // The subtree next to the transcript goes along; subtrees under other project dirs or
    // accounts stay where they are (a session's subtree is found in every account).
    const subtreesLeft: string[] = [];
    for (const s of subtreeDirs([from], id)) {
      const target = path.join(to.dir, "projects", s.enc, id);
      if (s.enc !== enc || lstatOrNull(target) !== null) {
        subtreesLeft.push(s.dir);
        continue;
      }
      try {
        moveSync(s.dir, target);
      } catch {
        subtreesLeft.push(s.dir);
      }
    }
    await this.deps.claudeWritten?.(from.id, src);
    await this.deps.claudeWritten?.(to.id, dst);
    return {
      ok: true, provider: "claude", id, from: from.id, to: to.id, cwd,
      resumeCommand: this.resume(cwd, "CLAUDE_CONFIG_DIR", to.dir, ["claude", "--resume", id]),
      replacedStub, ids: [id], subtreesLeft,
    };
  }

  private async moveCodex(from: CodexAccount, to: CodexAccount, id: string): Promise<MoveSessionResult> {
    if (!fs.existsSync(stateDbPath(to.home))) throw new ManageError(409, `${to.id} has no Codex state DB`);
    const family = readFamily(from.home, id);
    if (family === null) throw new ManageError(404, `Could not find this thread in ${from.id}`);
    const root = family.threads[0]!;
    if (subagentParent(textOf(root.row.source)) !== null) {
      throw new ManageError(409, "A subagent thread moves with its parent thread. Move the parent session");
    }
    this.refuseCodexOpenInIndex(from, family);
    const ids = family.threads.map((t) => t.id);
    const taken = presentIds(to.home, ids);
    if (taken.size > 0) throw new ManageError(409, `${to.id} already has the same thread: ${[...taken].join(", ")}`);
    const targets = new Map<string, string>();
    for (const t of family.threads) {
      if (t.rolloutPath === null || lstatOrNull(t.rolloutPath) === null) throw new ManageError(409, `Rollout file not found: ${t.rolloutPath ?? t.id}`);
      const rel = relativeToHome(from.home, t.rolloutPath);
      if (rel === null) throw new ManageError(409, `The rollout is outside the ${from.id} home: ${t.rolloutPath}`);
      const target = path.join(to.home, rel);
      if (lstatOrNull(target) !== null) throw new ManageError(409, `The destination account already has the same rollout: ${target}`);
      targets.set(t.id, target);
    }
    const targetOf = (t: FamilyThread): string => targets.get(t.id)!;
    await this.withDaemon(from.home, async (rpc) => {
      await this.refuseCodexOpen(family, rpc);
      const created: string[] = [];
      const undoFiles = () => {
        for (const f of created) fs.rmSync(f, { force: true });
      };
      try {
        for (const t of family.threads) {
          linkOrCopy(t.rolloutPath!, targetOf(t));
          created.push(targetOf(t));
        }
      } catch (err) {
        undoFiles();
        throw new ManageError(500, `Could not move the rollout: ${errorMessage(err)}`);
      }
      try {
        insertFamilyRows(to.home, family, targetOf);
      } catch (err) {
        undoFiles();
        throw new ManageError(409, `Could not write to the ${to.id} state DB: ${errorMessage(err)}`);
      }
      try {
        await removeFamily(from.home, family, rpc);
      } catch (err) {
        // Nothing left the source yet: undo the copy. Otherwise both sides keep what they hold.
        if (untouched(from.home, family)) {
          deleteRows(to.home, ids);
          undoFiles();
          throw toManage(err, "");
        }
        throw toManage(err, ` (some threads were already moved to ${to.id})`);
      }
      appendSessionIndex(to.home, family);
    });
    this.deps.codexWritten?.(from.id, ids);
    this.deps.codexWritten?.(to.id, ids);
    const cwd = textOf(root.row.cwd);
    return {
      ok: true, provider: "codex", id, from: from.id, to: to.id, cwd,
      resumeCommand: this.resume(cwd, "CODEX_HOME", to.home, ["codex", "resume", id]),
      replacedStub: null, ids, subtreesLeft: [],
    };
  }

  // ---- rehome ----

  async rehome(body: unknown): Promise<RehomeSessionResult> {
    const b = obj(body);
    if (b.provider === "codex") throw new ManageError(400, "Changing the folder is not supported for Codex sessions");
    if (b.provider !== "claude") throw new ManageError(400, "provider must be claude");
    const account = this.claudeAccount(b.account);
    const id = idOf(b.id);
    let cwd = expandHome(typeof b.cwd === "string" ? b.cwd.trim() : "", this.home);
    if (!path.isAbsolute(cwd)) throw new ManageError(400, "An absolute path or a ~ path is required (for example ~/projects/...)");
    cwd = path.resolve(cwd);
    if (!isDirectory(cwd)) throw new ManageError(400, `Folder not found: ${cwd}`);
    // A session records the folder its CLI runs in as the system resolves it (symlinks followed,
    // resume.ts), and a resume looks for the transcript under that folder's project dir. So a
    // folder given through a symlink (picked in the header's folder walker, DESIGN.md 6l) is kept
    // as its target.
    cwd = fs.realpathSync(cwd);
    const transcript = findTranscript(account.dir, id);
    if (transcript === null) throw new ManageError(404, `Could not find this session's transcript in account ${account.id}`);
    const curEnc = path.basename(path.dirname(transcript));
    const newEnc = cwdToEnc(cwd);
    if (newEnc === curEnc) throw new ManageError(400, "Already in that folder");
    this.refuseClaudeHeld(id, "change the folder");
    const oldRoot = transcriptRootCwd(transcript);
    const dstDir = path.join(account.dir, "projects", newEnc);
    const dst = path.join(dstDir, `${id}.jsonl`);
    const replacedStub = this.clearStub(dst, account.id, id, "The destination folder already has a transcript for the same session");
    fs.mkdirSync(dstDir, { recursive: true });
    let cwdRewritten = 0;
    if (oldRoot !== null && oldRoot.replace(/\/+$/, "") !== cwd) {
      // Written beside the target and renamed into place, so a failure leaves the session as it was.
      const tmp = `${dst}.rehome-${process.pid}.tmp`;
      try {
        cwdRewritten = copyWithCwd(transcript, tmp, oldRoot, cwd);
        const old = fs.statSync(transcript);
        fs.utimesSync(tmp, old.atime, old.mtime);
        fs.renameSync(tmp, dst);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw new ManageError(500, `Could not move the transcript: ${errorMessage(err)}`);
      }
      fs.unlinkSync(transcript);
    } else {
      moveSync(transcript, dst);
    }
    const subtreesLeft: string[] = [];
    const srcSub = path.join(account.dir, "projects", curEnc, id);
    if (lstatOrNull(srcSub)?.isDirectory()) {
      const target = path.join(dstDir, id);
      try {
        moveSync(srcSub, target);
      } catch {
        subtreesLeft.push(srcSub);
      }
    }
    await this.deps.claudeWritten?.(account.id, transcript);
    await this.deps.claudeWritten?.(account.id, dst);
    return {
      ok: true, account: account.id, id, cwd, cwdRewritten, replacedStub, subtreesLeft,
      resumeCommand: this.resume(cwd, "CLAUDE_CONFIG_DIR", account.dir, ["claude", "--resume", id]),
    };
  }

  // ---- resume command, folder completion ----

  resumeCommand(q: URLSearchParams): ResumeCommand {
    const provider = providerOf(q.get("provider"));
    const id = idOf(q.get("id"));
    if (provider === "claude") {
      const account = this.claudeAccount(q.get("account"));
      let cwd = this.deps.index.get(sessionKey("claude", account.id, id))?.cwd ?? null;
      if (cwd === null) {
        const transcript = findTranscript(account.dir, id);
        if (transcript === null) throw new ManageError(404, `Could not find this session's transcript in account ${account.id}`);
        cwd = transcriptRootCwd(transcript);
      }
      return { cwd, command: this.resume(cwd, "CLAUDE_CONFIG_DIR", account.dir, ["claude", "--resume", id]) };
    }
    const account = this.codexAccount(q.get("account"));
    let cwd = this.deps.index.get(sessionKey("codex", account.id, id))?.cwd ?? null;
    if (cwd === null) {
      const family = readFamily(account.home, id);
      if (family === null) throw new ManageError(404, `Could not find this thread in ${account.id}`);
      cwd = textOf(family.threads[0]!.row.cwd);
    }
    return { cwd, command: this.resume(cwd, "CODEX_HOME", account.home, ["codex", "resume", id]) };
  }

  fsComplete(q: URLSearchParams): FolderCompletion {
    return completeFolder(q.get("path") ?? "", this.home);
  }

  // ---- helpers ----

  private resume(cwd: string | null, envName: string, envValue: string, argv: string[]): string {
    return resumeCommand(cwd, envName, envValue, argv, this.deps.display ?? ((p) => friendlyPath(p)));
  }

  private claudeAccount(v: unknown): ClaudeAccount {
    const a = this.deps.claudeAccounts.find((x) => x.id === v);
    if (!a) throw new ManageError(400, `Unknown Claude account: ${String(v)}`);
    return a;
  }

  private codexAccount(v: unknown): CodexAccount {
    const a = this.deps.codexAccounts.find((x) => x.id === v);
    if (!a) throw new ManageError(400, `Unknown Codex account: ${String(v)}`);
    return a;
  }

  private refuseLocked(provider: ProviderId, id: string): void {
    if (this.deps.chosen.has(provider, id)) throw new ManageError(409, "This session is locked because it is in the sidebar list. Remove it from the list, then delete it");
  }

  private refuseClaudeHeld(id: string, then: string): void {
    const h = claudeHolder(this.deps, id);
    if (h !== null) throw new ManageError(409, holderMessage(h, then, this.home));
  }

  /** Open test for many ids at once: a live registration names the id, or a run of this server holds it. */
  private openClaudeIds(): { has: (id: string) => boolean } {
    const live = this.deps.isRegistrationLive ?? ((reg: Registration) => isRegistrationLive(reg));
    const out = new Set<string>();
    for (const r of readRegistrations(this.deps.claudeAccounts)) {
      if (r.reg.sessionId && live(r.reg)) out.add(r.reg.sessionId);
    }
    return { has: (id) => out.has(id) || (this.deps.heldByServer?.(id) ?? false) };
  }

  private refuseCodexOpenInIndex(account: CodexAccount, family: ThreadFamily): void {
    for (const t of family.threads) {
      const s = this.deps.index.get(sessionKey("codex", account.id, t.id));
      if (s === undefined || s.status === "closed") continue;
      throw new ManageError(409, t.id === family.rootId
        ? `This thread is open (${s.status}). Try again after it closes`
        : `A subagent thread of this thread (${t.id}) is open (${s.status})`);
    }
  }

  private async codexOpenFiles(): Promise<Set<string>> {
    try {
      return await (this.deps.codexOpenFiles ?? codexOpenJsonl)();
    } catch (err) {
      throw new ManageError(500, `Could not check codex processes: ${errorMessage(err)}`);
    }
  }

  private async refuseCodexOpen(family: ThreadFamily, rpc: CodexRpc | null): Promise<void> {
    const open = await this.codexOpenFiles();
    const problem = await codexStep(() => familyOpenProblem(family, rpc, open));
    if (problem !== null) throw new ManageError(409, problem);
  }

  private async withDaemon<T>(home: string, fn: (rpc: CodexRpc | null) => Promise<T>): Promise<T> {
    const rpc = await daemonFor(home);
    try {
      return await fn(rpc);
    } finally {
      await rpc?.close();
    }
  }

  /**
   * Move a metadata-only transcript at `dst` aside so a move can take its place. Anything else at
   * `dst` refuses with `taken`. Returns where the stub went.
   */
  private clearStub(dst: string, accountId: string, id: string, taken: string): string | null {
    if (lstatOrNull(dst) === null) return null;
    if (!isMetadataStub(dst)) throw new ManageError(409, taken);
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
    const target = path.join(this.deps.stubDir, `${accountId}__${id}-${ts}.jsonl`);
    moveSync(dst, target);
    return target;
  }

  private nameOf(provider: ProviderId, account: string, id: string): string | null {
    const s = this.deps.index.get(sessionKey(provider, account, id));
    return s?.name ?? s?.title ?? null;
  }
}

/** True while every thread of the family still has its row and its rollout in the home. */
function untouched(home: string, family: ThreadFamily): boolean {
  const present = presentIds(home, family.threads.map((t) => t.id));
  return family.threads.every((t) => present.has(t.id) && (t.rolloutPath === null || lstatOrNull(t.rolloutPath) !== null));
}

function obj(body: unknown): Body {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ManageError(400, "A JSON object is required");
  return body as Body;
}

function providerOf(v: unknown): ProviderId {
  if (v !== "claude" && v !== "codex") throw new ManageError(400, "provider must be claude or codex");
  return v;
}

function idOf(v: unknown): string {
  if (typeof v !== "string" || !SESSION_ID.test(v)) throw new ManageError(400, "Not a valid session ID");
  return v;
}

function textOf(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function toManage(err: unknown, suffix: string): ManageError {
  if (err instanceof ManageError) return new ManageError(err.status, err.message + suffix);
  if (err instanceof CodexStepError || err instanceof TrashError) return new ManageError(err.status, err.message + suffix);
  return new ManageError(500, errorMessage(err) + suffix);
}

function asManage<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof TrashError) throw new ManageError(err.status, err.message);
    throw err;
  }
}

async function codexStep<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CodexStepError) throw new ManageError(err.status, err.message);
    throw err;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
