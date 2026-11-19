// The settings screen's Accounts page (DESIGN.md 6y): the accounts of the server's config file with
// each one's login status (the provider's CLI answers it), adding and removing an account, the
// sign-in (a shell with the official CLI's own command typed in, so the person finishes it there),
// and the Claude usage switch. maru takes in no token, password or code here.
import { ACCOUNT_STATUS_LABEL, ACCOUNT_STATUS_VARIANT, ACCOUNT_ID_PATTERN, accountPendingNote, ANTHROPIC_TERMS_URL, defaultAccountDir, type AccountRow, type AccountsStatus, type ProviderId } from "@maru/shared";
import { PlusIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { addAccount, fetchAccountsStatus, removeAccount, setClaudeUsage, setCodexUsage, startAccountLogin } from "~/lib/accountsApi";
import { adoptShell } from "~/lib/shellList";
import { rememberActiveShell } from "~/lib/shellTabs";
import { openTerminal } from "~/lib/terminalRoute";
import { describeError } from "~/projectsApi";
import { ClaudeAI, OpenAI } from "../Icons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogAction,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type Loaded = { state: "loading" } | { state: "ok"; value: AccountsStatus } | { state: "error"; error: string };

const PROVIDER_LABEL: Record<ProviderId, string> = { claude: "Claude", codex: "Codex" };

function ProviderIcon({ provider }: { provider: ProviderId }) {
  return provider === "claude" ? <ClaudeAI className="size-4" aria-label="Claude" /> : <OpenAI className="size-4" aria-label="Codex" />;
}

/** The page's one read of the server: refreshed when the window gets focus back (after a sign-in in the terminal) and by the button. */
function useAccountsStatus(): [Loaded, () => void, (value: AccountsStatus) => void] {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const seq = useRef(0);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    fetchAccountsStatus().then(
      (value) => mine === seq.current && setLoaded({ state: "ok", value }),
      (e: unknown) => mine === seq.current && setLoaded({ state: "error", error: describeError(e) }),
    );
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the page reads the server's accounts when it opens and when the window is visible again
  useEffect(() => {
    reload();
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", reload);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", reload);
    };
  }, [reload]);
  // An answer to an edit is the newest state: it also drops any read still in flight.
  const set = useCallback((value: AccountsStatus) => {
    seq.current++;
    setLoaded({ state: "ok", value });
  }, []);
  return [loaded, reload, set];
}

