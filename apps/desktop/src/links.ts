// Where a link or a navigation in the app's window goes (DESIGN.md 2e), after T3 Code's window
// rules (DesktopWindow.ts setWindowOpenHandler and will-navigate, ElectronShell.ts
// parseSafeExternalUrl): the server's own pages stay in the app, http(s) and mailto open in the
// default browser, anything else is dropped.
//
// One difference from T3: a same-origin link that asks for a new window (an attachment's 원본 열기,
// a file opened in a tab) opens in an app window. Those URLs answer only with the device token,
// which the app's session adds and a browser does not have.

export type LinkTarget = "app" | "browser" | "drop";

/** The origin a URL is the same site as: ws and wss name the http and https origin of their host. */
export function siteOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const protocol = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
  if (protocol !== "http:" && protocol !== "https:") return null;
  return `${protocol}//${url.host}`;
}

export function isServerUrl(raw: string, server: string | null): boolean {
  return server !== null && siteOrigin(raw) === server;
}

export function linkTarget(raw: string, server: string | null): LinkTarget {
  if (isServerUrl(raw, server)) return "app";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "drop";
  }
  return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? "browser" : "drop";
}
