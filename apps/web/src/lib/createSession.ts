// New sessions (DESIGN.md 6f): `session.create` over /ws, answered by `session.created` with the
// new session's key once the CLI reported its id, or by `command.error` with the same reqId.
import type { ProviderId } from "@maru/shared";
import { useEffect, useState } from "react";

import { socketHub } from "./socket";

export interface CreateSessionInput {
  provider: ProviderId;
  account: string;
  cwd: string;
  prompt: string;
  projectId: string | null;
  model?: string;
  /** The session's name; absent, the session is named from its first message. */
  name?: string;
  /** The server made the session but could not name it (a Codex thread); the session is open. */
  onNameError?: (message: string) => void;
}

let seq = 0;

/** Resolves with the new session's key. Waits as long as the server takes to start the CLI. */
export function createSession(input: CreateSessionInput): Promise<string> {
  seq += 1;
  const reqId = `create-${Date.now().toString(36)}-${seq}`;
  const hub = socketHub();
  return new Promise((resolve, reject) => {
    const off = hub.onMessage((msg) => {
      if (msg.type === "session.created" && msg.reqId === reqId) {
        off();
        if (msg.nameError) input.onNameError?.(msg.nameError);
        resolve(msg.key);
      } else if (msg.type === "command.error" && msg.reqId === reqId) {
        off();
        reject(new Error(msg.error));
      }
    });
    const sent = hub.send({
      type: "session.create",
      reqId,
      provider: input.provider,
      account: input.account,
      cwd: input.cwd,
      prompt: input.prompt,
      projectId: input.projectId,
      ...(input.model ? { model: input.model } : {}),
      ...(input.name ? { name: input.name } : {}),
    });
    if (!sent) {
      off();
      reject(new Error("Disconnected from server, could not create the session"));
    }
  });
}

/** Opens the Mac's folder dialog on the server; null when the user cancelled. */
export async function pickFolderOnMac(defaultPath: string | null): Promise<string | null> {
  const res = await fetch("/api/pick-folder", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ defaultPath }),
  });
  const body = (await res.json().catch(() => null)) as { path?: string; cancelled?: boolean; error?: string } | null;
  if (!res.ok || !body) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body.path ?? null;
}

let finderAvailable: Promise<boolean> | null = null;

/**
 * Whether the Finder dialog can be used from this page: the server is on macOS and this request
 * reaches it from the Mac itself (`GET /api/pick-folder`, DESIGN.md 6z). Asked once per page load.
 */
export function finderAvailability(): Promise<boolean> {
  finderAvailable ??= fetch("/api/pick-folder", { headers: { accept: "application/json" } })
    .then((r) => (r.ok ? (r.json() as Promise<{ available?: boolean }>) : { available: false }))
    .then((b) => b.available === true)
    .catch(() => false);
  return finderAvailable;
}

/** False until the server says the Finder dialog is usable from here. */
export function useFinderAvailable(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void finderAvailability().then((v) => live && setOn(v));
    return () => {
      live = false;
    };
  }, []);
  return on;
}
