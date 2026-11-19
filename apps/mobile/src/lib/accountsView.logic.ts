// The Accounts tab's rows (the web's settings/AccountsPanel.tsx, read only): each account's id, its
// provider, the status badge and the notes, from the server's `GET /api/accounts/status`.
// React Native-free, by path, so a node test reads it.
import {
  ACCOUNT_STATUS_LABEL,
  ACCOUNT_STATUS_VARIANT,
  accountPendingNote,
  type AccountsStatus,
} from "../../../../packages/shared/src/accounts.ts";
import type { BadgeVariant } from "./sidebarColors.ts";

export interface AccountView {
  key: string;
  id: string;
  provider: "claude" | "codex";
  dir: string;
  statusLabel: string;
  statusVariant: BadgeVariant;
  detected: boolean;
  /** A change that waits for a restart of the server. */
  note: string | null;
}

export function accountViews(status: AccountsStatus): AccountView[] {
  return status.accounts.map((a) => ({
    key: `${a.provider}:${a.id}`,
    id: a.id,
    provider: a.provider,
    dir: a.dir,
    statusLabel: ACCOUNT_STATUS_LABEL[a.status],
    statusVariant: ACCOUNT_STATUS_VARIANT[a.status],
    detected: a.detected,
    note: accountPendingNote(a.pending),
  }));
}

/** The line under the list: accounts are added and signed in on a computer. */
export const ACCOUNTS_ON_COMPUTER = "Add, remove and sign in to accounts in maru on a computer. This list is read only";

export function restartNote(status: AccountsStatus): string | null {
  return status.restartNeeded ? "Restart maru on the computer to apply the changes in its config file" : null;
}
