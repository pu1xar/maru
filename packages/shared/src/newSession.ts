// The new session form's rules (DESIGN.md 6f), shared by the web's dialog and the Android app's
// sheet: the models a session can start on, which account is chosen, which folders are offered and
// when the form may start. The session itself starts with `session.create` over /ws.
import type { AccountInfo, ProviderId } from "./index.ts";

/** Model choices passed to the CLI; "" keeps the account's default. */
export const NEW_SESSION_MODELS: Readonly<Record<ProviderId, readonly { value: string; label: string }[]>> = {
  claude: [
    { value: "", label: "Default" },
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet" },
    { value: "haiku", label: "Haiku" },
  ],
  codex: [
    { value: "", label: "Default" },
    { value: "gpt-6-astra", label: "gpt-6-astra" },
    { value: "gpt-6-sol", label: "gpt-6-sol" },
    { value: "gpt-6-luna", label: "gpt-6-luna" },
  ],
};

/** What a client remembers from the last session it started: agent, account per agent, folder. */
export interface NewSessionMemory {
  provider?: ProviderId;
  account?: Partial<Record<ProviderId, string>>;
  cwd?: string;
}

/** Reads remembered values back, dropping anything of the wrong shape. */
export function parseNewSessionMemory(value: unknown): NewSessionMemory {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  const out: NewSessionMemory = {};
  if (v.provider === "claude" || v.provider === "codex") out.provider = v.provider;
  if (v.account && typeof v.account === "object") {
    const a = v.account as Record<string, unknown>;
    const account: Partial<Record<ProviderId, string>> = {};
    if (typeof a.claude === "string") account.claude = a.claude;
    if (typeof a.codex === "string") account.codex = a.codex;
    out.account = account;
  }
  if (typeof v.cwd === "string") out.cwd = v.cwd;
  return out;
}

/** The accounts a session of this agent can run under, in the server's order. */
export function providerAccounts(accounts: readonly AccountInfo[], provider: ProviderId): AccountInfo[] {
  return accounts.filter((a) => a.provider === provider);
}

/**
 * The account the form starts with: the one the user picked in this form, else the one they last
 * started this agent's session under, else the first. "" when the agent has no account.
 */
export function chooseNewSessionAccount(
  accounts: readonly AccountInfo[],
  provider: ProviderId,
  picked: string,
  memory: NewSessionMemory,
): string {
  const list = providerAccounts(accounts, provider);
  return list.find((a) => a.id === picked)?.id ?? list.find((a) => a.id === memory.account?.[provider])?.id ?? list[0]?.id ?? "";
}

/**
 * The folders the form offers: the recent sessions' folders (web model.ts recentCwds), with a
 * picked folder no session used yet at the top. The Android sheet picks from this list only; the web dialog types a path (DESIGN.md 6f).
 */
export function newSessionFolders(recent: readonly string[], picked: string | null): string[] {
  return picked !== null && !recent.includes(picked) ? [picked, ...recent] : [...recent];
}

/** The form may start: a folder, an account and a first message, and nothing under way. */
export function canStartNewSession(input: { cwd: string | null; account: string; prompt: string; busy: boolean }): boolean {
  return !input.busy && input.cwd !== null && input.account !== "" && input.prompt.trim() !== "";
}

/** What a client remembers once the session started. */
export function rememberNewSession(memory: NewSessionMemory, provider: ProviderId, account: string, cwd: string): NewSessionMemory {
  return { provider, account: { ...memory.account, [provider]: account }, cwd };
}
