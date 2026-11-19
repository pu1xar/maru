import type { IncomingMessage } from "node:http";

/**
 * Request gate for a server that will drive agents with every permission bypassed.
 * Host must be one of ours (blocks DNS rebinding) and a browser Origin must match an allowed
 * origin (blocks other pages in the same browser from opening the WebSocket).
 */
export interface GuardConfig {
  /** host:port values accepted in the Host header */
  hosts: Set<string>;
  /** full origins accepted in the Origin header, e.g. "http://127.0.0.1:8024" */
  origins: Set<string>;
}

export function guardConfig(port: number): GuardConfig {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  // Extra entries: the public hostname behind a reverse proxy, and the Vite dev server.
  for (const h of (process.env.MARU_HOSTS || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    hosts.add(h);
  }
  for (const o of (process.env.MARU_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    origins.add(o);
  }
  return { hosts, origins };
}

export function checkRequest(req: IncomingMessage, cfg: GuardConfig): string | null {
  const host = req.headers.host || "";
  if (!cfg.hosts.has(host)) return `host not allowed: ${host}`;
  const origin = req.headers.origin;
  if (origin !== undefined && !cfg.origins.has(origin)) return `origin not allowed: ${origin}`;
  return null;
}
