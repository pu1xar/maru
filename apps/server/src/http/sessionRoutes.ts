// Session management routes (DESIGN.md 6, 6a). The contract, with every status, is listed in
// packages/shared/src/sessionManage.ts. server.ts hands each /api request here first; a request
// this module does not route goes back to it.
import type http from "node:http";
import { ManageError } from "../sessions/manage.ts";
import type { SessionManager } from "../sessions/manage.ts";

export interface JsonIo {
  /** Rejects a body without the JSON content type (415), a large one (413) or bad JSON (400). */
  readJson(req: http.IncomingMessage): Promise<unknown>;
  sendJson(res: http.ServerResponse, code: number, body: unknown): void;
}

/** Answers the request when it is a session management route; false otherwise. */
export async function handleSessionRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  manage: SessionManager,
  io: JsonIo,
): Promise<boolean> {
  const route = routeOf(req.method ?? "", url.pathname);
  if (route === null) return false;
  try {
    io.sendJson(res, 200, await route(manage, url.searchParams, () => io.readJson(req)));
  } catch (err) {
    if (!(err instanceof ManageError)) throw err;
    io.sendJson(res, err.status, { error: err.message });
  }
  return true;
}

type Route = (m: SessionManager, q: URLSearchParams, body: () => Promise<unknown>) => unknown;

const ROUTES: Record<string, Route> = {
  "POST /api/session-delete": async (m, _q, body) => m.deleteSession(await body()),
  "GET /api/trash": (m) => m.listTrash(),
  "POST /api/trash/restore": async (m, _q, body) => m.restoreTrash(await body()),
  "POST /api/trash/purge": async (m, _q, body) => m.purgeTrash(await body()),
  "GET /api/orphans": (m) => m.listOrphans(),
  "POST /api/orphans/delete": async (m, _q, body) => m.deleteOrphan(await body()),
  "GET /api/session-units": (m, q) => m.sessionUnits(q),
  "GET /api/session-units/all": (m) => m.allUnits(),
  "POST /api/session-units/delete": async (m, _q, body) => m.deleteUnit(await body()),
  "POST /api/session-move": async (m, _q, body) => m.move(await body()),
  "POST /api/session-rehome": async (m, _q, body) => m.rehome(await body()),
  "GET /api/session-resume-command": (m, q) => m.resumeCommand(q),
  "GET /api/fs-complete": (m, q) => m.fsComplete(q),
};

function routeOf(method: string, pathname: string): Route | null {
  return ROUTES[`${method} ${pathname}`] ?? null;
}
