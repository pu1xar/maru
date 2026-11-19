// Project and session-list calls over HTTP (contract in packages/shared). Writes to listed
// sessions resolve to nothing on purpose: the server pushes the result over /ws (useSessions.ts),
// and that is what the UI shows. The reads (candidates, trash, units, orphans, accounts) serve the
// dialogs and the settings screen, which read again after their own writes.
import type {
  AccountInfo, AllUnits, ArchiveSession, AssignSession, ChooseSession, CreateProject, DeleteOrphanResult, DeleteSessionResult, DeleteUnit,
  DeleteUnitResult, FolderCompletion, ImportGroupFolds, SetGroupFolded, ListSessionsResponse, MoveSession, MoveSessionResult, OrphanList, PinSession, PinSessions, PlaceSessions, PurgeTrashResult, RehomeSession,
  RehomeSessionResult, RenameSession, RenameSessionResult, RestoreTrashResult, ResumeCommand, ResumeSessionWorkflow, ResumeSessionWorkflowResult,
  SessionCandidates, SessionSummary, SessionTarget, SessionUnits, StopSessionAgent, TrashList, UpdateProject,
  SessionRewindList, SessionRewindPreview, SessionRewindRequest, SessionRewindResult, SessionForkRequest, SessionForkResult,
} from "@maru/shared";

/** A failed call. `message` is the server's `{ error }` text when it sent one. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function call(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<void> {
  await request(method, path, body);
}

async function request(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(path, {
    method,
    headers:
      body === undefined
        ? { accept: "application/json" }
        : { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (type.includes("application/json")) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, `Could not parse JSON (HTTP ${res.status})`);
    }
    if (res.ok) return data;
    const error = typeof data === "object" && data !== null && "error" in data ? data.error : null;
    throw new ApiError(res.status, typeof error === "string" ? error : `HTTP ${res.status}`);
  }
  // The guard answers 403 in plain text. Anything else that is not JSON (a login page after the
  // gateway session expired, a proxy error page) is reported by status, not by its markup.
  if (type.startsWith("text/plain") && text.trim()) throw new ApiError(res.status, text.trim());
  throw new ApiError(res.status, `Not a JSON response (HTTP ${res.status}, ${type || "no content-type"})`);
}

export function createProject(body: CreateProject): Promise<void> {
  return call("POST", "/api/projects", body);
}

export function updateProject(id: string, body: UpdateProject): Promise<void> {
  return call("PATCH", `/api/projects/${encodeURIComponent(id)}`, body);
}

/** The server moves the project's sessions back to 미분류. */
export function deleteProject(id: string): Promise<void> {
  return call("DELETE", `/api/projects/${encodeURIComponent(id)}`);
}

/** `ids` must list every project exactly once, in the new order. */
export function reorderProjects(ids: string[]): Promise<void> {
  return call("POST", "/api/projects/order", { ids });
}

export function assignSession(body: AssignSession): Promise<void> {
  return call("PUT", "/api/session-project", body);
}

/** Puts sessions into a project in this order, top first; the list follows over /ws. */
export function placeSessions(body: PlaceSessions): Promise<void> {
  return call("PUT", "/api/session-order", body);
}

/** Pins a session at the bottom of 고정됨, or unpins it; its Group place stays either way. */
export function pinSession(body: PinSession): Promise<void> {
  return call("PUT", "/api/session-pin", body);
}

/** Puts sessions into 고정됨 in this order, top first. */
export function pinSessions(body: PinSessions): Promise<void> {
  return call("PUT", "/api/session-pins", body);
}

/**
 * Moves a session to 보관함 (archived: true) or takes it out. Only that changes: its Group and pin
 * stay, so it returns to them.
 */
export function archiveSession(body: ArchiveSession): Promise<void> {
  return call("PUT", "/api/session-archive", body);
}

/** Add a session to the list (chosen: true) or take it out. */
/** Folds or unfolds one sidebar folder for every client (DESIGN.md 6v); the server's `foldedGroups` message follows. */
export function setGroupFolded(body: SetGroupFolded): Promise<void> {
  return call("PUT", "/api/group-fold", body);
}

/** Hands the server this browser's older folds; it takes them only while it holds none. Answers the server's list. */
export async function importGroupFolds(body: ImportGroupFolds): Promise<string[]> {
  const data = (await request("POST", "/api/group-fold/import", body)) as { keys?: unknown };
  return Array.isArray(data.keys) ? data.keys.filter((k): k is string => typeof k === "string") : [];
}

export function chooseSession(body: ChooseSession): Promise<void> {
  return call("PUT", "/api/session-chosen", body);
}

/** Sessions not in the list, most recent first, for the "add a session" dialog. */
export async function fetchSessionCandidates(q: string, offset: number, limit: number): Promise<SessionCandidates> {
  const params = new URLSearchParams({ q, offset: String(offset), limit: String(limit) });
  return (await request("GET", `/api/session-candidates?${params}`)) as SessionCandidates;
}

/** Text for a failed call, for a toast or a dialog. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  // fetch rejects with a TypeError when the request never reaches the server.
  if (error instanceof TypeError) return "Could not connect to the server";
  return error instanceof Error ? error.message : String(error);
}

/** Stores the session's name in maru (and in the provider's own record when it can be written); the list follows over /ws. */
export async function renameSession(body: RenameSession): Promise<RenameSessionResult> {
  return (await request("PUT", "/api/session-name", body)) as RenameSessionResult;
}

