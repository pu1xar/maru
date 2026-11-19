import { test } from "node:test";
import assert from "node:assert/strict";
import { upgradeAllowed, webRouteAllowed } from "./access.ts";

test("a phone lists, opens and ends shells with exactly three routes, and the view socket is open to both device kinds", () => {
  const shell = "sh-0123456789ab";
  assert.equal(webRouteAllowed("android", "GET", "/api/shells"), true);
  assert.equal(webRouteAllowed("android", "POST", "/api/shells"), true);
  assert.equal(webRouteAllowed("android", "DELETE", `/api/shells/${shell}`), true);
  // Other methods on those paths, anything but the shell form of the id, siblings and the web's other routes stay closed.
  for (const method of ["PUT", "PATCH", "HEAD", "DELETE"]) assert.equal(webRouteAllowed("android", method, "/api/shells"), false, `${method} /api/shells`);
  for (const method of ["GET", "POST", "PUT", "HEAD"]) assert.equal(webRouteAllowed("android", method, `/api/shells/${shell}`), false, `${method} one shell`);
  const bad = ["/api/shells/", "/api/shells/x", "/api/shells/sh-0123456789a", "/api/shells/sh-0123456789abc", "/api/shells/SH-0123456789ab", `/api/shells/${shell}/`, `/api/shells/${shell}/x`, "/api/shells/../sessions", "/api/shellsx", "/api/shell"];
  for (const path of bad) {
    assert.equal(webRouteAllowed("android", "DELETE", path), false, path);
    assert.equal(webRouteAllowed("android", "GET", path), false, `GET ${path}`);
  }
  assert.equal(webRouteAllowed("desktop", "DELETE", `/api/shells/${shell}`), true);
  assert.equal(upgradeAllowed("android", "/shell"), true);
  assert.equal(upgradeAllowed("desktop", "/shell"), true);
  assert.equal(upgradeAllowed("android", "/ws"), true);
  for (const kind of ["android", "desktop"] as const) {
    for (const path of ["/shell/", "/shell/x", "/shells", "/", "/api/shells", "/ws/", "/wss"]) assert.equal(upgradeAllowed(kind, path), false, `${kind} ${path}`);
  }
});

test("a phone passes its four reads and the attachment upload, and nothing else of the web's routes", () => {
  for (const p of ["/api/sessions", "/api/projects", "/api/accounts", "/api/usage"]) assert.equal(webRouteAllowed("android", "GET", p), true, p);
  assert.equal(webRouteAllowed("android", "POST", "/api/attachments"), true);
  // Reading an upload back, listing, other writes and the pages stay closed.
  assert.equal(webRouteAllowed("android", "GET", "/api/attachments"), false);
  assert.equal(webRouteAllowed("android", "GET", "/api/attachments/20261116-00000000-0000-4000-8000-000000000000"), false);
  assert.equal(webRouteAllowed("android", "PUT", "/api/session-archive"), false);
  assert.equal(webRouteAllowed("android", "POST", "/api/attachments/x"), false);
  assert.equal(webRouteAllowed("android", "GET", "/"), false);
});

test("a phone reads a picture with GET /api/file/raw, a transcript's picture with GET /api/file/blob, and no other file route or file type", () => {
  const raw = (path: string, method = "GET", route = "/api/file/raw") => webRouteAllowed("android", method, route, new URLSearchParams({ path }));
  for (const p of ["/private/tmp/x/d-S7.png", "~/pics/a.JPG", "/a/b.jpeg", "/a/b.gif", "/a/b.webp", "/a/b.svg"]) assert.equal(raw(p), true, p);
  // Other types, a position suffix, a missing path and a folder-looking path.
  for (const p of ["/etc/hosts", "/a/b.txt", "/a/b.png:12", "/a/b.png/", "/a/png", ""]) assert.equal(raw(p), false, p);
  assert.equal(webRouteAllowed("android", "GET", "/api/file/raw"), false, "no query");
  // Only those routes and methods: the text view, listings, HEAD and writes stay closed.
  for (const route of ["/api/file", "/api/file/tree", "/api/file/raw/", "/api/file/blob/"]) assert.equal(raw("/a/b.png", "GET", route), false, route);
  for (const method of ["HEAD", "POST", "PUT", "DELETE"]) assert.equal(raw("/a/b.png", method), false, method);
  // The blob route takes its own query (path, offset, pointer) and answers with the same GET only.
  const blob = new URLSearchParams({ path: "/x/t.jsonl", offset: "0", pointer: "$.message.content[0].content[0].source.data" });
  assert.equal(webRouteAllowed("android", "GET", "/api/file/blob", blob), true);
  for (const method of ["HEAD", "POST", "PUT", "DELETE"]) assert.equal(webRouteAllowed("android", method, "/api/file/blob", blob), false, `blob ${method}`);
  assert.equal(webRouteAllowed("desktop", "GET", "/api/file/blob", blob), true);
});

test("a desktop token passes everything but device management", () => {
  assert.equal(webRouteAllowed("desktop", "POST", "/api/attachments"), true);
  assert.equal(webRouteAllowed("desktop", "GET", "/api/devices"), false);
  assert.equal(webRouteAllowed("desktop", "POST", "/api/devices/x/revoke"), false);
});

