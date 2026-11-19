// Sending through Firebase Cloud Messaging, HTTP v1 (DESIGN.md 2d, 푸시 알림), with node:crypto and
// fetch only. The Firebase service account's key signs a JWT (RS256) that its token_uri trades for
// an OAuth2 access token; the token is reused until shortly before it ends.
//   POST <token_uri>   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>
//   POST https://fcm.googleapis.com/v1/projects/<project_id>/messages:send   { message }
import crypto from "node:crypto";
import fs from "node:fs";
import type { PushData } from "@maru/shared";
import { PUSH_CHANNEL_ID } from "@maru/shared";
import type { PushNotice } from "./policy.ts";

/** The fields of the service account JSON file this client uses. */
export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri: string;
}

export type LoadedAccount =
  | { state: "missing" }
  | { state: "invalid"; error: string }
  /** `looseMode`: the file's permission bits when group or others may read it, else null. */
  | { state: "ok"; account: ServiceAccount; looseMode: number | null };

const FIELDS = ["client_email", "private_key", "project_id", "token_uri"] as const;

export function loadServiceAccount(file: string): LoadedAccount {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "invalid", error: err instanceof Error ? err.message : String(err) };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { state: "invalid", error: "not JSON" };
  }
  const missing = FIELDS.filter((f) => typeof parsed?.[f] !== "string" || !(parsed[f] as string));
  if (missing.length) return { state: "invalid", error: `missing ${missing.join(", ")}` };
  const account = Object.fromEntries(FIELDS.map((f) => [f, parsed[f] as string])) as unknown as ServiceAccount;
  try {
    crypto.createPrivateKey(account.private_key);
  } catch (err) {
    return { state: "invalid", error: `private_key: ${err instanceof Error ? err.message : String(err)}` };
  }
  const mode = fs.statSync(file).mode & 0o777;
  return { state: "ok", account, looseMode: mode & 0o077 ? mode : null };
}

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export const FCM_BASE = "https://fcm.googleapis.com";
/** Lifetime asked for in the JWT; Google's maximum is one hour. */
const JWT_LIFETIME_S = 3600;
/**
 * An access token is renewed this long before the end its token_uri named, so a request never
 * leaves with a token that ends on the way.
 */
const RENEW_BEFORE_MS = 60_000;

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** The signed assertion a token_uri trades for an access token (RFC 7523, Google's service account flow). */
export function serviceAccountJwt(sa: ServiceAccount, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const input = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
    iss: sa.client_email, scope: FCM_SCOPE, aud: sa.token_uri, iat, exp: iat + JWT_LIFETIME_S,
  })}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(input), sa.private_key).toString("base64url");
  return `${input}.${signature}`;
}

/** The `message` of a messages:send request. */
export interface FcmMessage {
  token: string;
  notification: { title: string; body: string };
  android: { priority: "high"; notification: { channel_id: string; tag: string } };
  data: PushData & Record<string, string>;
}

/**
 * FCM refuses a message whose payload is larger than this (FCM docs, "the maximum payload for both
 * message types is 4096 bytes"). The docs do not say byte by byte what counts, so `fitsFcm`
 * counts the notification and the data as JSON.
 */
export const FCM_PAYLOAD_LIMIT = 4096;

const dataOf = (notice: PushNotice): FcmMessage["data"] => ({ kind: notice.kind, sessionKey: notice.sessionKey });

/** The notice's full title and body fit FCM's payload limit. */
export function fitsFcm(notice: PushNotice): boolean {
  const payload = { notification: { title: notice.title, body: notice.body }, data: dataOf(notice) };
  return Buffer.byteLength(JSON.stringify(payload)) <= FCM_PAYLOAD_LIMIT;
}

/**
 * One device's message for a notice. `tag` is the session key, so a newer notice of the same
 * session replaces the one still on the phone instead of piling up. A notice too large for FCM
 * goes as its brief form, which sends the reader to the app for the rest.
 */
export function fcmMessage(notice: PushNotice, token: string): FcmMessage {
  return {
    token,
    notification: fitsFcm(notice) ? { title: notice.title, body: notice.body } : { ...notice.brief },
    android: { priority: "high", notification: { channel_id: PUSH_CHANNEL_ID, tag: notice.sessionKey } },
    data: dataOf(notice),
  };
}

export type SendResult =
  | { ok: true }
  /** `tokenGone`: FCM says the token reaches no app any more (UNREGISTERED) or is no token. */
  | { ok: false; status: number; error: string; tokenGone: boolean };

