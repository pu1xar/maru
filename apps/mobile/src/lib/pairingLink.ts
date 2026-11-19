// The pairing link the web's Devices tab shows as a QR code (packages/shared/src/devices.ts
// pairingLink): maru://pair?server=<url>&code=<code>.
//
// Parsed by hand, without URL or URLSearchParams. React Native's URL is not the WHATWG parser but a
// regex polyfill (react-native/Libraries/Blob/URL.js) that reads a host after the first `@` and
// takes `\` as a host character, while OkHttp, which sends the requests, reads the URL its own way:
// `https://u@evil.com\@maru.example.com` showed maru.example.com on the confirmation while OkHttp
// claimed at evil.com (independent review, 2026-11-16). So the server must be exactly a scheme, a
// host of letters, digits, dots and hyphens, and an optional port, and the app rebuilds it from
// those parts; anything else (user info, `\`, `%`, spaces, a path, a query) is refused.

export interface PairingTarget {
  /** `https://host[:port]`, rebuilt from the checked parts, without a trailing slash. */
  server: string;
  code: string;
}

/** A server the app may talk to, in parts. */
export interface ServerParts {
  scheme: "https" | "http";
  /** Lowercase DNS name or dotted IPv4 address. */
  hostname: string;
  port: number | null;
}

const CODE = /^maru_p_[A-Za-z0-9_-]{43}$/;
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const SERVER = new RegExp(`^(https|http)://(${LABEL}(?:\\.${LABEL})*)(?::([0-9]{1,5}))?/?$`, "i");
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

/**
 * The parts of a server address, or null for anything that is not exactly scheme, host and port.
 * HTTPS for any host; plain HTTP only for this phone's loopback (a test server through
 * `adb reverse`), which is also all the app's network config allows.
 */
export function parseServer(text: string): ServerParts | null {
  const m = SERVER.exec(text);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase() as ServerParts["scheme"];
  const hostname = m[2]!.toLowerCase();
  const port = m[3] === undefined ? null : Number(m[3]);
  if (port !== null && (port < 1 || port > 65535)) return null;
  if (scheme === "http" && !LOOPBACK.has(hostname)) return null;
  const defaultPort = scheme === "https" ? 443 : 80;
  return { scheme, hostname, port: port === defaultPort ? null : port };
}

/** `host[:port]` of checked parts. */
export function serverHost(s: ServerParts): string {
  return s.port === null ? s.hostname : `${s.hostname}:${s.port}`;
}

export function serverOrigin(s: ServerParts): string {
  return `${s.scheme}://${serverHost(s)}`;
}

/** `name=value` pairs of a query, percent-decoded; null when a value does not decode. */
function queryParams(query: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const i = pair.indexOf("=");
    const name = i < 0 ? pair : pair.slice(0, i);
    const value = i < 0 ? "" : pair.slice(i + 1);
    try {
      const key = decodeURIComponent(name);
      // The first value counts, as URLSearchParams.get reads it.
      if (!out.has(key)) out.set(key, decodeURIComponent(value));
    } catch {
      return null;
    }
  }
  return out;
}

/** Reads a scanned or pasted link. */
export function parsePairingLink(text: string): PairingTarget | { error: string } {
  const raw = text.trim();
  const m = /^maru:\/\/pair\?(.*)$/.exec(raw);
  if (!m) return { error: "Not a maru pairing link" };
  const q = queryParams(m[1]!);
  if (!q) return { error: "Could not read the link" };
  const code = q.get("code") ?? "";
  if (!CODE.test(code)) return { error: "The pairing code in the link is not valid" };
  const serverText = q.get("server") ?? "";
  const server = parseServer(serverText);
  if (!server) {
    return {
      error: /^http:\/\//i.test(serverText) ? "The server address must be https" : "The server address in the link is not valid",
    };
  }
  return { server: serverOrigin(server), code };
}

/**
 * What the confirmation before a claim shows (DESIGN.md 2d, pairing confirmation). A link carries the server
 * the app will send every message to and trust with its token, and anyone can make one: a link in
 * a chat or a QR on a wall can name another server. So no link pairs by itself; the user sees
 * the host and confirms. While this phone is paired, the new pairing replaces the current one.
 */
export interface PairingReview {
  /** The host (and port) to show large: the part a look-alike link would fake. */
  host: string;
  /** `https://host[:port]`. */
  origin: string;
  /** The phone's own loopback, a test server through `adb reverse`. */
  loopback: boolean;
  /** none: not paired now; same-server: pairs again with the current server; other-server: switches. */
  replaces: "none" | "same-server" | "other-server";
  /** The current server's host, when paired. */
  currentHost: string | null;
}

export function reviewPairing(target: PairingTarget, currentServer: string | null): PairingReview {
  // The target came from parsePairingLink, so it parses; the fallback only keeps the type total.
  const s = parseServer(target.server) ?? { scheme: "https" as const, hostname: target.server, port: null };
  const current = currentServer === null ? null : parseServer(currentServer);
  return {
    host: serverHost(s),
    origin: serverOrigin(s),
    loopback: LOOPBACK.has(s.hostname),
    replaces: currentServer === null ? "none" : current && serverOrigin(current) === serverOrigin(s) ? "same-server" : "other-server",
    currentHost: currentServer === null ? null : current ? serverHost(current) : currentServer,
  };
}
