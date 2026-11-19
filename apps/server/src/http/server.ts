import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  AccountInfo, ArchiveSession, AssignSession, ChooseSession, ClientMessage, CreateProject, ImportGroupFolds, SetGroupFolded, ListSessionsResponse, PinSession, PinSessions,
  PlaceSessions, RenameSession, ServerMessage, SessionCandidates, SessionMcpResponse, UpdateProject, UploadedAttachment,
} from "@maru/shared";
import type { VisibleIndex } from "../index/visible.ts";
import { ProjectError, type ProjectStore } from "../projects/store.ts";
import type { ChosenStore } from "../state/chosen.ts";
import { FoldError, type FoldedGroupStore } from "../state/foldedGroups.ts";
import type { ThreadListener, ThreadProvider } from "../threads/router.ts";
import { DriveError, type ClaudeRuns } from "../drive/claudeRuns.ts";
import type { CodexRuns } from "../drive/codexRuns.ts";
import type { PendingSends } from "../drive/pendingSends.ts";
import { RenameError, type SessionRenamer } from "../sessions/rename.ts";
import { SessionAgentsError } from "../claude/sessionAgents.ts";
import { AgentControlError, type SessionAgentControl } from "../drive/sessionAgentControl.ts";
import { isLocalRequest } from "../system/localRequest.ts";
import { PickFolderError, pickFolder } from "../system/pickFolder.ts";
import type { DeviceKind, ResumeSessionWorkflow, SessionHostStatus, SessionSummary, StopSessionAgent } from "@maru/shared";
import { FILE_RESPONSE_HEADERS, FileError, fileFetchAllowed, readFileViewWithLookup, sendRawFile } from "../files/fileView.ts";
import { listTreeDirectory } from "../files/fileTree.ts";
import { checkRequest, type GuardConfig } from "./guard.ts";
import type { UsageService } from "../usage/service.ts";
import type { SessionManager } from "../sessions/manage.ts";
import { handleSessionRoutes } from "./sessionRoutes.ts";
import { SessionCommandsError, type SessionCommands } from "../commands/sessionCommands.ts";
import { handleDeviceWebRoutes, type DeviceWebDeps } from "../devices/webRoutes.ts";
import type { DesktopBuilds } from "../desktop/builds.ts";
import type { ShellService } from "../shell/service.ts";
import type { AccountsService } from "../accounts/service.ts";
import type { SessionSearch } from "../search/sessionSearch.ts";
import { SHELL_SOCKET_PATH, validHave } from "@maru/shared";
import type { MainRoutes } from "../devices/deviceServer.ts";
import type { Duplex } from "node:stream";
import { AttachmentError, publicView, type AttachmentStore, type StoredAttachment } from "../attachments/store.ts";
import { readTranscriptBlob } from "../attachments/transcriptBlob.ts";
import { claudeContent } from "../attachments/message.ts";
import type { UserContent } from "../claude/driver.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/** /ws ping interval (ServerOptions.wsPingMs). */
const WS_PING_MS = 30_000;

/** Request bodies here are small JSON commands; larger ones are rejected, not truncated. */
const MAX_BODY = 1024 * 1024;