export function AccountsPanel() {
  const [loaded, reload, set] = useAccountsStatus();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AccountRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loginFor, setLoginFor] = useState<string | null>(null);
  const status = loaded.state === "ok" ? loaded.value : null;

  const signIn = async (id: string) => {
    setLoginFor(id);
    setError(null);
    try {
      const shell = await startAccountLogin(id);
      adoptShell(shell);
      rememberActiveShell(shell.id);
      openTerminal();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoginFor(null);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Accounts"
        headerAction={
          <>
            <Button size="xs" variant="outline" onClick={reload} disabled={loaded.state === "loading"}>
              <RotateCwIcon />
              Refresh
            </Button>
            <Button size="xs" onClick={() => setAdding(true)} disabled={status === null}>
              <PlusIcon />
              Add account
            </Button>
          </>
        }
      >
        {loaded.state === "loading" ? (
          <SettingsRow title={<span className="inline-flex items-center gap-2"><Spinner className="size-3.5" />Loading</span>} />
        ) : null}
        {loaded.state === "error" ? (
          <SettingsRow
            title={<span className="inline-flex items-center gap-2"><TriangleAlertIcon className="size-3.5 text-warning-foreground" />Could not load</span>}
            description={loaded.error}
            control={<Button size="xs" variant="outline" onClick={reload}><RotateCwIcon />Reload</Button>}
          />
        ) : null}
        {status?.configError ? (
          <SettingsRow
            title={<span className="inline-flex items-center gap-2"><TriangleAlertIcon className="size-3.5 text-warning-foreground" />The config file cannot be read</span>}
            description={status.configError}
            status="Fix the file to add or remove accounts. The accounts below are the ones the server is running"
          />
        ) : null}
        {status && status.accounts.length === 0 ? (
          <SettingsRow
            title="No accounts"
            description="Add the Claude or Codex account maru should read sessions from. A folder that holds a signed-in CLI (~/.claude or ~/.codex) is found by itself when it exists"
          />
        ) : null}
        {status?.accounts.map((a) => (
          <AccountRowView key={`${a.provider}:${a.id}`} account={a} busy={loginFor === a.id} onSignIn={() => void signIn(a.id)} onRemove={() => setRemoving(a)} canEdit={!status.configError} />
        ))}
        {error ? <SettingsRow title={<span className="text-destructive-foreground">{error}</span>} /> : null}
        {status?.restartNeeded ? (
          <SettingsRow
            title="Restart maru to apply these changes"
            description="The server reads its accounts when it starts. Stop it and start it again (for example, press Ctrl+C and run pnpm start)"
          />
        ) : null}
        {status ? (
          <SettingsRow
            title="Config file"
            description={<span className="font-mono break-all">{status.configFile}</span>}
            status="Sign-in always runs in the provider's own CLI, in a terminal of this page, so maru never sees a password or sign-in code. Usage reading, when turned on below, reads the CLI's stored sign-in token"
          />
        ) : null}
      </SettingsSection>

      {status ? (
        <SettingsSection title="Claude usage">
          <SettingsRow
            title="Read Claude usage"
            description={
              <>
                Shows the rate limit meters. This reads the login token that Claude Code stored for each account and sends it to Anthropic's usage API, which Anthropic's terms for third-party tools may not allow for your plan. Read{" "}
                <a className="underline underline-offset-2" href={ANTHROPIC_TERMS_URL} target="_blank" rel="noreferrer">
                  Anthropic's legal and compliance page
                </a>{" "}
                first. Off by default
              </>
            }
            status={status.claudeUsage !== status.claudeUsageRunning ? "Restart maru to apply this" : undefined}
            control={
              <Switch
                checked={status.claudeUsage}
                disabled={!!status.configError}
                aria-label="Read Claude usage"
                onCheckedChange={(next) => {
                  setError(null);
                  setClaudeUsage(next).then(set, (e: unknown) => setError(describeError(e)));
                }}
              />
            }
          />
        </SettingsSection>
      ) : null}

      {status ? (
        <SettingsSection title="Codex usage">
          <SettingsRow
            title="Read Codex usage"
            description="Shows the rate limit meters. This reads the login token that the Codex CLI stored for each account and sends it to OpenAI's usage endpoint. Off by default"
            status={status.codexUsage !== status.codexUsageRunning ? "Restart maru to apply this" : undefined}
            control={
              <Switch
                checked={status.codexUsage}
                disabled={!!status.configError}
                aria-label="Read Codex usage"
                onCheckedChange={(next) => {
                  setError(null);
                  setCodexUsage(next).then(set, (e: unknown) => setError(describeError(e)));
                }}
              />
            }
          />
        </SettingsSection>
      ) : null}

      <AddAccountDialog
        open={adding}
        existing={status?.accounts ?? []}
        onClose={() => setAdding(false)}
        onAdded={(next, id) => {
          set(next);
          setAdding(false);
          void signIn(id);
        }}
      />
      <RemoveAccountDialog
        account={removing}
        onClose={() => setRemoving(null)}
        run={async (id) => {
          set(await removeAccount(id));
        }}
      />
    </SettingsPageContainer>
  );
}

function AccountRowView(props: { account: AccountRow; busy: boolean; canEdit: boolean; onSignIn: () => void; onRemove: () => void }) {
  const a = props.account;
  const pending = accountPendingNote(a.pending) ?? undefined;
  return (
    <SettingsRow
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          <ProviderIcon provider={a.provider} />
          <span>{a.id}</span>
          <Badge variant={ACCOUNT_STATUS_VARIANT[a.status]} size="sm">{ACCOUNT_STATUS_LABEL[a.status]}</Badge>
          {a.detected ? <Badge variant="info" size="sm">Detected</Badge> : null}
        </span>
      }
      description={<span className="font-mono break-all">{a.dir}</span>}
      status={pending}
      control={
        a.pending === "remove" ? null : (
          <>
            {a.status === "cli-missing" ? null : (
              <Button size="xs" variant={a.status === "signed-in" ? "outline" : "default"} disabled={props.busy} onClick={props.onSignIn}>
                {props.busy ? <Spinner className="size-3.5" /> : null}
                {a.status === "signed-in" ? "Sign in again" : "Sign in"}
              </Button>
            )}
            <Button size="xs" variant="destructive-outline" disabled={!props.canEdit} onClick={props.onRemove}>
              Remove
            </Button>
          </>
        )
      }
    />
  );
}

