// The main process's own requests to the maru server (DESIGN.md 2e): the pairing claim, the
// device's self check, unpairing, and the update feed. They go through the window's session
// (Chromium's network stack), so the system proxy and certificate store apply as they do to the page.
import crypto from "node:crypto";
import fs from "node:fs";
import type { Session } from "electron";
import type { DeviceSelf, DesktopUpdateResponse, PairDeviceResponse } from "@maru/shared";
import type { Pairing } from "./pairingStore.ts";
import type { PairingTarget } from "./pairingInput.ts";

export class ApiError extends Error {
  status: number;
  /** A 401 from the device listener itself (`www-authenticate: Bearer`), not from something in front of it. */
  fromDeviceListener: boolean;
  constructor(status: number, message: string, fromDeviceListener = false) {
    super(message);
    this.status = status;
    this.fromDeviceListener = fromDeviceListener;
  }
}

// None of these routes redirects. A redirect would carry the Authorization header this code sets
// to wherever it points (Chromium keeps a request's own headers across redirects), so it is an
// error instead (independent review, 2026-11-16).
async function call<T>(ses: Session, url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await ses.fetch(url, { ...init, cache: "no-store", redirect: "error" });
  } catch (e) {
    throw new ApiError(0, `Could not reach the server: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: the status explains it
  }
  if (!res.ok) {
    const error = (body as { error?: unknown } | null)?.error;
    const listener = res.status === 401 && res.headers.get("www-authenticate") === "Bearer" && typeof error === "string";
    throw new ApiError(res.status, typeof error === "string" ? error : `HTTP ${res.status}`, listener);
  }
  return body as T;
}

const auth = (credential: string) => ({ authorization: `Bearer ${credential}`, accept: "application/json" });

export function claim(ses: Session, target: PairingTarget, name: string): Promise<PairDeviceResponse> {
  return call<PairDeviceResponse>(ses, `${target.server}/api/device/pair`, {
    method: "POST",
    headers: { ...auth(target.credential), "content-type": "application/json" },
    body: JSON.stringify({ name, kind: "desktop" }),
  });
}

/**
 * "ok", "revoked" (the device listener itself said the token is unknown), or why the server could
 * not answer. A 401 from something in front of the listener (a misrouted proxy) is not taken as a
 * removal, so the app keeps its token and tries again.
 */
export async function checkSelf(ses: Session, p: Pairing): Promise<"ok" | "revoked" | { error: string }> {
  try {
    await call<DeviceSelf>(ses, `${p.server}/api/device/me`, { headers: auth(p.token) });
    return "ok";
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && e.fromDeviceListener) return "revoked";
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function unpairSelf(ses: Session, p: Pairing): Promise<void> {
  await call(ses, `${p.server}/api/device/me`, { method: "DELETE", headers: auth(p.token) });
}

/** The signed manifest and its signature; null when the server's release has no desktop build. */
export async function fetchUpdate(ses: Session, p: Pairing): Promise<DesktopUpdateResponse | null> {
  try {
    return await call<DesktopUpdateResponse>(ses, `${p.server}/api/desktop/update`, { headers: auth(p.token) });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}


/** The server answered a Range request with something other than the range (a proxy that ignores Range, a file that changed). */
export class RangeNotHonored extends Error {}

const downloadUrl = (p: Pairing, file: string) => `${p.server}/api/desktop/download/${encodeURIComponent(file)}`;

async function fetchDownload(ses: Session, p: Pairing, file: string, headers: Record<string, string> = {}): Promise<Response> {
  try {
    return await ses.fetch(downloadUrl(p, file), { headers: { ...auth(p.token), ...headers }, cache: "no-store", redirect: "error" });
  } catch (e) {
    throw new ApiError(0, `Could not reach the server: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The response body as an async stream of byte chunks; leaving the loop early cancels the request. */
async function* chunks(res: Response): AsyncGenerator<Uint8Array> {
  const reader = res.body!.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Streams one build file to `dest` and returns its SHA-256 (hex). The caller compares it with the
 * signed manifest before using the file. `size` is the signed size: a server that sends more is
 * sending another file, so the download stops there instead of filling the disk first.
 *
 * A `dest` left by a cut-off download is continued: the request asks for the rest with Range and
 * `If-Range` set to the file's ETag (its signed SHA-256), so the bytes joined are one build's. The
 * bytes already there are hashed first, and the signed SHA-256 over the whole file decides at the end.
 */
export async function download(
  ses: Session, p: Pairing, file: string, size: number, sha256: string, dest: string, onProgress: (received: number) => void,
): Promise<string> {
  let have = 0;
  try {
    have = fs.statSync(dest).size;
  } catch {
    // nothing downloaded yet
  }
  if (have >= size) have = 0;
  let res = have > 0 ? await fetchDownload(ses, p, file, { range: `bytes=${have}-`, "if-range": `"${sha256}"` }) : null;
  if (res && !(res.status === 206 && res.headers.get("content-range") === `bytes ${have}-${size - 1}/${size}`)) {
    // 200 (the file changed, or Range is ignored) or 416: start again from the first byte.
    await res.body?.cancel().catch(() => {});
    have = 0;
    res = null;
  }
  res ??= await fetchDownload(ses, p, file);
  if (!res.ok || !res.body) throw new ApiError(res.status, `Could not download ${file} (HTTP ${res.status})`);
  const hash = crypto.createHash("sha256");
  if (have > 0) {
    for await (const b of fs.createReadStream(dest, { end: have - 1 })) hash.update(b as Buffer);
  }
  const out = fs.createWriteStream(dest, { flags: have > 0 ? "a" : "w" });
  let received = have;
  try {
    for await (const value of chunks(res)) {
      received += value.length;
      if (received > size) throw new ApiError(0, `${file} is larger than the signed size (${size} bytes)`);
      hash.update(value);
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
      onProgress(received);
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }
  return hash.digest("hex");
}

/** The block map file for an update file: read whole, and kept only if it is the signed size and SHA-256. */
export async function fetchBlockMap(ses: Session, p: Pairing, map: { file: string; size: number; sha256: string }): Promise<Buffer> {
  const res = await fetchDownload(ses, p, map.file);
  if (!res.ok || !res.body) throw new ApiError(res.status, `Could not download ${map.file} (HTTP ${res.status})`);
  const parts: Buffer[] = [];
  let got = 0;
  for await (const value of chunks(res)) {
    got += value.length;
    if (got > map.size) throw new ApiError(0, `${map.file} is larger than the signed size (${map.size} bytes)`);
    parts.push(Buffer.from(value));
  }
  const data = Buffer.concat(parts);
  if (data.length !== map.size || crypto.createHash("sha256").update(data).digest("hex") !== map.sha256) {
    throw new ApiError(0, `${map.file} differs from the signed value`);
  }
  return data;
}

/**
 * Bytes `start` to `end` (inclusive) of an update file of `size` bytes, as a stream. The server must
 * answer 206 with exactly that range for the file the manifest signed (`If-Range` is its ETag);
 * anything else is RangeNotHonored and the caller downloads the whole file the plain way.
 */
export async function fetchRange(ses: Session, p: Pairing, file: string, size: number, sha256: string, start: number, end: number): Promise<AsyncIterable<Uint8Array>> {
  const res = await fetchDownload(ses, p, file, { range: `bytes=${start}-${end}`, "if-range": `"${sha256}"` });
  if (res.status !== 206 || res.headers.get("content-range") !== `bytes ${start}-${end}/${size}` || !res.body) {
    await res.body?.cancel().catch(() => {});
    if (res.status >= 500) throw new ApiError(res.status, `Could not download ${file} (HTTP ${res.status})`);
    throw new RangeNotHonored(`The server answered HTTP ${res.status} to the request for range ${start}-${end} of ${file}`);
  }
  return chunks(res);
}