// ---- Session management (DESIGN.md 6, 6a): the list follows each write over /ws ----

/** Over 1MB the session goes to the trash, otherwise it is removed for good. */
export async function deleteSession(body: SessionTarget): Promise<DeleteSessionResult> {
  return (await request("POST", "/api/session-delete", body)) as DeleteSessionResult;
}

export async function listTrash(): Promise<TrashList> {
  return (await request("GET", "/api/trash")) as TrashList;
}

export async function restoreTrash(key: string): Promise<RestoreTrashResult> {
  return (await request("POST", "/api/trash/restore", { key })) as RestoreTrashResult;
}

export async function purgeTrash(key: string): Promise<PurgeTrashResult> {
  return (await request("POST", "/api/trash/purge", { key })) as PurgeTrashResult;
}

export async function moveSession(body: MoveSession): Promise<MoveSessionResult> {
  return (await request("POST", "/api/session-move", body)) as MoveSessionResult;
}

export async function rehomeSession(body: RehomeSession): Promise<RehomeSessionResult> {
  return (await request("POST", "/api/session-rehome", body)) as RehomeSessionResult;
}

/** The subfolders of a folder on the server's machine (`dir` ends with `/`); dot folders are left out. */
export async function completeFolder(dir: string): Promise<FolderCompletion> {
  return (await request("GET", `/api/fs-complete?${new URLSearchParams({ path: dir })}`)) as FolderCompletion;
}

/** One session as the server has it now, on the list or not; null when the server knows no such key. */
export async function fetchSession(key: string): Promise<SessionSummary | null> {
  try {
    return ((await request("GET", `/api/session?${new URLSearchParams({ key })}`)) as { session: SessionSummary }).session;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** The list's sessions as the server has them now, for a reader outside the page's /ws state. */
export async function fetchListedSessions(): Promise<SessionSummary[]> {
  return ((await request("GET", "/api/sessions")) as ListSessionsResponse).sessions;
}

export async function resumeCommand(target: SessionTarget): Promise<ResumeCommand> {
  const q = new URLSearchParams({ provider: target.provider, account: target.account, id: target.id });
  return (await request("GET", `/api/session-resume-command?${q}`)) as ResumeCommand;
}

// ---- Settings screen reads (sessions outside the list, units, orphans, accounts) ----

/** Page size for reading every candidate; the loop keeps going until `total` is reached. */
const CANDIDATE_PAGE = 500;

/** Every session outside the list (DESIGN.md 6d), read page by page until the server's total. */
export async function fetchAllCandidates(): Promise<SessionSummary[]> {
  const all: SessionSummary[] = [];
  for (;;) {
    const page = await fetchSessionCandidates("", all.length, CANDIDATE_PAGE);
    all.push(...page.sessions);
    // An empty page ends the loop too, in case the total shrank between two pages.
    if (all.length >= page.total || page.sessions.length === 0) return all;
  }
}

export async function fetchAccounts(): Promise<AccountInfo[]> {
  return ((await request("GET", "/api/accounts")) as { accounts: AccountInfo[] }).accounts;
}

export async function fetchAllUnits(): Promise<AllUnits> {
  return (await request("GET", "/api/session-units/all")) as AllUnits;
}

export async function fetchSessionUnits(account: string, id: string): Promise<SessionUnits> {
  const q = new URLSearchParams({ provider: "claude", account, id });
  return (await request("GET", `/api/session-units?${q}`)) as SessionUnits;
}

/** Removed for good, without the trash. */
export async function deleteUnit(body: DeleteUnit): Promise<DeleteUnitResult> {
  return (await request("POST", "/api/session-units/delete", body)) as DeleteUnitResult;
}

export async function fetchOrphans(): Promise<OrphanList> {
  return (await request("GET", "/api/orphans")) as OrphanList;
}

/** Removed for good, without the trash. */
export async function deleteOrphan(body: SessionTarget): Promise<DeleteOrphanResult> {
  return (await request("POST", "/api/orphans/delete", body)) as DeleteOrphanResult;
}

// ---- The right panel's 작업 tab (DESIGN.md 6i): the rows follow on the tab's next read ----

/** Stops one running subagent or workflow of the session. */
export function stopSessionAgent(body: StopSessionAgent): Promise<void> {
  return call("POST", "/api/session-agents/stop", body);
}

/** Sends the session the message that runs a stopped workflow again from its run. */
export async function resumeSessionWorkflow(body: ResumeSessionWorkflow): Promise<ResumeSessionWorkflowResult> {
  return (await request("POST", "/api/session-agents/resume", body)) as ResumeSessionWorkflowResult;
}

/** The rewind screen's messages (DESIGN.md 6o). */
export async function fetchSessionRewind(key: string): Promise<SessionRewindList> {
  return (await request("GET", `/api/session-rewind?key=${encodeURIComponent(key)}`)) as SessionRewindList;
}

export async function fetchRewindPreview(key: string, id: string): Promise<SessionRewindPreview> {
  return (await request("GET", `/api/session-rewind/preview?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}`)) as SessionRewindPreview;
}

export async function rewindSession(body: SessionRewindRequest): Promise<SessionRewindResult> {
  return (await request("POST", "/api/session-rewind", body)) as SessionRewindResult;
}

/** Makes a new session from the conversation up to a message and its answer (DESIGN.md 6q). */
export async function forkSessionAt(body: SessionForkRequest): Promise<SessionForkResult> {
  return (await request("POST", "/api/session-fork", body)) as SessionForkResult;
}