/**
 * Whether an FCM error answer means the registration token is of no use: UNREGISTERED (404, the
 * app was removed or the token replaced), or INVALID_ARGUMENT about the token itself. Any other
 * INVALID_ARGUMENT is a fault of the message, so the token stays.
 */
export function tokenGone(status: number, body: unknown): boolean {
  const err = (body as { error?: { status?: unknown; message?: unknown; details?: unknown } } | null)?.error;
  const details = Array.isArray(err?.details) ? (err.details as Record<string, unknown>[]) : [];
  const codes = details.map((d) => d?.errorCode).filter((c): c is string => typeof c === "string");
  if (codes.includes("UNREGISTERED")) return true;
  if (status !== 400 || !(codes.includes("INVALID_ARGUMENT") || err?.status === "INVALID_ARGUMENT")) return false;
  const violations = details.flatMap((d) => (Array.isArray(d?.fieldViolations) ? (d.fieldViolations as Record<string, unknown>[]) : []));
  if (violations.some((v) => v?.field === "message.token")) return true;
  return typeof err?.message === "string" && /registration token/i.test(err.message);
}

export interface FcmClientOptions {
  account: ServiceAccount;
  /** The FCM origin; tests point it at a local server. */
  base?: string;
  /** Overrides the account's token_uri (tests). */
  tokenUri?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** One project's sender. Sends are independent: a failure is answered, never retried here. */
export class FcmClient {
  private account: ServiceAccount;
  private base: string;
  private tokenUri: string;
  private fetchFn: typeof fetch;
  private now: () => number;
  private access: { token: string; renewAt: number } | null = null;
  /** The exchange under way, shared by sends that need a token meanwhile. */
  private exchanging: Promise<string> | null = null;

  constructor(opts: FcmClientOptions) {
    this.account = opts.account;
    this.base = (opts.base ?? FCM_BASE).replace(/\/+$/, "");
    this.tokenUri = opts.tokenUri ?? opts.account.token_uri;
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get projectId(): string {
    return this.account.project_id;
  }

  async send(message: FcmMessage): Promise<SendResult> {
    let access: string;
    try {
      access = await this.accessToken();
    } catch (err) {
      return { ok: false, status: 0, error: `access token: ${err instanceof Error ? err.message : String(err)}`, tokenGone: false };
    }
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/v1/projects/${encodeURIComponent(this.account.project_id)}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${access}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ message }),
      });
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err), tokenGone: false };
    }
    if (res.ok) {
      await res.arrayBuffer();
      return { ok: true };
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: the text is the error.
    }
    // A token Google stopped taking before its end: the next send exchanges a new one.
    if (res.status === 401) this.access = null;
    const detail = (body as { error?: { status?: unknown; message?: unknown } } | null)?.error;
    const error = detail ? `${String(detail.status ?? res.status)}: ${String(detail.message ?? "")}` : `${res.status} ${text}`;
    return { ok: false, status: res.status, error, tokenGone: tokenGone(res.status, body) };
  }

  private accessToken(): Promise<string> {
    if (this.access && this.now() < this.access.renewAt) return Promise.resolve(this.access.token);
    if (!this.exchanging) {
      const p = this.exchange().finally(() => {
        if (this.exchanging === p) this.exchanging = null;
      });
      this.exchanging = p;
    }
    return this.exchanging;
  }

  private async exchange(): Promise<string> {
    const started = this.now();
    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: serviceAccountJwt(this.account, started),
    });
    const res = await this.fetchFn(this.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    const body = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || !body.access_token) throw new Error("no access_token in the answer");
    const lifetimeMs = (typeof body.expires_in === "number" ? body.expires_in : JWT_LIFETIME_S) * 1000;
    this.access = { token: body.access_token, renewAt: started + lifetimeMs - RENEW_BEFORE_MS };
    return body.access_token;
  }
}

/**
 * The sender for the service account file, or null when pushes are off: no file (the Firebase
 * project is not set up yet) or one that cannot be used. Says which in one line.
 */
export function openFcm(file: string, log: (line: string) => void): FcmClient | null {
  const loaded = loadServiceAccount(file);
  if (loaded.state === "missing") {
    log(`push: off (no Firebase service account at ${file})`);
    return null;
  }
  if (loaded.state === "invalid") {
    log(`push: off (${file}: ${loaded.error})`);
    return null;
  }
  if (loaded.looseMode !== null) {
    log(`push: warning: ${file} is mode ${loaded.looseMode.toString(8).padStart(4, "0")}; it holds a private key, chmod 600 it`);
  }
  log(`push: on (Firebase project ${loaded.account.project_id})`);
  return new FcmClient({ account: loaded.account });
}
