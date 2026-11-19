// The routes the message menu calls (web projectsApi.ts, same paths and bodies): the rewind list,
// the code restore's dry run, the rewind and the fork from a message. Device tokens may use exactly
// these four (apps/server/src/devices/access.ts).
import type { RewindMode, SessionForkResult, SessionRewindList, SessionRewindPreview, SessionRewindResult } from "@maru/shared";
import { auth, call, type Pairing } from "./api.ts";

const json = (p: Pairing) => ({ ...auth(p.token), "content-type": "application/json" });

export function fetchRewindList(p: Pairing, key: string): Promise<SessionRewindList> {
  return call<SessionRewindList>(`${p.server}/api/session-rewind?key=${encodeURIComponent(key)}`, { headers: auth(p.token) });
}

export function fetchRewindPreview(p: Pairing, key: string, id: string): Promise<SessionRewindPreview> {
  return call<SessionRewindPreview>(`${p.server}/api/session-rewind/preview?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}`, { headers: auth(p.token) });
}

export function rewindTo(p: Pairing, key: string, id: string, mode: RewindMode): Promise<SessionRewindResult> {
  return call<SessionRewindResult>(`${p.server}/api/session-rewind`, { method: "POST", headers: json(p), body: JSON.stringify({ key, id, mode }) });
}

export function forkAt(p: Pairing, key: string, id: string): Promise<SessionForkResult> {
  return call<SessionForkResult>(`${p.server}/api/session-fork`, { method: "POST", headers: json(p), body: JSON.stringify({ key, id }) });
}

/** The text of a failed call: the server's `{ error }` reason or the connection failure (lib/api.ts call). */
export function failureText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
