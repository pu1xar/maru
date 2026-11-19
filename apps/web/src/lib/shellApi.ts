// The shell routes (DESIGN.md 6s, packages/shared/src/shell.ts).
import type { CreateShellRequest, ShellInfo, ShellListResponse } from "@maru/shared";

async function fail(res: Response): Promise<never> {
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // not JSON
  }
  throw new Error(message);
}

export async function listShells(): Promise<ShellInfo[]> {
  const res = await fetch("/api/shells");
  if (!res.ok) return fail(res);
  return ((await res.json()) as ShellListResponse).shells;
}

export async function createShell(req: CreateShellRequest): Promise<ShellInfo> {
  const res = await fetch("/api/shells", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
  if (!res.ok) return fail(res);
  return (await res.json()) as ShellInfo;
}

export async function closeShell(id: string): Promise<void> {
  const res = await fetch(`/api/shells/${encodeURIComponent(id)}`, { method: "DELETE" });
  // 404: it was gone already, which is what closing wanted.
  if (!res.ok && res.status !== 404) return fail(res);
}
