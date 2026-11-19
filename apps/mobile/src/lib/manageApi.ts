// The routes the Sessions section calls (web projectsApi.ts, same paths and bodies): the sessions
// outside the list, orphans, units, the trash, a resume command, and the writes of a name,
// list membership, a delete, a restore or purge, an account move and a working-folder change. A
// device token may use exactly these (apps/server/src/devices/access.ts ANDROID_MANAGE_ROUTES),
// each answered by the web's own handler with its own checks. The folder fields read the
// subfolders of a typed path (`GET /api/fs-complete`, DESIGN.md 6z).
import type {
  AllUnits,
  ChooseSession,
  DeleteOrphanResult,
  DeleteSessionResult,
  DeleteUnit,
  DeleteUnitResult,
  FolderCompletion,
  MoveSession,
  MoveSessionResult,
  OrphanList,
  PurgeTrashResult,
  RehomeSession,
  RehomeSessionResult,
  RenameSession,
  RestoreTrashResult,
  ResumeCommand,
  SessionAgentsResponse,
  SessionCandidates,
  SessionSummary,
  SessionTarget,
  SessionUnits,
  TrashList,
} from "@maru/shared";
import { unitLabelsOf, type UnitLabel } from "../../../web/src/components/settings/manageModel.ts";
import { auth, call, type Pairing } from "./api.ts";

const json = (p: Pairing) => ({ ...auth(p.token), "content-type": "application/json" });
const get = <T>(p: Pairing, path: string) => call<T>(`${p.server}${path}`, { headers: auth(p.token) });
const send = <T>(p: Pairing, method: "POST" | "PUT", path: string, body: unknown) =>
  call<T>(`${p.server}${path}`, { method, headers: json(p), body: JSON.stringify(body) });

/** Page size for reading every candidate; the loop keeps going until `total` is reached (web fetchAllCandidates). */
const CANDIDATE_PAGE = 500;

/** Every session outside the list, read page by page until the server's total. */
export async function fetchAllCandidates(p: Pairing): Promise<SessionSummary[]> {
  const all: SessionSummary[] = [];
  for (;;) {
    const q = new URLSearchParams({ q: "", offset: String(all.length), limit: String(CANDIDATE_PAGE) });
    const page = await get<SessionCandidates>(p, `/api/session-candidates?${q}`);
    all.push(...page.sessions);
    // An empty page ends the loop too, in case the total shrank between two pages.
    if (all.length >= page.total || page.sessions.length === 0) return all;
  }
}

export const fetchOrphans = (p: Pairing) => get<OrphanList>(p, "/api/orphans");
export const fetchAllUnits = (p: Pairing) => get<AllUnits>(p, "/api/session-units/all");

export function fetchSessionUnits(p: Pairing, account: string, id: string): Promise<SessionUnits> {
  return get<SessionUnits>(p, `/api/session-units?${new URLSearchParams({ provider: "claude", account, id })}`);
}

/** Names for the units of one session, from its session-agents list (web ManagePanel fetchUnitLabels). */
export async function fetchUnitLabels(p: Pairing, account: string, id: string): Promise<Map<string, UnitLabel>> {
  const body = await get<SessionAgentsResponse>(p, `/api/session-agents?${new URLSearchParams({ key: `claude:${account}:${id}` })}`);
  return unitLabelsOf(body);
}

/** The subfolders of a typed path and whether it is a folder (web projectsApi.ts completeFolder). */
export const fetchFolders = (p: Pairing, path: string) => get<FolderCompletion>(p, `/api/fs-complete?${new URLSearchParams({ path })}`);

export const fetchTrash = (p: Pairing) => get<TrashList>(p, "/api/trash");

export function resumeCommand(p: Pairing, t: SessionTarget): Promise<ResumeCommand> {
  return get<ResumeCommand>(p, `/api/session-resume-command?${new URLSearchParams({ provider: t.provider, account: t.account, id: t.id })}`);
}

export async function renameSession(p: Pairing, body: RenameSession): Promise<void> {
  await send(p, "PUT", "/api/session-name", body);
}


export async function chooseSession(p: Pairing, body: ChooseSession): Promise<void> {
  await send(p, "PUT", "/api/session-chosen", body);
}

/** Over 1MB the session goes to the trash, otherwise it is removed for good. */
export const deleteSession = (p: Pairing, body: SessionTarget) => send<DeleteSessionResult>(p, "POST", "/api/session-delete", body);
export const deleteOrphan = (p: Pairing, body: SessionTarget) => send<DeleteOrphanResult>(p, "POST", "/api/orphans/delete", body);
export const deleteUnit = (p: Pairing, body: DeleteUnit) => send<DeleteUnitResult>(p, "POST", "/api/session-units/delete", body);
export const restoreTrash = (p: Pairing, key: string) => send<RestoreTrashResult>(p, "POST", "/api/trash/restore", { key });
export const purgeTrash = (p: Pairing, key: string) => send<PurgeTrashResult>(p, "POST", "/api/trash/purge", { key });
export const moveSession = (p: Pairing, body: MoveSession) => send<MoveSessionResult>(p, "POST", "/api/session-move", body);
export const rehomeSession = (p: Pairing, body: RehomeSession) => send<RehomeSessionResult>(p, "POST", "/api/session-rehome", body);
