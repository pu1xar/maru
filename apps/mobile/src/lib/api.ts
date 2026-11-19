// The paired server's HTTP API as the app calls it, with the device token in `Authorization`.
// Plain fetch and no native module, so the connection logic that uses it runs in node tests;
// storing the pairing (expo-secure-store) stays in pairing.ts.
import type { AccountInfo, DeviceInfo, DevicePushRegistration, DeviceSelf, MobileApkLink, MobileAppInfo, SearchResponse, SetGroupFolded, UploadedAttachment } from "@maru/shared";
// By path: a node test cannot resolve a value import of @maru/shared here (Metro watches packages/shared).
import { attachmentUploadUrl } from "../../../../packages/shared/src/attachments.ts";
import { uploadFailureReason } from "../../../web/src/lib/composerAttachments.logic.ts";
import { isUploadedAttachment } from "./composerAttachments.logic.ts";

export interface Pairing {
  server: string;
  token: string;
  device: DeviceInfo;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function call<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new ApiError(0, `Could not reach the server: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const error = (body as { error?: unknown } | null)?.error;
    throw new ApiError(res.status, typeof error === "string" ? error : `HTTP ${res.status}`);
  }
  return body as T;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/json" });

/** The accounts a new session can run under (web `GET /api/accounts`, open to devices). */
export async function fetchAccounts(p: Pairing): Promise<AccountInfo[]> {
  return (await call<{ accounts: AccountInfo[] }>(`${p.server}/api/accounts`, { headers: auth(p.token) })).accounts;
}

/** Hands the server this app's FCM token, or takes it back (null). */
export async function setPushToken(p: Pairing, token: string | null): Promise<void> {
  if (token === null) {
    await call(`${p.server}/api/device/push`, { method: "DELETE", headers: auth(p.token) });
    return;
  }
  const body: DevicePushRegistration = { token };
  await call(`${p.server}/api/device/push`, {
    method: "PUT",
    headers: { ...auth(p.token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function fetchSelf(p: Pairing): Promise<DeviceSelf> {
  return call<DeviceSelf>(`${p.server}/api/device/me`, { headers: auth(p.token) });
}

export function fetchAppInfo(p: Pairing): Promise<MobileAppInfo> {
  return call<MobileAppInfo>(`${p.server}/api/device/app`, { headers: auth(p.token) });
}

/** A one-time URL for the newest APK (POST /api/device/apk-link): the phone's browser opens it and downloads. */
export function requestApkLink(p: Pairing): Promise<MobileApkLink> {
  return call<MobileApkLink>(`${p.server}/api/device/apk-link`, { method: "POST", headers: auth(p.token) });
}

/**
 * Search over every session's conversation (web `GET /api/search`, DESIGN.md 6u): `limit` hits from
 * `offset`, newest first. An empty `q` only asks the server to catch its index up.
 */
export function fetchSearch(p: Pairing, q: string, offset: number, limit: number, signal?: AbortSignal): Promise<SearchResponse> {
  const query = new URLSearchParams({ q, offset: String(offset), limit: String(limit) });
  return call<SearchResponse>(`${p.server}/api/search?${query}`, { headers: auth(p.token), ...(signal ? { signal } : {}) });
}

/** Folds or unfolds one sidebar folder for every client (web `PUT /api/group-fold`, DESIGN.md 6v); the server's `foldedGroups` message follows. */
export async function setGroupFolded(p: Pairing, body: SetGroupFolded): Promise<void> {
  await call(`${p.server}/api/group-fold`, {
    method: "PUT",
    headers: { ...auth(p.token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Sets the order of the Groups (web `POST /api/projects/order`, DESIGN.md 6w): `ids` names every
 * Group once, top first. The server's `projects` message follows and moves every client's list.
 */
export async function reorderProjects(p: Pairing, ids: string[]): Promise<void> {
  await call(`${p.server}/api/projects/order`, {
    method: "POST",
    headers: { ...auth(p.token), "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

export function wsUrl(p: Pairing): string {
  return `${p.server.replace(/^http/, "ws")}/ws`;
}

export function authHeaders(p: Pairing): Record<string, string> {
  return { Authorization: `Bearer ${p.token}` };
}

/** A running upload: its answer, and a way to stop it. */
export interface Upload {
  done: Promise<UploadedAttachment>;
  abort(): void;
}

/**
 * Uploads one picked file to the server's attachment store (DESIGN.md 6n): the body is the file's
 * bytes, read natively from `uri` and streamed (XMLHttpRequest takes `{ uri }` as a file body and
 * reports `upload.onprogress`; fetch has no upload progress). The device listener stores it with
 * this device's id, so only this phone can send it. Rejects with the reason text the web shows.
 */
export function uploadAttachment(p: Pairing, file: { uri: string; name: string; mimeType: string }, onProgress: (sent: number) => void): Upload {
  const xhr = new XMLHttpRequest();
  const done = new Promise<UploadedAttachment>((resolve, reject) => {
    xhr.open("POST", `${p.server}${attachmentUploadUrl(file.name)}`);
    for (const [k, v] of Object.entries(auth(p.token))) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader("content-type", file.mimeType);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onerror = () => reject(new Error(uploadFailureReason(xhr.status, xhr.responseText)));
    xhr.onabort = () => reject(new Error("Upload stopped"));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // A proxy's page or plain text: uploadFailureReason reads the status.
      }
      if (xhr.status >= 200 && xhr.status < 300 && isUploadedAttachment(body)) return resolve(body);
      reject(new Error(uploadFailureReason(xhr.status, xhr.responseText)));
    };
    // React Native's XHR sends a file body for an object with a `uri`.
    xhr.send({ uri: file.uri } as unknown as XMLHttpRequestBodyInit);
  });
  return { done, abort: () => xhr.abort() };
}