export interface ServerOptions {
  /** The chosen sessions (DESIGN.md 6d); the rest of the scan only answers candidate searches. */
  view: VisibleIndex;
  projects: ProjectStore;
  chosen: ChosenStore;
  /** The folded sidebar folders (DESIGN.md 6v): PUT /api/group-fold, and `foldedGroups` in hello and by broadcast. */
  folds?: FoldedGroupStore;
  /** Conversation threads (DESIGN.md 6b). Without it, thread.subscribe answers with an error. */
  threads?: ThreadProvider;
  /** Claude sessions this server drives (M2). Without it, drive commands answer with an error. */
  runs?: ClaudeRuns;
  /** Codex threads this server drives (M2). Without it, Codex drive commands answer with an error. */
  codexRuns?: CodexRuns;
  /** Messages sent that the model has not taken in yet (DESIGN.md 4.4): session.queued and thread.recall. */
  pendingSends?: PendingSends;
  /** Accounts a new session can run under. */
  accounts?: AccountInfo[];
  /** Session rename (DESIGN.md 6). Without it, PUT /api/session-name answers with an error. */
  renamer?: Pick<SessionRenamer, "rename">;
  /** Locks, deletion and the trash, orphans, units, moves, rehome (sessionRoutes.ts). */
  manage?: SessionManager;
  /**
   * Subagents and workflows of a session with their actions, and the actions (DESIGN.md 6e, 6i):
   * GET /api/session-agents, /count and /output, POST /api/session-agents/stop and /resume.
   */
  sessionAgents?: Pick<SessionAgentControl, "listAll" | "taskOutput" | "count" | "stop" | "resume">;
  /** Usage gauges (DESIGN.md 6a): /api/usage, /api/data, the Claude machine API, and /ws `usage`. */
  usage?: Pick<UsageService, "handle" | "attach">;
  /** The dashboard's work list (dashboard/work.ts): GET /api/dashboard/work. */
  dashboard?: { handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean };
  /** The composer's `/` menu and model picker: GET /api/session-commands, /api/session-models. */
  commands?: Pick<SessionCommands, "list" | "models">;
  /** The Claude session host's state (DESIGN.md 2b), sent after hello; changes go out by broadcast. */
  sessionHost?: () => SessionHostStatus;
  guard: GuardConfig;
  /**
   * How often /ws sockets are pinged; a socket that has not answered the previous ping by the next
   * one is closed. Default 30 s (WS_PING_MS).
   */
  wsPingMs?: number;
  /** Built web UI (apps/web/dist). Served with SPA fallback when it exists. */
  webDir: string;
  /** Paired devices and the Android app (DESIGN.md 2d): the 기기 tab's routes (devices/webRoutes.ts). */
  devices?: DeviceWebDeps;
  /** The desktop app's build this release serves (DESIGN.md 2e): /api/desktop/*. */
  desktop?: Pick<DesktopBuilds, "handle">;
  /** Uploaded attachments (DESIGN.md 6n): /api/attachments, and `thread.send` attachments. */
  attachments?: AttachmentStore;
  /** Folders whose `.jsonl` files GET /api/file/blob may read: the Claude accounts' `projects`. Without it the route refuses. */
  transcriptRoots?: readonly string[];
  /** This server's version (system/version.ts, DESIGN.md 2c), in the /ws hello and /healthz. */
  version?: string | null;
  /** Rewind (DESIGN.md 6o): GET and POST /api/session-rewind (drive/sessionRewind.ts). */
  rewind?: { handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, io: { readJson: typeof readJson; sendJson: typeof sendJson }): Promise<boolean> };
  /** Fork from a message (DESIGN.md 6q): POST /api/session-fork (drive/sessionFork.ts). */
  fork?: { handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, io: { readJson: typeof readJson; sendJson: typeof sendJson }): Promise<boolean> };
  /**
   * Shell terminals (DESIGN.md 6s): /api/shells, and the view socket at SHELL_SOCKET_PATH behind the
   * same browser guard as /ws.
   */
  shells?: Pick<ShellService, "handle" | "attach">;
  /** Search over every session's conversation (DESIGN.md 6u): GET /api/search. */
  search?: Pick<SessionSearch, "search">;
  /** The accounts screen's routes (DESIGN.md 6y): /api/accounts/status, POST /api/accounts, /api/accounts/<id>, /api/settings/claude-usage, /api/settings/codex-usage. */
  accountSettings?: Pick<AccountsService, "handle">;
}

