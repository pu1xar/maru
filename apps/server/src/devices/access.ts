import type { IncomingMessage } from "node:http";
import { SHELL_SOCKET_PATH, isInlineImagePath, isShellId, type DeviceKind } from "@maru/shared";

/** Web API reads a phone may make, passed to the web server's own handlers. */
const ANDROID_GETS = new Set(["/api/sessions", "/api/projects", "/api/accounts", "/api/accounts/status", "/api/usage", "/api/search"]);

/**
 * The reads and writes of the app's message menu (DESIGN.md 6o, 6q), by method and exact path:
 * the rewind list and preview, the rewind itself and the fork from a message. They act on one
 * session the token's /ws already drives (send, interrupt), and take the same checks as the web's.
 */
const ANDROID_MESSAGE_ROUTES = new Set([
  "GET /api/session-rewind",
  "GET /api/session-rewind/preview",
  "POST /api/session-rewind",
  "POST /api/session-fork",
]);

/**
 * The sidebar's two writes: folding or unfolding a folder (`SetGroupFolded`, DESIGN.md 6v) and
 * setting the order of the Groups (`POST /api/projects/order`, `{ ids }`, DESIGN.md 6w). The folds
 * and the order are each one list the server keeps for every client, and the drawer reads and
 * changes the same lists, so a folder folded or moved on the web is so on the phone. Creating,
 * renaming and deleting a Group stay closed to the phone.
 */
const ANDROID_SIDEBAR_ROUTES = new Set(["PUT /api/group-fold", "POST /api/projects/order"]);

/**
 * The app's session management (DESIGN.md 2d, 6g), by method and exact path: the web's 세션 관리
 * table needs the sessions outside the list, orphans, subagent and workflow units, the trash and a
 * resume command, and writes a name, a lock, list membership, a delete, a restore or purge, an
 * account move and a working-folder change. A phone token already drives sessions over /ws
 * (create, send, interrupt), and this is a single-user setup where the paired phone is the user's
 * own, so the same handlers answer with the web's own checks (locked and open sessions are refused
 * there, not here). The folder fields (DESIGN.md 6z) read `GET /api/fs-complete`, which answers the
 * names of the subfolders of the folder typed so far (never a file or its contents); the native
 * folder dialog (`POST /api/pick-folder`) stays closed to a phone.
 */
const ANDROID_MANAGE_ROUTES = new Set([
  "GET /api/session-candidates",
  "GET /api/orphans",
  "GET /api/session-units/all",
  "GET /api/session-units",
  "GET /api/session-agents",
  "GET /api/session-resume-command",
  "GET /api/trash",
  "PUT /api/session-name",
  "PUT /api/session-chosen",
  "POST /api/session-delete",
  "POST /api/orphans/delete",
  "POST /api/session-units/delete",
  "POST /api/trash/restore",
  "POST /api/trash/purge",
  "POST /api/session-move",
  "POST /api/session-rehome",
  "GET /api/fs-complete",
]);

/**
 * The shell terminals' routes a phone has (DESIGN.md 6s), by method and exact path: the list
 * (`GET /api/shells`), a new shell (`POST /api/shells`) and ending one (`DELETE /api/shells/<id>`,
 * the id in the shell form: `sh-` and 12 lowercase letters or digits). The view socket (`/shell`)
 * is in upgradeAllowed. The web's own checks answer these (a POST takes `application/json` only).
 */
function androidShellRoute(method: string, pathname: string): boolean {
  if (pathname === "/api/shells") return method === "GET" || method === "POST";
  return method === "DELETE" && pathname.startsWith("/api/shells/") && isShellId(pathname.slice("/api/shells/".length));
}

