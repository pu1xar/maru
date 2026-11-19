// The first-run note on the empty main screen (DESIGN.md 6y): no account was found, or the session
// list is empty. The list shows only the sessions a person chose (DESIGN.md 6d), so a new install
// starts empty even with accounts; the note says so and opens the Accounts page.
import type { AccountInfo } from "@maru/shared";
import { useEffect, useState } from "react";

import { openSettings } from "~/lib/settingsRoute";
import { Button } from "./ui/button";

/** The server's accounts once: null while unread or when the read failed (no note is better than a wrong one). */
function useAccountCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one read of the account list when the empty screen shows
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/accounts", { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ accounts: AccountInfo[] }>) : null))
      .then((b) => b && setCount(b.accounts.length))
      .catch(() => {
        // unreachable server: the screen has its own notices for that
      });
    return () => ctrl.abort();
  }, []);
  return count;
}

export function FirstRunNotice({ listEmpty }: { listEmpty: boolean }) {
  const accounts = useAccountCount();
  const noAccounts = accounts === 0;
  if (!noAccounts && !listEmpty) return null;
  return (
    <div data-first-run="" className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-border/60 bg-card/40 px-5 py-4 text-center">
      <p className="max-w-md text-pretty text-sm text-muted-foreground">
        {noAccounts
          ? "maru found no Claude Code or Codex account. Add one, and sign in with the CLI's own flow."
          : "Your session list is empty. maru lists only the sessions you choose: start a new session, or press Add existing session in the sidebar to pick sessions from your accounts."}
      </p>
      <Button size="sm" variant={noAccounts ? "default" : "outline"} onClick={() => openSettings("accounts")}>
        Set up accounts
      </Button>
    </div>
  );
}
