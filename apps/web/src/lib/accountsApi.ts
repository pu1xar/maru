// The accounts screen's calls (DESIGN.md 6y, contract in packages/shared/src/accounts.ts).
import type { AccountsStatus, AddAccountRequest, ShellInfo } from "@maru/shared";
import { ApiError } from "~/projectsApi";

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: the status line explains it
  }
  if (!res.ok) {
    const error = (body as { error?: unknown } | null)?.error;
    throw new ApiError(res.status, typeof error === "string" ? error : `${res.status} ${res.statusText}`);
  }
  return body as T;
}

const JSON_HEADERS = { accept: "application/json", "content-type": "application/json" };

export async function fetchAccountsStatus(signal?: AbortSignal): Promise<AccountsStatus> {
  return json<AccountsStatus>(await fetch("/api/accounts/status", { headers: { accept: "application/json" }, signal }));
}

export async function addAccount(req: AddAccountRequest): Promise<AccountsStatus> {
  return json<AccountsStatus>(await fetch("/api/accounts", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(req) }));
}

export async function removeAccount(id: string): Promise<AccountsStatus> {
  return json<AccountsStatus>(await fetch(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE", headers: { accept: "application/json" } }));
}

/** The server opens a shell and types the CLI's own sign-in into it; the page shows that shell. */
export async function startAccountLogin(id: string): Promise<ShellInfo> {
  return json<ShellInfo>(await fetch(`/api/accounts/${encodeURIComponent(id)}/login`, { method: "POST", headers: JSON_HEADERS, body: "{}" }));
}

export async function setCodexUsage(enabled: boolean): Promise<AccountsStatus> {
  return json<AccountsStatus>(await fetch("/api/settings/codex-usage", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ enabled }) }));
}

export async function setClaudeUsage(enabled: boolean): Promise<AccountsStatus> {
  return json<AccountsStatus>(await fetch("/api/settings/claude-usage", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ enabled }) }));
}
