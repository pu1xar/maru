// The device token on the page's requests (DESIGN.md 2e). The page is the server's own web page
// and asks with relative URLs (fetch("/api/..."), `${location.host}/ws`, <img src="/api/file/raw">),
// so the main process adds `Authorization: Bearer <token>` to every request of the window's session
// whose origin is the paired server: documents, scripts, fetch, EventSource and the WebSocket
// upgrade alike. The reverse proxy routes exactly those requests to the device listener. A request to any
// other origin goes out untouched, so the token never leaves for another site, and the page never
// sees it.
import type { Session } from "electron";
import { isServerUrl } from "./links.ts";
import type { Pairing } from "./pairingStore.ts";

/** What the page may ask of the browser: copying to the clipboard, and full screen. */
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);

export interface AuthOptions {
  pairing: () => Pairing | null;
  /** A page request to the server came back 401: the device may have been removed. */
  onUnauthorized: () => void;
}

export function attachAuth(ses: Session, opts: AuthOptions): void {
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const p = opts.pairing();
    const headers = details.requestHeaders;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
    if (p && isServerUrl(details.url, p.server)) {
      // A request that names its own credential (the pairing claim) keeps it.
      if (!key) headers.Authorization = `Bearer ${p.token}`;
    } else if (p && key && headers[key] === `Bearer ${p.token}`) {
      // The device token never goes to another origin, also not after a redirect of a request
      // that set it itself.
      delete headers[key];
    }
    callback({ requestHeaders: headers });
  });
  ses.webRequest.onCompleted((details) => {
    const p = opts.pairing();
    if (p && details.webContentsId !== undefined && details.statusCode === 401 && isServerUrl(details.url, p.server)) opts.onUnauthorized();
  });
  // A refused WebSocket upgrade surfaces as an error, not as a completed 401.
  ses.webRequest.onErrorOccurred((details) => {
    const p = opts.pairing();
    if (p && details.resourceType === "webSocket" && isServerUrl(details.url, p.server)) opts.onUnauthorized();
  });
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
}
