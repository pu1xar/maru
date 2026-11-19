// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: the form dialog layout of components/AddProjectToMachineDialog.tsx (header, panel,
// labelled fields, Select, ToggleGroup, MiddleTruncate paths, inline error, footer). Local change:
// maru starts a session with a first message in a working folder typed as a path (with the
// subfolders listed and Tab completion, FolderPathField.tsx), chosen from the recent folders, or
// picked in the Mac's Finder dialog (the field's Finder button, on the Mac only), and an optional
// name (DESIGN.md 6f, 6z).
import type { AccountInfo, NewSessionMemory, Project, ProviderId, SessionSummary } from "@maru/shared";
import {
  canStartNewSession, chooseNewSessionAccount, NEW_SESSION_MODELS as MODELS, parseNewSessionMemory,
  providerAccounts as accountsOf, rememberNewSession,
} from "@maru/shared";
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";

import { createSession } from "~/lib/createSession";
import { recentCwds } from "~/model";
import { FolderPathField } from "./FolderPathField";
import { ClaudeAI, OpenAI } from "./Icons";
import { Button } from "./ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "./ui/dialog";
import { Label } from "./ui/label";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { toastManager } from "./ui/toast";
import { Textarea } from "./ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

const LAST_KEY = "maru_new_session";

// The models, the account choice, the folder list and the start rule are shared with the Android
// app's new session sheet (packages/shared/src/newSession.ts).

function readRemembered(): NewSessionMemory {
  try {
    return parseNewSessionMemory(JSON.parse(window.localStorage.getItem(LAST_KEY) ?? "null"));
  } catch {
    return {};
  }
}

function remember(v: NewSessionMemory): void {
  try {
    window.localStorage.setItem(LAST_KEY, JSON.stringify(v));
  } catch {
    // Then the next dialog starts from the defaults.
  }
}

/**
 * Select values for 미분류 and the default model: an empty value reads as "nothing chosen" to the
 * Select, which then draws its text as a placeholder.
 */
const NO_GROUP = "__none__";
const DEFAULT_MODEL = "__default__";

export function NewSessionDialog(props: {
  open: boolean;
  /** The Group the session starts in; null for 미분류. */
  projectId: string | null;
  projects: readonly Project[];
  sessions: readonly SessionSummary[];
  onClose: () => void;
  onClosed: () => void;
  onCreated: (key: string) => void;
}) {
  const { open, onClose } = props;
  const id = useId();
  const remembered = useMemo(readRemembered, []);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [provider, setProvider] = useState<ProviderId>(remembered.provider ?? "claude");
  const [account, setAccount] = useState<string>("");
  const [model, setModel] = useState("");
  const [projectId, setProjectId] = useState<string | null>(props.projectId);
  // The folder field's text, and the folder it names once the server read it as one.
  const [folderText, setFolderText] = useState("");
  const [cwd, setCwd] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recent = useMemo(() => recentCwds(props.sessions), [props.sessions]);

  // Loads the accounts a session can run under when the dialog opens.
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    fetch("/api/accounts", { signal: ctrl.signal })
      .then((r) => r.json() as Promise<{ accounts: AccountInfo[] }>)
      .then((b) => setAccounts(b.accounts))
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setError(`Could not load accounts: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => ctrl.abort();
  }, [open]);

  const providerAccounts = accountsOf(accounts, provider);
  const chosenAccount = chooseNewSessionAccount(accounts, provider, account, remembered);
  const canStart = canStartNewSession({ cwd, account: chosenAccount, prompt, busy });

  const start = async () => {
    if (!canStart || cwd === null) return;
    setBusy(true);
    setError(null);
    try {
      const key = await createSession({
        provider, account: chosenAccount, cwd, prompt: prompt.trim(), projectId, ...(model ? { model } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        onNameError: (message) => toastManager.add({ type: "error", title: "Session created, but it could not be named", description: message }),
      });
      remember(rememberNewSession(remembered, provider, chosenAccount, cwd));
      props.onCreated(key);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onPromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter while a Korean (or any IME) syllable is composing only commits the syllable.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      void start();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) props.onClosed();
      }}
    >
      <DialogPopup className="sm:max-w-lg" showCloseButton={false}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <DialogHeader>
            <DialogTitle>New session</DialogTitle>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <ToggleGroup
              aria-label="Agent"
              value={[provider]}
              onValueChange={(next) => {
                const p = next[0];
                if (p === "claude" || p === "codex") {
                  setProvider(p);
                  setModel("");
                }
              }}
            >
              <ToggleGroupItem value="claude">
                <ClaudeAI aria-hidden className="size-3.5" />
                Claude
              </ToggleGroupItem>
              <ToggleGroupItem value="codex">
                <OpenAI aria-hidden className="size-3.5" />
                Codex
              </ToggleGroupItem>
            </ToggleGroup>

            <div className="flex flex-col gap-1.5">
              <Label id={`${id}-cwd`}>Working folder</Label>
              <FolderPathField
                autoFocus
                aria-labelledby={`${id}-cwd`}
                value={folderText}
                onValueChange={setFolderText}
                recent={recent}
                finderStart={remembered.cwd ?? null}
                onResolved={setCwd}
                // The folder is chosen; the first message is next.
                onConfirm={() => document.getElementById(`${id}-prompt`)?.focus()}
                disabled={busy}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name (optional)</Label>
              <Input
                nativeInput
                id={`${id}-name`}
                size="sm"
                type="text"
                autoComplete="off"
                placeholder="Leave empty to name it from the first message"
                value={name}
                disabled={busy}
                onChange={(e) => setName(e.currentTarget.value)}
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label id={`${id}-account`}>Account</Label>
                <Select
                  value={chosenAccount || null}
                  onValueChange={(next) => {
                    if (typeof next === "string") setAccount(next);
                  }}
                >
                  <SelectTrigger size="sm" className="min-w-0" aria-labelledby={`${id}-account`}>
                    <SelectValue>{chosenAccount}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {providerAccounts.map((a) => (
                      <SelectItem hideIndicator key={a.id} value={a.id}>
                        {a.id}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label id={`${id}-model`}>Model</Label>
                <Select
                  value={model || DEFAULT_MODEL}
                  onValueChange={(next) => {
                    if (typeof next === "string") setModel(next === DEFAULT_MODEL ? "" : next);
                  }}
                >
                  <SelectTrigger size="sm" className="min-w-0" aria-labelledby={`${id}-model`}>
                    <SelectValue>{MODELS[provider].find((m) => m.value === model)?.label ?? model}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {MODELS[provider].map((m) => (
                      <SelectItem hideIndicator key={m.value} value={m.value || DEFAULT_MODEL}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label id={`${id}-group`}>Group</Label>
                <Select
                  value={projectId ?? NO_GROUP}
                  onValueChange={(next) => {
                    if (typeof next === "string") setProjectId(next === NO_GROUP ? null : next);
                  }}
                >
                  <SelectTrigger size="sm" className="min-w-0" aria-labelledby={`${id}-group`}>
                    <SelectValue>{props.projects.find((p) => p.id === projectId)?.name ?? "Unsorted"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {props.projects.map((p) => (
                      <SelectItem hideIndicator key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                    <SelectItem hideIndicator value={NO_GROUP}>
                      Unsorted
                    </SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-prompt`}>First message</Label>
              <Textarea
                id={`${id}-prompt`}
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.currentTarget.value)}
                onKeyDown={onPromptKeyDown}
              />
            </div>

            {error ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canStart}>
              {busy ? "Starting" : "Start"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