/**
 * The file reads a phone has (DESIGN.md 2d, 6e), both pictures:
 *   `GET /api/file/raw?path=` for a picture the app shows under a file path in a message (bitmap and
 *   SVG extensions, `isInlineImagePath`, no `:line` suffix since the app never sends one). Any
 *   folder is readable, as on the web, but other file types, the text view (`/api/file`) and
 *   folder listings (`/api/file/tree`) stay closed to a phone.
 *   `GET /api/file/blob` for the picture a tool result carries inline in a transcript line (the
 *   preview under a Read of an image file). The route answers only a decoded bitmap from an image
 *   block of a Claude `.jsonl` transcript (transcriptBlob.ts), never other bytes.
 * The request then takes the web's own checks (`fileFetchAllowed`, `nosniff`,
 * `Cross-Origin-Resource-Policy`, the SVG sandbox).
 */
function androidPictureRead(method: string, pathname: string, query: URLSearchParams | undefined): boolean {
  if (method !== "GET") return false;
  if (pathname === "/api/file/blob") return true;
  if (pathname !== "/api/file/raw") return false;
  const file = query?.get("path") ?? "";
  return isInlineImagePath(file) && !/:\d+(?::\d+|-\d+)?$/.test(file);
}

/**
 * Whether a device token of `kind` may pass a request on to the web server's routes (DESIGN.md
 * 2d, 2e). The device listener's own routes (/api/device/*, /ota/*) are decided before this.
 *   android  the five reads the phone app makes (the last is the search over every session's
 *            conversation, 6u), the message menu's rewind and fork routes, and
 *            PUT /api/group-fold (the drawer's folders fold and unfold, 6v),
 *            POST /api/projects/order (a long press on a Group moves it up or down, 6w), and
 *            the session management's routes (ANDROID_MANAGE_ROUTES), and
 *            POST /api/attachments (a picture or file to send with a message; the upload is stored with
 *            the phone's device id and only that phone may send it, DESIGN.md 6n), and
 *            GET /api/file/raw for a picture path and GET /api/file/blob (androidPictureRead), and
 *            the shell terminals' list, create and end routes (androidShellRoute, 6s)
 *   desktop  everything the web listener serves (pages, assets, /api, /healthz) except device
 *            management: listing devices, opening a pairing code, removing a device. Those stay
 *            behind the web sign-in, so a desktop token cannot mint another token or keep one alive
 *            against the web's 끊기
 */
export function webRouteAllowed(kind: DeviceKind, method: string, pathname: string, query?: URLSearchParams): boolean {
  if (kind === "android") {
    return (method === "GET" && ANDROID_GETS.has(pathname)) ||
      androidPictureRead(method, pathname, query) || ANDROID_MESSAGE_ROUTES.has(`${method} ${pathname}`) || ANDROID_SIDEBAR_ROUTES.has(`${method} ${pathname}`) ||
      ANDROID_MANAGE_ROUTES.has(`${method} ${pathname}`) || androidShellRoute(method, pathname) || (method === "POST" && pathname === "/api/attachments");
  }
  return !(pathname === "/api/devices" || pathname.startsWith("/api/devices/"));
}

/**
 * The WebSocket paths a device token of `kind` may open (DESIGN.md 2d, 2e, 6s):
 *   /ws      both kinds
 *   /shell   both kinds: the desktop app is the web page, and the Android app has a shell screen
 *            (xterm.js in a WebView) on the same view socket. The phone's token already drives
 *            sessions that run with every permission, so the shell adds no capability it lacks
 */
export function upgradeAllowed(_kind: DeviceKind, pathname: string): boolean {
  return pathname === "/ws" || pathname === SHELL_SOCKET_PATH;
}

/**
 * The browser rule of the web listener's guard (http/guard.ts), for the device listener: a request
 * that names an Origin must come from a page of the host it asks. The desktop app's page is that
 * host, so its requests pass; a frame with an opaque origin (`Origin: null`, a sandboxed file
 * preview) or a page of another site that the app's token header would also reach is refused.
 * React Native sends the WebSocket's own URL as its Origin, so the phone passes too. A request
 * without an Origin (the phone's fetch, a same-origin GET of a page) is not a browser's
 * cross-origin request and passes.
 */
export function originAllowed(req: Pick<IncomingMessage, "headers">): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (url.protocol === "https:" || url.protocol === "http:") && url.host === (req.headers.host ?? "") && url.origin === origin;
}
