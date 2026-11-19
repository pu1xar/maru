// What the pairing screen takes (DESIGN.md 2e): the web dialog's link (`maru://pair?server=&code=`,
// pasted or opened as a deep link), or a server address with the code typed as the dialog shows it
// (`XXXX-XXXX-XXXX`). The result is the credential the claim sends as its bearer.
import { normalizeShortCode, shortCodeCredential } from "@maru/shared";

export interface PairingTarget {
  /** Origin the app talks to, without a trailing slash. */
  server: string;
  /** The bearer credential: the long code, or `maru_s_` and the short code. */
  credential: string;
}

const LONG_CODE = /^maru_p_[A-Za-z0-9_-]{43}$/;

/** The fields of a `maru://pair` link, or null for anything else. */
export function readPairingLink(text: string): { server: string; code: string } | null {
  const m = /^maru:\/\/pair\/?\?(.*)$/.exec(text.trim());
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  return { server: q.get("server") ?? "", code: q.get("code") ?? "" };
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** Exactly a scheme (or none), an ASCII host and a port: the shape the phone app takes (apps/mobile pairingLink.ts). */
const SERVER = new RegExp(`^(?:(https|http)://)?(${LABEL}(?:\\.${LABEL})*)(?::([0-9]{1,5}))?/?$`, "i");
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

/**
 * The server's origin, rebuilt from its checked parts, or an error. A link can come from anywhere,
 * so the server must be exactly a scheme, a host of letters, digits, dots and hyphens, and an
 * optional port; a path, a query, `%`, user info or a non-ASCII host (a look-alike) is refused, so
 * the address the screen shows is the one the app talks to (independent review, 2026-11-16).
 * HTTPS for any host; plain HTTP only for this computer's loopback. A bare host name gets https.
 */
export function readServer(text: string): { server: string } | { error: string } {
  const raw = text.trim();
  if (!raw) return { error: "Enter the server address" };
  const m = SERVER.exec(raw);
  if (!m) return { error: "The server address must look like https://name or https://name:port (no path, user name, or %)" };
  const scheme = (m[1] ?? "https").toLowerCase();
  const host = m[2]!.toLowerCase();
  const port = m[3] === undefined ? null : Number(m[3]);
  if (port !== null && (port < 1 || port > 65535)) return { error: "Invalid port" };
  if (scheme === "http" && !LOOPBACK.has(host)) return { error: "The server address must be https (only 127.0.0.1 on this computer can use http)" };
  const shown = port === null || port === (scheme === "https" ? 443 : 80) ? host : `${host}:${port}`;
  return { server: `${scheme}://${shown}` };
}

/** The code field: a long code, or a short one in any case with or without hyphens. */
export function readCode(text: string): { credential: string } | { error: string } {
  const raw = text.trim();
  if (!raw) return { error: "Enter the code" };
  if (LONG_CODE.test(raw)) return { credential: raw };
  const short = normalizeShortCode(raw);
  if (short) return { credential: shortCodeCredential(short) };
  return { error: "Invalid code. Enter the 12-character code shown in the desktop connection window in the web app" };
}

export function readPairingInput(serverText: string, codeText: string): PairingTarget | { error: string } {
  // A link pasted into either field carries both.
  const link = readPairingLink(codeText) ?? readPairingLink(serverText);
  const server = readServer(link ? link.server : serverText);
  if ("error" in server) return server;
  const code = readCode(link ? link.code : codeText);
  if ("error" in code) return code;
  return { server: server.server, credential: code.credential };
}