function AddAccountDialog(props: {
  open: boolean;
  existing: readonly AccountRow[];
  onClose: () => void;
  onAdded: (status: AccountsStatus, id: string) => void;
}) {
  const [provider, setProvider] = useState<ProviderId>("claude");
  const [id, setId] = useState("");
  const [dir, setDir] = useState("");
  const [dirEdited, setDirEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a form starts empty each time the dialog opens
  useEffect(() => {
    if (props.open) {
      setProvider("claude");
      setId("");
      setDir("");
      setDirEdited(false);
      setError(null);
    }
  }, [props.open]);

  const trimmed = id.trim();
  const idProblem =
    trimmed === "" ? null
      : !ACCOUNT_ID_PATTERN.test(trimmed) ? "Use letters, digits, \".\", \"_\" or \"-\""
      : props.existing.some((a) => a.id === trimmed) ? "This id is used already"
      : null;
  const suggested = trimmed ? defaultAccountDir(provider, trimmed) : defaultAccountDir(provider, "<id>");
  const folder = dirEdited ? dir : suggested;
  const folderTaken = props.existing.some((a) => a.dir === folder || (folder.startsWith("~/") && a.dir.endsWith(folder.slice(1))));
  const ready = trimmed !== "" && idProblem === null && folder.trim() !== "" && !folderTaken;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await addAccount({ provider, id: trimmed, dir: dirEdited ? dir.trim() : null });
      props.onAdded(next, trimmed);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(next) => !next && !busy && props.onClose()}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add account</DialogTitle>
          <DialogDescription>
            maru adds the account to its config file and opens a terminal with the CLI's own sign-in. Finish the sign-in there, then come back and press Refresh.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">Provider</span>
            <div className="flex gap-2" role="group" aria-label="Provider">
              {(["claude", "codex"] as const).map((p) => (
                <Button key={p} size="sm" variant={provider === p ? "default" : "outline"} aria-pressed={provider === p} onClick={() => setProvider(p)}>
                  <ProviderIcon provider={p} />
                  {PROVIDER_LABEL[p]}
                </Button>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">Id</span>
            <Input value={id} onChange={(e) => setId(e.target.value)} placeholder={provider === "claude" ? "claude-work" : "codex-work"} autoFocus spellCheck={false} />
            <span className={idProblem ? "text-xs text-destructive-foreground" : "text-xs text-muted-foreground"}>
              {idProblem ?? "A name for the account in maru. Letters, digits, \".\", \"_\" and \"-\""}
            </span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">Folder</span>
            <Input
              font="mono"
              value={folder}
              onChange={(e) => {
                setDir(e.target.value);
                setDirEdited(true);
              }}
              spellCheck={false}
            />
            <span className={folderTaken ? "text-xs text-destructive-foreground" : "text-xs text-muted-foreground"}>
              {folderTaken ? "Another account uses this folder" : `${provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"} of the account. maru creates it if it is missing`}
            </span>
          </label>
          {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<DialogAction variant="outline" />} disabled={busy}>
            Cancel
          </DialogClose>
          <Button disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? <Spinner className="size-3.5" /> : null}
            Add and sign in
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RemoveAccountDialog(props: { account: AccountRow | null; onClose: () => void; run: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dialog keeps showing the account while it closes.
  const shown = useRef<AccountRow | null>(null);
  if (props.account) shown.current = props.account;
  const a = props.account ?? shown.current;
  const go = async () => {
    if (!a) return;
    setBusy(true);
    setError(null);
    try {
      await props.run(a.id);
      props.onClose();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={props.account !== null} onOpenChange={(next) => !next && !busy && props.onClose()}>
      <DialogPopup className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{a ? `Remove ${a.id}?` : "Remove account"}</DialogTitle>
          <DialogDescription>
            This removes the account from maru's config file only. Its folder{a ? ` (${a.dir})` : ""} and its login are not touched, so you can add it again later. Its sessions leave maru's lists after the next restart.
          </DialogDescription>
        </DialogHeader>
        {error ? <DialogPanel><p className="text-sm text-destructive-foreground">{error}</p></DialogPanel> : null}
        <DialogFooter>
          <DialogClose render={<DialogAction variant="outline" />} disabled={busy}>
            Cancel
          </DialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void go()}>
            Remove
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