export function createServer(opts: ServerOptions): http.Server & { broadcast(msg: ServerMessage): void } & MainRoutes {
  const { view, projects, chosen, folds, threads, runs, renamer, guard, webDir } = opts;
  const version = opts.version ?? null;

  const server = http.createServer((req, res) => {
    const denied = checkRequest(req, guard);
    if (denied) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end(denied);
      return;
    }
    route(req, res);
  });
  // Node ends any request still arriving after 300 s (requestTimeout) with 408, which would cut a
  // large upload on a slow link (DESIGN.md 6n). The listener is loopback only, behind a reverse proxy and the
  // sign-in, so there is no total time cap; headersTimeout (60 s) still bounds a request's headers.
  server.requestTimeout = 0;

  // Everything after the browser guard. The device listener (devices/deviceServer.ts) calls this
  // directly for the reads a device may make, once it has checked the device's token.
  function route(req: http.IncomingMessage, res: http.ServerResponse, device?: DeviceCaller): void {
    const url = new URL(req.url || "/", "http://local");
    if (url.pathname.startsWith("/api/")) {
      handleApi(req, res, url, device).catch((err: unknown) => {
        if (err instanceof ProjectError) return sendJson(res, err.status, { error: err.message });
        if (err instanceof BodyError) return sendJson(res, err.status, { error: err.message });
        if (err instanceof RenameError) return sendJson(res, err.status, { error: err.message });
        if (err instanceof FileError) return sendJson(res, err.status, { error: err.message, ...(err.detail ? { detail: err.detail } : {}) });
        if (err instanceof SessionAgentsError) return sendJson(res, err.status, { error: err.message });
        if (err instanceof AgentControlError) return sendJson(res, err.status, { error: err.message });
        if (err instanceof PickFolderError) return sendJson(res, err.status, { error: err.message });
        if (err instanceof SessionCommandsError) return sendJson(res, err.status, { error: err.message });
        if (err instanceof AttachmentError) return sendJson(res, err.status, { error: err.message });
        console.error("api error", err);
        sendJson(res, 500, { error: "internal error" });
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, { ok: true, version, sessions: view.snapshot().length, chosen: chosen.count() });
    }
    serveStatic(webDir, url.pathname, res);
  }

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, device?: DeviceCaller): Promise<void> {
    const m = req.method;
    const p = url.pathname;
    if (opts.usage?.handle(req, res, url)) return;
    if (opts.dashboard?.handle(req, res, url)) return;
    if (opts.devices && (await handleDeviceWebRoutes(req, res, url, opts.devices, sendJson))) return;
    if (opts.desktop?.handle(req, res, url)) return;
    if (opts.manage && (await handleSessionRoutes(req, res, url, opts.manage, { readJson, sendJson }))) return;
    if (opts.rewind && (await opts.rewind.handle(req, res, url, { readJson, sendJson }))) return;
    if (opts.fork && (await opts.fork.handle(req, res, url, { readJson, sendJson }))) return;
    if (opts.shells && (await opts.shells.handle(req, res, url, { readJson, sendJson }))) return;
    if (opts.accountSettings && (await opts.accountSettings.handle(req, res, url, { readJson, sendJson }))) return;
    if (m === "GET" && p === "/api/sessions") {
      const body: ListSessionsResponse = { sessions: view.snapshot(), generatedAt: Date.now() };
      return sendJson(res, 200, body);
    }
    if (m === "GET" && p === "/api/session-candidates") {
      // offset/limit page the answer for the picker; every match stays reachable by paging.
      const all = view.candidates(url.searchParams.get("q") ?? "");
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const limit = Math.max(1, Number(url.searchParams.get("limit")) || 50);
      const body: SessionCandidates = { sessions: all.slice(offset, offset + limit), total: all.length, offset };
      return sendJson(res, 200, body);
    }
    if (m === "GET" && p === "/api/search") {
      // Every session's conversation (DESIGN.md 6u); offset/limit page the hits, newest first.
      if (!opts.search) return sendJson(res, 503, { error: "Conversation search is disabled" });
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const limit = Math.max(1, Number(url.searchParams.get("limit")) || 50);
      return sendJson(res, 200, await opts.search.search(url.searchParams.get("q") ?? "", { offset, limit }));
    }
    if (m === "GET" && p === "/api/pick-folder") {
      // Whether this request may use the Finder dialog: on macOS and from this Mac itself (DESIGN.md 6z).
      return sendJson(res, 200, { available: process.platform === "darwin" && isLocalRequest(req.socket.remoteAddress, req.headers) });
    }
    if (m === "POST" && p === "/api/pick-folder") {
      // Opens the Mac's folder dialog and answers when the user chose or cancelled (DESIGN.md 6f).
      // The dialog opens on the Mac's own screen, so a request forwarded from elsewhere is refused (6y).
      if (!isLocalRequest(req.socket.remoteAddress, req.headers)) return sendJson(res, 403, { error: "The Finder dialog opens on the Mac itself" });
      const body = (await readJson(req)) as { defaultPath?: string | null };
      return sendJson(res, 200, await pickFolder({ defaultPath: body.defaultPath ?? null }));
    }
    if (m === "GET" && p === "/api/session-commands") {
      if (!opts.commands) return sendJson(res, 503, { error: "Command list is disabled" });
      const q = url.searchParams;
      return sendJson(res, 200, await opts.commands.list(q.get("key") ?? "", { refresh: q.get("refresh") === "1" }));
    }
    if (m === "GET" && p === "/api/session-models") {
      if (!opts.commands) return sendJson(res, 503, { error: "Model list is disabled" });
      return sendJson(res, 200, await opts.commands.models(url.searchParams.get("key") ?? ""));
    }
    if (m === "GET" && p === "/api/session-mcp") {
      const key = url.searchParams.get("key") ?? "";
      if (!runs || !runs.handles(key)) return sendJson(res, 400, { error: "Only Claude sessions have an MCP server list" });
      try {
        const body: SessionMcpResponse = { key, servers: await runs.mcpServers(key) };
        return sendJson(res, 200, body);
      } catch (err) {
        return sendJson(res, err instanceof DriveError ? 409 : 502, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (m === "GET" && p === "/api/session-agents") {
      if (!opts.sessionAgents) return sendJson(res, 503, { error: "Subagent list is disabled" });
      const { agents, warnings } = await opts.sessionAgents.listAll(url.searchParams.get("key") ?? "");
      return sendJson(res, 200, warnings.length ? { agents, warnings } : { agents });
    }
    if (m === "GET" && p === "/api/session-agents/output") {
      if (!opts.sessionAgents) return sendJson(res, 503, { error: "Background task list is disabled" });
      const q = url.searchParams;
      return sendJson(res, 200, await opts.sessionAgents.taskOutput(q.get("key") ?? "", q.get("kind") ?? "", q.get("id") ?? ""));
    }
    if (m === "GET" && p === "/api/session-agents/count") {
      if (!opts.sessionAgents) return sendJson(res, 503, { error: "Subagent list is disabled" });
      return sendJson(res, 200, { running: await opts.sessionAgents.count(url.searchParams.get("key") ?? "") });
    }
    if (m === "POST" && p === "/api/session-agents/stop") {
      if (!opts.sessionAgents) return sendJson(res, 503, { error: "Subagent control is disabled" });
      await opts.sessionAgents.stop((await readJson(req)) as StopSessionAgent);
      return sendJson(res, 200, { ok: true });
    }
    if (m === "POST" && p === "/api/session-agents/resume") {
      if (!opts.sessionAgents) return sendJson(res, 503, { error: "Subagent control is disabled" });
      return sendJson(res, 200, await opts.sessionAgents.resume((await readJson(req)) as ResumeSessionWorkflow));
    }
    if (p === "/api/attachments" || p.startsWith("/api/attachments/")) return handleAttachments(req, res, url, device);
    if (
      (m === "GET" || m === "HEAD") &&
      (p === "/api/file" || p === "/api/file/raw" || p === "/api/file/blob" || p === "/api/file/tree")
    ) {
      // File bytes and folder listings go only to this app's own pages (DESIGN.md 6e).
      if (!fileFetchAllowed(req)) return sendJson(res, 403, { error: "File request from another page" });
      if (p === "/api/file/raw") return sendRawFile(req, res, url.searchParams.get("path"));
      if (p === "/api/file/blob") {
        // An image a transcript line carries inline (DESIGN.md 6n), decoded.
        const q = url.searchParams;
        const blob = readTranscriptBlob(q.get("path"), q.get("offset"), q.get("pointer"), opts.transcriptRoots ?? []);
        res.writeHead(200, { ...FILE_RESPONSE_HEADERS, "content-type": blob.mime, "content-length": blob.bytes.length, "content-security-policy": "sandbox" });
        res.end(m === "HEAD" ? undefined : blob.bytes);
        return;
      }
      const q = url.searchParams;
      const body =
        p === "/api/file/tree"
          ? await listTreeDirectory(q.get("root"), q.get("dir"))
          : await readFileViewWithLookup(q.get("path"), q.get("offset"), q.get("lookup"), q.get("root"));
      res.writeHead(200, { ...FILE_RESPONSE_HEADERS, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
      return;
    }
    if (m === "GET" && p === "/api/session") {
      // One session by key, on the list or not (a session opened from the settings' full list), or
      // by its bare id, which the address carries (any provider and account; the listed one first).
      const key = url.searchParams.get("key");
      const id = url.searchParams.get("id");
      const match = key !== null ? (x: SessionSummary) => x.key === key : (x: SessionSummary) => x.id === (id ?? "");
      const session = view.snapshot().find(match) ?? view.candidates("").find(match);
      return session ? sendJson(res, 200, { session }) : sendJson(res, 404, { error: `Session not found: ${key ?? id ?? ""}` });
    }
    if (m === "GET" && p === "/api/projects") return sendJson(res, 200, { projects: projects.list() });
    if (m === "GET" && p === "/api/accounts") return sendJson(res, 200, { accounts: opts.accounts ?? [] });
    if (m === "POST" && p === "/api/projects") {
      const body = (await readJson(req)) as CreateProject;
      return sendJson(res, 200, { project: projects.create(body) });
    }
    if (m === "POST" && p === "/api/projects/order") {
      const body = (await readJson(req)) as { ids?: unknown };
      if (!Array.isArray(body.ids) || !body.ids.every((x) => typeof x === "string")) {
        return sendJson(res, 400, { error: "ids must be a string array" });
      }
      return sendJson(res, 200, { projects: projects.reorder(body.ids as string[]) });
    }
    const pm = /^\/api\/projects\/([^/]+)$/.exec(p);
    if (pm && m === "PATCH") {
      const body = (await readJson(req)) as UpdateProject;
      return sendJson(res, 200, { project: projects.update(decodeURIComponent(pm[1]!), body) });
    }
    if (pm && m === "DELETE") {
      projects.remove(decodeURIComponent(pm[1]!));
      return sendJson(res, 200, { ok: true });
    }
    if (m === "PUT" && p === "/api/session-order") {
      const body = (await readJson(req)) as PlaceSessions;
      projects.placeSessions(body.projectId ?? null, body.keys);
      return sendJson(res, 200, { ok: true });
    }
    if (m === "PUT" && p === "/api/session-pin") {
      const body = (await readJson(req)) as PinSession;
      projects.pin(body.provider, body.id, body.pinned);
      return sendJson(res, 200, { ok: true });
    }
    if (m === "PUT" && p === "/api/session-pins") {
      const body = (await readJson(req)) as PinSessions;
      projects.pinSessions(body.keys);
      return sendJson(res, 200, { ok: true });
    }
    if (m === "PUT" && p === "/api/session-archive") {
      const body = (await readJson(req)) as ArchiveSession;
      projects.archive(body.provider, body.id, body.archived);
      return sendJson(res, 200, { ok: true });
    }
    if (m === "PUT" && p === "/api/session-project") {
      const body = (await readJson(req)) as AssignSession;
      projects.assign(body.provider, body.id, body.projectId ?? null);
      return sendJson(res, 200, { ok: true });
    }
    if (m === "PUT" && p === "/api/session-chosen") {
      const body = (await readJson(req)) as ChooseSession;
      if ((body.provider !== "claude" && body.provider !== "codex") || typeof body.id !== "string" || !body.id
        || typeof body.chosen !== "boolean") {
        return sendJson(res, 400, { error: "provider, id and chosen are required" });
      }
      chosen.set(body.provider, body.id, body.chosen);
      return sendJson(res, 200, { ok: true });
    }
    if (p === "/api/group-fold" || p === "/api/group-fold/import") {
      if (!folds) return sendJson(res, 503, { error: "Saving folded folders is disabled" });
      try {
        if (m === "PUT" && p === "/api/group-fold") {
          const body = (await readJson(req)) as SetGroupFolded;
          folds.set(body.key, body.folded);
          return sendJson(res, 200, { ok: true });
        }
        if (m === "POST" && p === "/api/group-fold/import") {
          const body = (await readJson(req)) as ImportGroupFolds;
          if (!Array.isArray(body.keys)) return sendJson(res, 400, { error: "keys must be a list" });
          const imported = folds.importOnce(body.keys);
          return sendJson(res, 200, { imported, keys: folds.keys() });
        }
      } catch (err) {
        if (err instanceof FoldError) return sendJson(res, err.status, { error: err.message });
        throw err;
      }
    }
    if (m === "PUT" && p === "/api/session-name") {
      if (!renamer) return sendJson(res, 503, { error: "Renaming is disabled" });
      const body = (await readJson(req)) as RenameSession;
      return sendJson(res, 200, await renamer.rename(body));
    }
    sendJson(res, 404, { error: "not found" });
  }

  /**
   * Uploads (DESIGN.md 6n). POST /api/attachments?name= takes the file's bytes as the body, streamed
   * to disk without a size cap, and answers UploadedAttachment. GET /api/attachments/<id> returns the
   * stored bytes, /image the picture the model gets; both only to this app's pages, as /api/file.
   */
  async function handleAttachments(req: http.IncomingMessage, res: http.ServerResponse, url: URL, device?: DeviceCaller): Promise<void> {
    const store = opts.attachments;
    if (!store) return sendJson(res, 503, { error: "Attachments are disabled" });
    if (req.method === "POST" && url.pathname === "/api/attachments") {
      const name = url.searchParams.get("name");
      if (!name) return sendJson(res, 400, { error: "name is required" });
      return sendJson(res, 200, await store.save(req, name, String(req.headers["content-type"] ?? ""), device?.id));
    }
    const m = /^\/api\/attachments\/([^/]+)(\/image|\/meta)?$/.exec(url.pathname);
    if (!m || (req.method !== "GET" && req.method !== "HEAD")) return sendJson(res, 404, { error: "not found" });
    if (!fileFetchAllowed(req)) return sendJson(res, 403, { error: "File request from another page" });
    let id: string;
    try {
      id = decodeURIComponent(m[1]!);
    } catch {
      return sendJson(res, 400, { error: "Invalid attachment id" });
    }
    const a = store.get(id);
    if (m[2] === "/meta") return sendJson(res, 200, publicView(a));
    const file = m[2] === "/image" ? a.imagePath : a.path;
    const mime = m[2] === "/image" ? a.imageMime : a.mimeType;
    if (!file || !mime) return sendJson(res, 404, { error: "This attachment has no image to send to the model" });
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return sendJson(res, 404, { error: `Attachment file is missing: ${file}` });
    }
    // The type is the browser's word for most files, so nothing an upload holds may run as this
    // origin's page: every answer is sandboxed, and anything but the four model picture types
    // downloads instead of rendering (an XHTML file could otherwise run script and drive /ws).
    const picture = /^image\/(png|jpeg|gif|webp)$/.test(mime);
    res.writeHead(200, {
      ...FILE_RESPONSE_HEADERS,
      "content-type": mime,
      "content-length": size,
      "content-security-policy": "sandbox",
      ...(picture ? {} : { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}` }),
    });
    if (req.method === "HEAD" || size === 0) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  // A peer that went away without closing (a phone that lost its network, then went to the
  // background) leaves a half-open socket that would keep counting as an open /ws: the device
  // listener would take that app as on the screen and hold its pushes back (DESIGN.md 2d). So every
  // socket is pinged, and one that did not answer the previous ping by the next is terminated; the
  // client's own reconnect takes it from there. Browsers and OkHttp (the Android app) answer pings
  // by themselves. The 30 s also stays under the 100 s after which many proxies close an idle WebSocket.
  const unanswered = new Set<WebSocket>();
  const pinger = setInterval(() => {
    for (const ws of clients) {
      if (unanswered.has(ws)) {
        ws.terminate();
        continue;
      }
      if (ws.readyState !== ws.OPEN) continue;
      unanswered.add(ws);
      ws.ping();
    }
  }, opts.wsPingMs ?? WS_PING_MS);
  pinger.unref();
  server.on("close", () => clearInterval(pinger));
  // A shell view's socket (DESIGN.md 6s) passes the same guard as /ws.
  const shellWss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://local");
    const shell = url.pathname === SHELL_SOCKET_PATH && opts.shells !== undefined;
    if ((url.pathname !== "/ws" && !shell) || checkRequest(req, guard)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    if (shell) shellWss.handleUpgrade(req, socket, head, (ws) => opts.shells!.attach(ws, url.searchParams));
    else wss.handleUpgrade(req, socket, head, (ws) => onClient(ws));
  });

  /** `device`: the kind of paired device whose listener the connection came through (DESIGN.md 2d, 2e), or null for the web. */
  function onClient(ws: WebSocket, from: DriveSource = { device: null }): void {
    clients.add(ws);
    ws.on("pong", () => unanswered.delete(ws));
    send(ws, { type: "hello", sessions: view.snapshot(), projects: projects.list(), ...(folds ? { foldedGroups: folds.keys() } : {}), version, serverTime: Date.now() });
    if (opts.sessionHost) send(ws, { type: "sessionHost", status: opts.sessionHost() });
    for (const p of [...(runs?.allPending() ?? []), ...(opts.codexRuns?.allPending() ?? [])]) {
      send(ws, { type: "session.pending", key: p.key, questions: p.questions });
    }
    for (const f of runs?.allForeground() ?? []) send(ws, { type: "session.foreground", key: f.key, toolUseIds: f.toolUseIds });
    for (const p of opts.pendingSends?.all() ?? []) send(ws, { type: "session.queued", key: p.key, sends: p.sends });
    const off = view.subscribe((event) => send(ws, { type: "index", event }));
    const offUsage = opts.usage?.attach((data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    });
    // threadId -> the subscription's listener and unsubscribe (null until the subscribe resolves).
    const subs = new Map<string, { listener: ThreadListener; off: (() => void) | null }>();
    const unsubscribe = (threadId: string) => {
      const s = subs.get(threadId);
      subs.delete(threadId);
      s?.off?.();
    };
    ws.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type === "thread.subscribe") {
        const threadId = msg.threadId;
        if (subs.has(threadId)) return;
        if (!threads || !threads.handles(threadId)) {
          send(ws, { type: "thread.error", threadId, error: "Conversation view is not supported for this session yet" });
          return;
        }
        const entry: { listener: ThreadListener; off: (() => void) | null } = {
          listener: (m) => {
            if (m.snapshot) send(ws, { type: "thread.snapshot", snapshot: m.snapshot });
            if (m.older) send(ws, { type: "thread.older", older: m.older });
            if (m.resumed) send(ws, { type: "thread.resumed", resumed: m.resumed });
            if (m.events) send(ws, { type: "thread.events", threadId, events: m.events });
            if (m.error) send(ws, { type: "thread.error", threadId, error: m.error });
          },
          off: null,
        };
        subs.set(threadId, entry);
        const pageSize = positiveInt(msg.pageSize);
        const rows = positiveInt(msg.rows);
        threads
          .subscribe(threadId, entry.listener, {
            ...(pageSize ? { pageSize } : {}), ...(rows ? { rows } : {}), ...(rows && validHave(msg.have) ? { have: msg.have } : {}),
          })
          .then(
            (u) => {
              // Unsubscribed (or the socket closed) while opening: release right away.
              if (subs.get(threadId) === entry) entry.off = u;
              else u();
            },
            (err: unknown) => {
              if (subs.get(threadId) === entry) subs.delete(threadId);
              send(ws, { type: "thread.error", threadId, error: err instanceof Error ? err.message : String(err) });
            },
          );
      } else if (msg.type === "thread.send" || msg.type === "thread.interrupt" || msg.type === "thread.background" || msg.type === "thread.sendNow" || msg.type === "thread.answer"
        || msg.type === "thread.close" || msg.type === "thread.setPermissionMode" || msg.type === "thread.configure"
        || msg.type === "session.create" || msg.type === "thread.recall") {
        void drive(ws, msg, from);
      } else if (msg.type === "thread.unsubscribe") {
        unsubscribe(msg.threadId);
      } else if (msg.type === "thread.loadOlder") {
        const entry = subs.get(msg.threadId);
        if (!threads || !entry?.off) return;
        const threadId = msg.threadId;
        const until = typeof msg.until === "string" && msg.until !== "" ? msg.until : undefined;
        threads.loadOlder(threadId, entry.listener, positiveInt(msg.rows), until).catch((err: unknown) =>
          send(ws, { type: "thread.error", threadId, error: err instanceof Error ? err.message : String(err) }));
      } else if (msg.type === "thread.search") {
        // A find answers on this socket only, for a thread it subscribes to (DESIGN.md 6u).
        const threadId = msg.threadId;
        const reqId = typeof msg.reqId === "string" ? msg.reqId : "";
        const query = typeof msg.query === "string" ? msg.query : "";
        const failed = (error: string) =>
          send(ws, { type: "thread.searchResult", result: { threadId, reqId, query, idPrefix: "", matches: [], total: 0, searched: 0, error } });
        if (!threads || !subs.get(threadId)?.off) {
          failed("Not an open conversation");
          return;
        }
        threads.search(threadId, query, reqId).then(
          (result) => send(ws, { type: "thread.searchResult", result }),
          (err: unknown) => failed(err instanceof Error ? err.message : String(err)),
        );
      }
    });
    const done = () => {
      off();
      offUsage?.();
      for (const id of [...subs.keys()]) unsubscribe(id);
      clients.delete(ws);
      unanswered.delete(ws);
    };
    ws.on("close", done);
    ws.on("error", done);
  }

  async function drive(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "thread.send" | "thread.interrupt" | "thread.background" | "thread.sendNow" | "thread.answer" | "thread.close" | "thread.setPermissionMode" | "thread.configure" | "session.create" | "thread.recall" }>,
    from: DriveSource,
  ): Promise<void> {
    const threadId = msg.type === "session.create" ? undefined : msg.threadId;
    const reqId = msg.reqId;
    // What a refused thread.send did not send, for the composer to put back (command.error unsent).
    let unsent: { unsent?: string; unsentAttachments?: UploadedAttachment[] } = {};
    try {
      if (msg.type === "session.create") {
        const creator = msg.provider === "claude" ? runs : msg.provider === "codex" ? opts.codexRuns : undefined;
        if (!creator) throw new DriveError("Session control is disabled");
        const name = typeof msg.name === "string" ? msg.name.trim() : "";
        let nameError: string | undefined;
        const key = await creator.create({
          account: msg.account, cwd: msg.cwd, prompt: msg.prompt, projectId: msg.projectId,
          ...(msg.model ? { model: msg.model } : {}),
          ...(name ? { name, nameFailed: (m: string) => { nameError = m; } } : {}),
        });
        send(ws, { type: "session.created", reqId: msg.reqId, key, ...(nameError ? { nameError } : {}) });
        return;
      }
      if (msg.type === "thread.send" && typeof msg.text === "string" && msg.text.trim()) unsent = { unsent: msg.text };
      const driver = [runs, opts.codexRuns].find((r) => r?.handles(msg.threadId));
      if (!driver) throw new DriveError("Sending is not supported for this session yet");
      if (msg.type === "thread.send") {
        const ids = Array.isArray(msg.attachments) ? msg.attachments : [];
        // A phone uploads through its own listener (POST /api/attachments, stored with its device id)
        // and sends only what it uploaded: an upload id is a path on this Mac (DESIGN.md 6n). The
        // desktop app uploads and sends as the web does (DESIGN.md 2e).
        const phoneOwns = (a: StoredAttachment) => from.device !== "android" || (from.deviceId !== undefined && a.deviceId === from.deviceId);
        if (ids.length > 0 && !opts.attachments) throw new DriveError("Attachments are disabled");
        // Every id is looked up first, so a refusal still gives back the ones that exist.
        const attachments: StoredAttachment[] = [];
        let missing: string | null = null;
        for (const id of ids) {
          try {
            const a = opts.attachments!.get(String(id));
            // A phone is told nothing about uploads that are not its own: same answer as a missing one.
            if (!phoneOwns(a)) throw new AttachmentError(404, `Attachment not found: ${String(id)}`);
            attachments.push(a);
          } catch (err) {
            missing ??= err instanceof Error ? err.message : String(err);
          }
        }
        if (attachments.length > 0) unsent.unsentAttachments = attachments.map(publicView);
        if (missing) throw new DriveError(missing);
        const text = typeof msg.text === "string" ? msg.text : "";
        // The message waits in session.queued from here until the model has it (DESIGN.md 4.4). A send
        // the server refuses goes back to the composer through command.error unsent instead, so its
        // row goes: one way back, not two.
        const pending = text.trim() || attachments.length > 0 ? opts.pendingSends : undefined;
        const sendId = randomUUID();
        pending?.sent(msg.threadId, sendId, text, attachments.map(publicView));
        let result: Awaited<ReturnType<typeof driver.send>>;
        try {
          result = await driver.send(msg.threadId, text, attachments, sendId);
        } catch (err) {
          pending?.apply(msg.threadId, { kind: "done", id: sendId });
          throw err;
        }
        // A slash command the server ran itself answers the sender with its result.
        if (result) {
          pending?.apply(msg.threadId, { kind: "done", id: sendId });
          send(ws, { type: "command.result", ...(reqId ? { reqId } : {}), threadId: msg.threadId, ...result });
        } else {
          pending?.apply(msg.threadId, { kind: "queued", id: sendId });
        }
      }
      else if (msg.type === "thread.recall") {
        if (!opts.pendingSends) throw new DriveError("Take back is disabled");
        const ids = Array.isArray(msg.ids) ? msg.ids.filter((x): x is string => typeof x === "string") : [];
        const key = msg.threadId;
        const res = await opts.pendingSends.recall(key, ids, (id) => (runs?.handles(key) ? runs.cancelQueued(key, id) : Promise.resolve(false)));
        send(ws, { type: "thread.recalled", ...(reqId ? { reqId } : {}), threadId: key, messages: res.messages });
        if (res.errors.length) send(ws, { type: "command.error", ...(reqId ? { reqId } : {}), threadId: key, error: res.errors.join("\n") });
      }
      else if (msg.type === "thread.configure") {
        const { type: _type, threadId: _thread, reqId: _req, ...change } = msg;
        const result = await driver.configure(msg.threadId, change);
        send(ws, { type: "command.result", ...(reqId ? { reqId } : {}), threadId: msg.threadId, ...result });
      }
      else if (msg.type === "thread.interrupt") await driver.interrupt(msg.threadId);
      else if (msg.type === "thread.background") {
        // The Codex app-server has no call that moves a running command to the background (its
        // background terminals can be listed and cleaned, not entered).
        if (!runs || driver !== runs) throw new DriveError("Codex sessions cannot send foreground work to background (app-server has no such request)");
        const toolUseId = typeof msg.toolUseId === "string" && msg.toolUseId ? msg.toolUseId : undefined;
        const notice = await runs.backgroundTasks(msg.threadId, toolUseId);
        send(ws, { type: "command.result", ...(reqId ? { reqId } : {}), threadId: msg.threadId, command: "background", notice });
      }
      else if (msg.type === "thread.sendNow") {
        // Codex puts a sent message into the running turn at once (turn/steer), so no message waits
        // for a tool boundary there and there is nothing to send now.
        if (!runs || driver !== runs) throw new DriveError("Codex sessions have no waiting messages to send now (a sent message steers the running turn at once)");
        if (!opts.pendingSends) throw new DriveError("Send now is disabled");
        // Only a message the CLI queues (state queued) can be taken out; one still being handed over
        // (sending) lands in the CLI's queue as it is. Each one's content is built again from what the
        // send stored, and a message whose upload is gone stays queued (content null).
        const key = msg.threadId;
        const pending = opts.pendingSends;
        const messages = pending.stored(key).filter((s) => s.state === "queued").map((s) => {
          let content: UserContent | null = null;
          try {
            const stored = s.attachments.map((a) => {
              if (!opts.attachments) throw new AttachmentError(404, "Attachments are disabled");
              return opts.attachments.get(a.id);
            });
            content = claudeContent(s.text, stored, (a) => fs.readFileSync(a.imagePath!));
          } catch (err) {
            console.error(`send now: ${key} message ${s.id} cannot be sent again`, err);
          }
          return { id: s.id, content };
        });
        const res = await runs.sendNow(key, messages, {
          replacing: (from, to) => pending.replacing(key, from, to),
          kept: (from) => pending.kept(key, from),
          replaced: (from, to) => pending.replaced(key, from, to),
          handed: (to) => pending.apply(key, { kind: "queued", id: to }),
          lost: (to, error) => pending.apply(key, { kind: "failed", id: to, error: `Not sent again: ${error}` }),
        });
        send(ws, {
          type: "command.result", ...(reqId ? { reqId } : {}), threadId: msg.threadId, command: "sendNow", notice: res.notice,
          sendNow: { outcome: res.outcome, moved: res.moved, sent: res.sent },
        });
      }
      else if (msg.type === "thread.close") await driver.close(msg.threadId);
      else if (msg.type === "thread.setPermissionMode") {
        // The mode reaches the subscribers as the thread's state.permissionMode (ClaudeRuns.turnInfo).
        if (!runs || driver !== runs) throw new DriveError("Codex sessions have no permission mode");
        await runs.setPermissionMode(msg.threadId, msg.mode);
      }
      else driver.answer(msg.threadId, msg.requestId, msg.answers);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      send(ws, { type: "command.error", ...(reqId ? { reqId } : {}), ...(threadId ? { threadId } : {}), error, ...unsent });
    }
  }

  projects.onChange((c) => {
    if (c.kind !== "projects") return;
    const msg: ServerMessage = { type: "projects", projects: projects.list() };
    for (const ws of clients) send(ws, msg);
  });

  folds?.onChange((keys) => {
    const msg: ServerMessage = { type: "foldedGroups", keys };
    for (const ws of clients) send(ws, msg);
  });

  return Object.assign(server, {
    broadcast(msg: ServerMessage): void {
      for (const ws of clients) send(ws, msg);
    },
    // For the device listener, which checks a device token instead of the browser guard (DESIGN.md 2d).
    serveRequest: route,
    serveUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, kind: DeviceKind, deviceId?: string): void {
      const url = new URL(req.url || "/", "http://local");
      if (url.pathname === SHELL_SOCKET_PATH) {
        // The device listener lets a desktop and an Android token this far (devices/access.ts upgradeAllowed).
        if (!opts.shells) {
          socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        shellWss.handleUpgrade(req, socket, head, (ws) => opts.shells!.attach(ws, url.searchParams));
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => onClient(ws, { device: kind, ...(deviceId ? { deviceId } : {}) }));
    },
  });
}

/** The paired device a request or socket came through the device listener from (devices/deviceServer.ts). */
export interface DeviceCaller {
  id: string;
  kind: DeviceKind;
}

/** Where a drive command came from: the web (device null) or a paired device's connection. */
interface DriveSource {
  device: DeviceKind | null;
  deviceId?: string;
}

class BodyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"] || "";
  if (!type.includes("application/json")) throw new BodyError(415, "content-type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BodyError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new BodyError(400, "invalid JSON");
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

function serveStatic(root: string, pathname: string, res: http.ServerResponse): void {
  // A malformed escape (`/%E0`) would throw out of the request handler and end the process.
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const rel = path.normalize(decoded).replace(/^([/\\])+/, "");
  let file = path.join(root, rel);
  if (!file.startsWith(root + path.sep) && file !== root) {
    res.writeHead(400).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(root, "index.html");   // SPA fallback
  }
  if (!fs.existsSync(file)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" })
      .end("web UI is not built: run `pnpm build:web` (or use `pnpm dev:web`)");
    return;
  }
  const ext = path.extname(file);
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(file).pipe(res);
}

/** A client's count field: a positive safe integer, else undefined (the default applies). */
function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
