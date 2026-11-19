// The shell routes as the app calls them (web lib/shellApi.ts, DESIGN.md 6s, contract in
// packages/shared/src/shell.ts), with the device token in `Authorization`. A phone token may use
// exactly these three (apps/server/src/devices/access.ts androidShellRoute); the view socket is
// opened by ShellView.
import type { CreateShellRequest, ShellInfo, ShellListResponse } from "@maru/shared";
import { ApiError, auth, call, type Pairing } from "../lib/api.ts";

export interface ShellApi {
  list(): Promise<ShellInfo[]>;
  create(req: CreateShellRequest): Promise<ShellInfo>;
  /** Ends the shell; one that is already gone counts as ended. */
  close(id: string): Promise<void>;
}

export function shellApi(p: Pairing): ShellApi {
  return {
    async list() {
      return (await call<ShellListResponse>(`${p.server}/api/shells`, { headers: auth(p.token) })).shells;
    },
    create(req) {
      return call<ShellInfo>(`${p.server}/api/shells`, {
        method: "POST",
        headers: { ...auth(p.token), "content-type": "application/json" },
        body: JSON.stringify(req),
      });
    },
    async close(id) {
      try {
        await call(`${p.server}/api/shells/${encodeURIComponent(id)}`, { method: "DELETE", headers: auth(p.token) });
      } catch (e) {
        // 404: it was gone already, which is what ending it wanted.
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
    },
  };
}

/**
 * The scheme and host of the paired server, for the view socket's address (the web passes its page's
 * `location`). React Native's URL class does not implement `host`, so the text is split here.
 */
export function serverOrigin(server: string): { protocol: string; host: string } | null {
  const m = /^(https?):\/\/([^/?#]+)/i.exec(server.trim());
  return m ? { protocol: `${m[1]!.toLowerCase()}:`, host: m[2]! } : null;
}