test("a phone folds and unfolds a sidebar folder with PUT /api/group-fold and no other method or path of it", () => {
  assert.equal(webRouteAllowed("android", "PUT", "/api/group-fold"), true);
  // Only the one write: the import (a browser's older list), reads and other methods stay closed.
  assert.equal(webRouteAllowed("android", "POST", "/api/group-fold/import"), false);
  assert.equal(webRouteAllowed("android", "GET", "/api/group-fold"), false);
  assert.equal(webRouteAllowed("android", "POST", "/api/group-fold"), false);
  assert.equal(webRouteAllowed("android", "DELETE", "/api/group-fold"), false);
  assert.equal(webRouteAllowed("android", "PUT", "/api/group-fold/import"), false);
  assert.equal(webRouteAllowed("android", "PUT", "/api/session-pin"), false);
});

test("a phone orders the Groups with POST /api/projects/order and cannot create, rename or delete one", () => {
  assert.equal(webRouteAllowed("android", "POST", "/api/projects/order"), true);
  assert.equal(webRouteAllowed("android", "GET", "/api/projects/order"), false);
  assert.equal(webRouteAllowed("android", "PUT", "/api/projects/order"), false);
  assert.equal(webRouteAllowed("android", "POST", "/api/projects"), false);
  assert.equal(webRouteAllowed("android", "PATCH", "/api/projects/abc"), false);
  assert.equal(webRouteAllowed("android", "DELETE", "/api/projects/abc"), false);
  assert.equal(webRouteAllowed("android", "POST", "/api/projects/order/x"), false);
  // The list read is the phone's already.
  assert.equal(webRouteAllowed("android", "GET", "/api/projects"), true);
});

test("a phone manages sessions with exactly the 16 routes the app's session management calls", () => {
  const allowed = [
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
  ];
  assert.equal(allowed.length, 16);
  for (const r of allowed) {
    const [method, path] = r.split(" ") as [string, string];
    assert.equal(webRouteAllowed("android", method, path), true, r);
    assert.equal(webRouteAllowed("desktop", method, path), true, `desktop ${r}`);
  }
});

test("a phone's session management stops at those routes: other methods, sibling paths and the web's other writes stay closed", () => {
  // The same path with another method.
  for (const [method, path] of [
    ["POST", "/api/session-candidates"], ["DELETE", "/api/trash"], ["GET", "/api/session-delete"], ["GET", "/api/session-rehome"],
    ["POST", "/api/session-name"], ["GET", "/api/session-name"], ["POST", "/api/session-chosen"],
    ["PUT", "/api/session-delete"], ["DELETE", "/api/session-delete"], ["GET", "/api/session-move"], ["PUT", "/api/session-move"],
    ["POST", "/api/session-units"], ["PUT", "/api/orphans/delete"], ["GET", "/api/orphans/delete"], ["GET", "/api/trash/restore"], ["GET", "/api/trash/purge"],
  ] as const) assert.equal(webRouteAllowed("android", method, path), false, `${method} ${path}`);
  // Paths that only look alike: a trailing slash, a longer name, another route of the same family.
  for (const path of ["/api/trash/", "/api/trash/empty", "/api/orphans/", "/api/session-units/", "/api/session-units/other", "/api/session-agents/stop", "/api/session-agents/resume", "/api/session-agents/output", "/api/session-agents/count", "/api/session-delete/", "/api/session-names"]) {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) assert.equal(webRouteAllowed("android", method, path), false, `${method} ${path}`);
  }
  // Writes that stay with the web: the project and sidebar arrangement and the native folder dialog.
  for (const [method, path] of [
    ["PUT", "/api/session-pin"], ["PUT", "/api/session-pins"], ["PUT", "/api/session-archive"], ["PUT", "/api/session-project"], ["PUT", "/api/session-order"],
    ["POST", "/api/fs-complete"], ["GET", "/api/fs-complete/"], ["GET", "/api/pick-folder"], ["POST", "/api/pick-folder"], ["POST", "/api/projects"],
  ] as const) assert.equal(webRouteAllowed("android", method, path), false, `${method} ${path}`);
});

test("a phone lists the subfolders of a typed path (the folder fields, 6y) and nothing else of the file system", () => {
  assert.equal(webRouteAllowed("android", "GET", "/api/fs-complete"), true);
  assert.equal(webRouteAllowed("desktop", "GET", "/api/fs-complete"), true);
  for (const path of ["/api/file", "/api/file/tree", "/api/file/raw", "/api/fs", "/api/fs-complete/x"]) {
    assert.equal(webRouteAllowed("android", "GET", path, new URLSearchParams({ path: "/etc/hosts" })), false, path);
  }
});

test("no web route hands a device token the APK: it comes through the device listener's own one-time link", () => {
  // /api/mobile/apk is the signed-in web's. /api/device/apk-link and /dl/apk/<token> are the device
  // listener's own routes (deviceServer.ts), decided before this table; a phone's token reaches
  // none of them through the web server's routes.
  for (const path of ["/api/mobile/apk", "/api/mobile/app", `/dl/apk/${"A".repeat(43)}`, "/api/device/apk-link"]) {
    for (const method of ["GET", "HEAD", "POST"]) assert.equal(webRouteAllowed("android", method, path), false, `android ${method} ${path}`);
  }
});
