// The accounts screen (DESIGN.md 6y): the accounts the server's config file lists, whether each is
// signed in (asked of the official CLI, never read from its token files), and the routes that edit
// the list.
//
// HTTP (web listener, and the device listener for a desktop token; an Android token has the GET only):
//   GET    /api/accounts/status               -> AccountsStatus
//   POST   /api/accounts                      AddAccountRequest -> AccountsStatus
//   DELETE /api/accounts/<id>                 -> AccountsStatus (the config file only; the folder and the login stay)
//   POST   /api/accounts/<id>/login           -> ShellInfo (a new shell with the CLI's own sign-in typed in)
//   PUT    /api/settings/claude-usage         { enabled } -> AccountsStatus
//   PUT    /api/settings/codex-usage          { enabled } -> AccountsStatus
import type { ProviderId } from "./index.ts";

/** What the provider's CLI said about the account's login. */
export type AccountLoginStatus = "signed-in" | "not-signed-in" | "cli-missing" | "unknown";

/** The words the web and the app show for each status. */
export const ACCOUNT_STATUS_LABEL: Record<AccountLoginStatus, string> = {
  "signed-in": "Signed in",
  "not-signed-in": "Not signed in",
  "cli-missing": "CLI not found",
  unknown: "Unknown",
};

/** The tint of the status badge in the web and the app (the web Badge's variant names). */
export const ACCOUNT_STATUS_VARIANT: Record<AccountLoginStatus, "success" | "warning" | "error" | "outline"> = {
  "signed-in": "success",
  "not-signed-in": "warning",
  "cli-missing": "error",
  unknown: "outline",
};

/** What a row says about a change that waits for a restart of the server, or null. */
export function accountPendingNote(pending: AccountRow["pending"]): string | null {
  if (pending === "add") return "Restart maru to use this account";
  if (pending === "remove") return "Removed from the config file. Restart maru to stop using it";
  return null;
}

/** Anthropic's terms for third-party tools: the Claude usage switch links here. */
export const ANTHROPIC_TERMS_URL = "https://code.claude.com/docs/en/legal-and-compliance";

export interface AccountRow {
  id: string;
  provider: ProviderId;
  /** CLAUDE_CONFIG_DIR or CODEX_HOME, absolute. */
  dir: string;
  status: AccountLoginStatus;
  /** Found on disk (`~/.claude`, `~/.codex`) because the config file does not list it. */
  detected: boolean;
  /**
   * The running server's accounts differ from the file: `add` is in the file but not running yet,
   * `remove` is running but no longer in the file. Both take a restart.
   */
  pending: "add" | "remove" | null;
}

export interface AccountsStatus {
  accounts: AccountRow[];
  /** The config file edits go to (it need not exist yet). */
  configFile: string;
  /** The `claudeUsage` switch as the file has it, and as the running server has it. */
  claudeUsage: boolean;
  claudeUsageRunning: boolean;
  /** The `codexUsage` switch, in the same two forms. */
  codexUsage: boolean;
  codexUsageRunning: boolean;
  /** Something in the file takes a restart of the server to apply. */
  restartNeeded: boolean;
  /** The file could not be read; the rows then show the running accounts. */
  configError: string | null;
}

export interface AddAccountRequest {
  provider: ProviderId;
  id: string;
  /** Folder of the account; empty or missing: `~/.claude-<id>` or `~/.codex-<id>`. */
  dir?: string | null;
}

/** The folder an account of `id` gets when none is given. */
export function defaultAccountDir(provider: ProviderId, id: string): string {
  return `~/.${provider}-${id}`;
}

/** Account ids appear in session keys, so the same rule as the config file. */
export const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
