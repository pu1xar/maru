// Session management contract (DESIGN.md 6, 6a): deletion and the trash, orphans,
// subagent and workflow units, account moves, rehome, resume commands. JSON bodies need
// `content-type: application/json`; every error is { error: string } with its status.
//
//   POST /api/session-delete        SessionTarget   -> DeleteSessionResult
//   GET  /api/trash                                 -> TrashList
//   POST /api/trash/restore         TrashKey        -> RestoreTrashResult
//   POST /api/trash/purge           TrashKey        -> PurgeTrashResult
//   GET  /api/orphans                               -> OrphanList
//   POST /api/orphans/delete        SessionTarget   -> DeleteOrphanResult
//   GET  /api/session-units?provider=claude&account=&id= -> SessionUnits
//   GET  /api/session-units/all                     -> AllUnits
//   POST /api/session-units/delete  DeleteUnit      -> DeleteUnitResult
//   POST /api/session-move          MoveSession     -> MoveSessionResult
//   POST /api/session-rehome        RehomeSession   -> RehomeSessionResult
//   GET  /api/session-resume-command?provider=&account=&id= -> ResumeCommand
//   GET  /api/fs-complete?path=                     -> FolderCompletion
//
// Status: 400 bad request, 404 no such session or entry, 409 refused (locked, a process holds
// the session, the target is taken), 422 an unreadable trash entry, 500 a local step failed,
// 502 the Codex daemon failed.
import type { AccountId, ProviderId } from "./index.ts";

/**
 * A deleted session larger than this goes to the trash; a smaller one is removed for good. The
 * size is the whole session: a Claude transcript with every subtree in every account, a Codex
 * thread's rollout with its subagent threads' rollouts.
 */
export const TRASH_THRESHOLD_BYTES = 1024 * 1024;

export interface SessionTarget { provider: ProviderId; account: AccountId; id: string }

export interface DeleteSessionResult {
  ok: true;
  outcome: "trashed" | "deleted";
  /** The size the threshold was measured on. */
  sizeBytes: number;
  /** The trash entry, when trashed. */
  trashKey: string | null;
  /** Sessions removed: Claude the id; Codex the thread and its subagent threads. */
  ids: string[];
}

export interface TrashItem {
  key: string;
  provider: ProviderId;
  account: AccountId;
  id: string;
  name: string | null;
  sizeBytes: number;
  /** ms since epoch */
  deletedAt: number;
  /** Codex: the thread and its subagent threads. Claude: 1. */
  threads: number;
  /** Why a restore would be refused (account not configured, data missing), or null. */
  problem: string | null;
}
export interface TrashList {
  items: TrashItem[];
  totalBytes: number;
  /** Entries whose meta.json could not be read; they are counted here, never dropped. */
  unreadable: Array<{ key: string; error: string }>;
}
export interface TrashKey { key: string }
export interface RestoreTrashResult { ok: true; key: string; provider: ProviderId; account: AccountId; id: string; ids: string[] }
export interface PurgeTrashResult { ok: true; key: string; freedBytes: number }

/**
 * Leftovers whose session is gone. Claude: subtree dirs `projects/<enc>/<id>/` with no transcript
 * for the id in any account. Codex: rollout files under `sessions/` that no thread row references
 * and whose thread id has no row.
 */
export interface OrphanSession {
  provider: ProviderId;
  /** Claude: the account of the first subtree dir. */
  account: AccountId;
  id: string;
  paths: string[];
  files: number;
  sizeBytes: number;
  /** ms since epoch */
  updatedAt: number;
  locked: boolean;
  /** Claude: a live process registered the id. */
  open: boolean;
}
export interface OrphanList {
  sessions: OrphanSession[];
  /** Homes or accounts that were not scanned, with the reason. */
  skipped: Array<{ account: AccountId; reason: string }>;
}
export interface DeleteOrphanResult { ok: true; removed: number; freedBytes: number }

export type UnitKind = "subagent" | "workflow";
export interface SessionUnit {
  kind: UnitKind;
  /** `agent-<hex>` or `wf_<hex>-<hex>` */
  unitId: string;
  sizeBytes: number;
  files: number;
  updatedAt: number;
}
/** A Claude session's subagent and workflow units across every account's subtree. */
export interface SessionUnits {
  account: AccountId;
  id: string;
  open: boolean;
  locked: boolean;
  units: SessionUnit[];
  totalBytes: number;
  unitBytes: number;
  /** Subtree bytes no unit holds (shared scripts, tool results). */
  remainderBytes: number;
}
export interface UnitRow extends SessionUnit {
  /** The session's account: where its transcript is, else the first subtree dir's account. */
  account: AccountId;
  /** The session id. */
  id: string;
  name: string | null;
  enc: string;
  open: boolean;
  locked: boolean;
}
export interface AllUnits { units: UnitRow[] }
/** Units are removed for good; a session in the list (locked) keeps no units from being removed, an open one's do. */
export interface DeleteUnit { provider: "claude"; account: AccountId; id: string; kind: UnitKind; unitId: string }
export interface DeleteUnitResult { ok: true; removed: number; freedBytes: number }

export interface MoveSession { provider: ProviderId; id: string; from: AccountId; to: AccountId }
export interface MoveSessionResult {
  ok: true;
  provider: ProviderId;
  id: string;
  from: AccountId;
  to: AccountId;
  cwd: string | null;
  resumeCommand: string;
  /** Claude: where a metadata-only transcript at the destination went first (~/.Trash/claude-migrate-stubs). */
  replacedStub: string | null;
  /** Codex: the thread and its subagent threads. Claude: the id. */
  ids: string[];
  /** Claude: subtree dirs that stayed (another project dir or account, or the destination had one). */
  subtreesLeft: string[];
}

/** Claude only: Codex keeps its cwd in the rollout and the state database, which this does not rewrite. */
export interface RehomeSession { provider: "claude"; account: AccountId; id: string; cwd: string }
export interface RehomeSessionResult {
  ok: true;
  account: AccountId;
  id: string;
  cwd: string;
  /** Top-level `cwd` fields moved from the old project root to the new folder. */
  cwdRewritten: number;
  replacedStub: string | null;
  subtreesLeft: string[];
  resumeCommand: string;
}

export interface ResumeCommand { command: string; cwd: string | null }
/** What listing a folder found: readable, absent, a file, or refused (permission and the like). */
export type FolderStatus = "ok" | "missing" | "not-folder" | "unreadable";
export interface FolderCompletion { dirs: string[]; expanded: string; parent: string; status: FolderStatus }
