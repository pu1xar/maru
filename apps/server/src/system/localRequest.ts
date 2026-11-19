import type { IncomingHttpHeaders } from "node:http";

/** Headers a reverse proxy or tunnel adds to what it forwards; a request that goes straight to the loopback port has none. */
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded", "cf-connecting-ip", "cf-ray", "cf-visitor"];

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Whether a request comes from a browser or app on this Mac itself (DESIGN.md 6z): its socket is
 * loopback, its Host names a loopback name, and no proxy header says it was forwarded. The server
 * listens on loopback only and sits behind a reverse proxy, so a socket check alone
 * would let every remote request through; the Host and proxy headers tell the two apart. Only such
 * a request may use the Mac's Finder folder dialog, since the dialog opens on the Mac's own screen.
 */
export function isLocalRequest(remoteAddress: string | undefined, headers: IncomingHttpHeaders): boolean {
  if (!remoteAddress || !LOOPBACK_ADDRESSES.has(remoteAddress)) return false;
  if (PROXY_HEADERS.some((h) => headers[h] !== undefined)) return false;
  const host = String(headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(host);
}
