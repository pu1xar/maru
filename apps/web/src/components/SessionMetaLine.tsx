// The line under the conversation title (DESIGN.md 6l): the session's account, its working folder
// and, while a process holds it, who holds it (maru or terminal). Each item is a small icon with
// its value, and space alone separates the items: the icon says what the value is, so the line
// needs no separator character. The account opens a menu that moves the session to another account
// of its provider; the folder opens one that changes its working folder (rehome, Claude only). Both
// use the server calls of the settings screen's session management (projectsApi.ts); when they can
// run is decided in lib/sessionMeta.ts.
import type { AccountInfo, SessionSummary } from "@maru/shared";
import { FolderIcon, FolderSearchIcon, TerminalIcon, UserRoundIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { openSession } from "~/lib/openSession";
import {
  folderChoices,
  heldByThisServer,
  metaOwner,
  moveTargets,
  movedKey,
  relocateAction,
  retryWhileHeld,
  shouldFollowMove,
  type RelocateAction,
  type Relocation,
} from "~/lib/sessionMeta";
import { refreshSessionSummary, rekeySession } from "~/lib/sessionViewState";
import { socketHub } from "~/lib/socket";
import { cn } from "~/lib/utils";
import { shortAccount, shortPath } from "~/model";
import {
  ApiError,
  describeError,
  fetchAccounts,
  fetchListedSessions,
  fetchSession,
  moveSession,
  rehomeSession,
} from "~/projectsApi";
import { FolderBrowseDialog } from "./FolderBrowseDialog";
import { MaruMark } from "./MaruMark";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { plural } from "../lib/plural.ts";

/**
 * The holder chip leaves first as the header (container `thread-header`) narrows; the state icons
 * then show the terminal mark in its place (ThreadView `SessionStateIcons`), so it is said once.
 */
export const OWNER_CHIP_CLASS = "@max-[36rem]/thread-header:hidden";
export const OWNER_FOLDED_CLASS = "@min-[36rem]/thread-header:hidden";

const CHIP = "inline-flex h-5 min-w-0 items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground";
const CHIP_BUTTON = cn(
  CHIP,
  "cursor-pointer outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground aria-disabled:cursor-default",
);
const CHIP_ICON = "size-3 shrink-0 text-icon-muted";

/** How long to wait before asking again while this server's run still holds the session. */
const HELD_RETRY_MS = 250;

const FAILED: Record<Relocation, string> = { account: "Could not move to another account", folder: "Could not change the working folder" };

export function SessionMetaLine({ session }: { session: SessionSummary }) {
  const relocator = useRelocator(session);
  const owner = metaOwner(session);
  return (
    // -mt-1: pulled 4px up toward the title, the sizes unchanged (user request 2026-11-19: "둘 사이의 간격을 줄여줘").
    <div className="-ms-1 -mt-1 flex min-w-0 items-center gap-2">
      <AccountChip session={session} relocator={relocator} />
      <FolderChip session={session} relocator={relocator} />
      {owner ? <OwnerChip session={session} owner={owner} /> : null}
    </div>
  );
}

// ---- Moving and rehoming, closing this server's run first when it holds the session ----

interface Relocator {
  /** The change on its way, if any; the chips wait meanwhile. */
  pending: Relocation | null;
  move: (to: string) => void;
  rehome: (cwd: string) => void;
}

let reqSeq = 0;

function useRelocator(session: SessionSummary): Relocator {
  const [pending, setPending] = useState<Relocation | null>(null);
  // The latest summary and the change in progress, for the async steps that outlive a render.
  const live = useRef(session);
  const attemptRef = useRef<{ closeReq: string | null; closeError: string | null } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    live.current = session;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A close that failed (the session host is down, the run is gone) ends the change it was for.
  useEffect(
    () =>
      socketHub().onMessage((msg) => {
        const attempt = attemptRef.current;
        if (msg.type === "command.error" && attempt?.closeReq && msg.reqId === attempt.closeReq) attempt.closeError = msg.error;
      }),
    [],
  );

  const start = (what: Relocation, op: () => Promise<void>) => {
    if (attemptRef.current) return;
    const s = live.current;
    const action = relocateAction(s, what);
    if (action.kind === "blocked") {
      // The menu items are off then; the folder dialog can outlive the state it opened in.
      toastManager.add({ type: "error", title: FAILED[what], description: action.reason });
      return;
    }
    let closeReq: string | null = null;
    if (action.kind === "close-first") {
      reqSeq += 1;
      closeReq = `meta-close-${Date.now().toString(36)}-${reqSeq}`;
      if (!socketHub().send({ type: "thread.close", threadId: s.key, reqId: closeReq })) {
        toastManager.add({ type: "error", title: FAILED[what], description: "Disconnected from server, could not close the process" });
        return;
      }
    }
    const attempt = { closeReq, closeError: null as string | null };
    attemptRef.current = attempt;
    setPending(what);
    // After the close, the server refuses while the closing run still holds the session (until its
    // process has exited). So the change is asked again until it goes through, fails otherwise, or
    // stops being wanted. Between tries the server's own entry for the session is read: a session
    // off the list (opened from settings) gets no /ws updates, so its summary here can be stale.
    // A change that closed nothing is asked once.
    let serverStatus: SessionSummary["status"] | null = null;
    const turnStarted = (status: SessionSummary["status"] | null) => status === "running" || status === "waiting-input";
    const stopReason = (): string | null => {
      if (!mounted.current) return "Stopped because you left this view";
      if (attempt.closeError !== null) return attempt.closeError;
      if (turnStarted(live.current.status) || turnStarted(serverStatus)) return "Stopped because a turn started again";
      return null;
    };
    const isHeld = (error: unknown) => closeReq !== null && error instanceof ApiError && heldByThisServer(error.status, error.message);
    retryWhileHeld(op, {
      isHeld,
      stillWanted: () => stopReason() === null,
      wait: async () => {
        await new Promise((resolve) => setTimeout(resolve, HELD_RETRY_MS));
        serverStatus = (await fetchSession(s.key).catch(() => null))?.status ?? serverStatus;
      },
    })
      .catch((error: unknown) => {
        // A try that stopped while still refused says why it stopped; any other failure says itself.
        const why = isHeld(error) ? stopReason() : null;
        toastManager.add({ type: "error", title: FAILED[what], description: why ?? describeError(error) });
      })
      .finally(() => {
        attemptRef.current = null;
        if (mounted.current) setPending(null);
      });
  };

  return {
    pending,
    move: (to) =>
      start("account", async () => {
        const s = live.current;
        const r = await moveSession({ provider: s.provider, id: s.id, from: s.account, to });
        const next = movedKey(s, to);
        toastManager.add({ type: "success", title: `Moved to account ${shortAccount(to)}`, description: r.resumeCommand });
        // The page follows the session to its new key unless the person went elsewhere meanwhile.
        // The list drops the old key before this answer comes, which unmounts this view, so the
        // address tells: it still names this session (its id, which a move keeps). A split pane
        // follows on its own (6k).
        const selected = new URL(window.location.href).searchParams.get("s");
        // The view state goes along (unsent text, view mode, right panel, scroll, subagent stack,
        // split panes, the single view's selection): it is kept per key, and the key carries the
        // account.
        rekeySession(s.key, next, r.ids);
        if (shouldFollowMove({ viewShown: mounted.current, selected, from: s.key })) openSession(next);
      }),
    rehome: (cwd) =>
      start("folder", async () => {
        const s = live.current;
        const r = await rehomeSession({ provider: "claude", account: s.account, id: s.id, cwd });
        toastManager.add({
          type: "success",
          title: "Working folder changed",
          description: `${shortPath(r.cwd)}, ${plural(r.cwdRewritten, "cwd line")} rewritten${r.subtreesLeft.length ? `, ${plural(r.subtreesLeft.length, "subfolder")} left` : ""}`,
        });
        // A session off the list gets no /ws update, so its holders are handed the new summary.
        void refreshSessionSummary(s.key);
      }),
  };
}

// ---- Chips ----

/** What the chip's tooltip says: the reason it cannot run, or what a click does. */
function chipTip(action: RelocateAction, busy: boolean, what: Relocation): string {
  if (busy) return what === "account" ? "Moving" : "Changing folder";
  if (action.kind === "blocked") return action.reason;
  if (what === "account") return action.kind === "close-first" ? "Close process and move to another account" : "Move to another account";
  return action.kind === "close-first" ? "Close process and change working folder" : "Change working folder";
}

/** A line of the menu that is no item: why its items are off, or that it is still reading. */
function MenuNote({ children }: { children: ReactNode }) {
  return (
    <div role="note" className="flex max-w-64 items-center gap-1.5 px-2 pb-1.5 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

// Accounts change only with the server's config, so one read serves every header.
let accountsRead: Promise<AccountInfo[]> | null = null;
function readAccounts(): Promise<AccountInfo[]> {
  accountsRead ??= fetchAccounts().catch((error: unknown) => {
    accountsRead = null;
    throw error;
  });
  return accountsRead;
}

function AccountChip({ session, relocator }: { session: SessionSummary; relocator: Relocator }) {
  const action = relocateAction(session, "account");
  const busy = relocator.pending === "account";
  const [accounts, setAccounts] = useState<AccountInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = shortAccount(session.account);
  const tip = chipTip(action, busy, "account");
  const targets = accounts ? moveTargets(accounts, session) : [];
  return (
    <Menu
      onOpenChange={(open) => {
        if (!open || accounts) return;
        setError(null);
        readAccounts().then(setAccounts, (e: unknown) => setError(describeError(e)));
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              disabled={relocator.pending !== null}
              render={<button type="button" aria-label={`Account ${label}, ${tip}`} className={cn(CHIP_BUTTON, "shrink-0")} />}
            />
          }
        >
          {busy ? <Spinner aria-hidden className="size-3 shrink-0" /> : <UserRoundIcon aria-hidden className={CHIP_ICON} />}
          <span className="truncate">{label}</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">{tip}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" className="min-w-44">
        <MenuGroup>
          <MenuGroupLabel>{action.kind === "close-first" ? "Close process and move" : "Move to another account"}</MenuGroupLabel>
          {action.kind === "blocked" ? <MenuNote>{action.reason}</MenuNote> : null}
          {accounts === null ? (
            <MenuNote>
              {error ?? (
                <>
                  <Spinner aria-hidden className="size-3" />
                  Loading accounts
                </>
              )}
            </MenuNote>
          ) : targets.length === 0 ? (
            <MenuNote>No other account to move to</MenuNote>
          ) : (
            targets.map((t) => (
              <MenuItem key={t.id} disabled={action.kind === "blocked"} onClick={() => relocator.move(t.id)}>
                <UserRoundIcon />
                {shortAccount(t.id)}
              </MenuItem>
            ))
          )}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

/** The folder with its start cut off when it does not fit, never its end (its own name). */
function FolderText({ path }: { path: string }) {
  return (
    <span className="min-w-0 truncate [direction:rtl]">
      <bdi dir="ltr">{path}</bdi>
    </span>
  );
}

function FolderChip({ session, relocator }: { session: SessionSummary; relocator: Relocator }) {
  const action = relocateAction(session, "folder");
  const busy = relocator.pending === "folder";
  const [choices, setChoices] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Mounted until its exit animation ends; `seq` starts each one fresh.
  const [browse, setBrowse] = useState<{ seq: number; open: boolean } | null>(null);
  const path = shortPath(session.cwd);
  const tip = chipTip(action, busy, "folder");
  const fullTip = (
    <span className="flex max-w-sm flex-col gap-0.5">
      <span dir="ltr" className="wrap-anywhere">{session.cwd ?? path}</span>
      <span className="text-muted-foreground">{tip}</span>
    </span>
  );
  if (session.provider === "codex") {
    return (
      <Tooltip>
        <TooltipTrigger render={<span tabIndex={0} className={cn(CHIP, "shrink outline-none focus-visible:ring-2 focus-visible:ring-ring")} />}>
          <FolderIcon aria-hidden className={CHIP_ICON} />
          <FolderText path={path} />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{fullTip}</TooltipPopup>
      </Tooltip>
    );
  }
  const blocked = action.kind === "blocked";
  return (
    <>
      <Menu
        onOpenChange={(open) => {
          if (!open) return;
          // The list's folders as they are now; the menu reads them each time it opens.
          setError(null);
          fetchListedSessions().then(
            (list) => setChoices(folderChoices(list, session.cwd)),
            (e: unknown) => setError(describeError(e)),
          );
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                disabled={relocator.pending !== null}
                render={<button type="button" aria-label={`Working folder ${path}, ${tip}`} className={cn(CHIP_BUTTON, "shrink")} />}
              />
            }
          >
            {busy ? <Spinner aria-hidden className="size-3 shrink-0" /> : <FolderIcon aria-hidden className={CHIP_ICON} />}
            <FolderText path={path} />
          </TooltipTrigger>
          <TooltipPopup side="bottom">{fullTip}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="start" className="max-w-[min(28rem,calc(100vw-2rem))] min-w-56">
          <MenuGroup>
            <MenuGroupLabel>{action.kind === "close-first" ? "Close process and change folder" : "Change working folder"}</MenuGroupLabel>
            {blocked ? <MenuNote>{action.reason}</MenuNote> : null}
            {choices === null ? (
              <MenuNote>
                {error ?? (
                  <>
                    <Spinner aria-hidden className="size-3" />
                    Loading recent folders
                  </>
                )}
              </MenuNote>
            ) : (
              choices.map((cwd) => (
                <MenuItem key={cwd} disabled={blocked} onClick={() => relocator.rehome(cwd)}>
                  <FolderIcon />
                  <MiddleTruncate className="font-mono text-xs" value={shortPath(cwd)} />
                </MenuItem>
              ))
            )}
          </MenuGroup>
          <MenuSeparator />
          <MenuItem disabled={blocked} onClick={() => setBrowse((prev) => ({ seq: (prev?.seq ?? 0) + 1, open: true }))}>
            <FolderSearchIcon />
            Choose another folder
          </MenuItem>
        </MenuPopup>
      </Menu>
      {browse ? (
        <FolderBrowseDialog
          key={browse.seq}
          open={browse.open}
          current={session.cwd}
          recent={choices ?? []}
          closeFirst={action.kind === "close-first"}
          onClose={() => setBrowse((prev) => (prev ? { ...prev, open: false } : prev))}
          onClosed={() => setBrowse(null)}
          onChoose={(cwd) => {
            setBrowse((prev) => (prev ? { ...prev, open: false } : prev));
            relocator.rehome(cwd);
          }}
        />
      ) : null}
    </>
  );
}

const OWNER_TIP = {
  maru: "Open in a process maru started",
  claude: "Open in the Claude CLI in a terminal",
  codex: "Open in another client",
};

function OwnerChip({ session, owner }: { session: SessionSummary; owner: "maru" | "terminal" }) {
  const tip = owner === "maru" ? OWNER_TIP.maru : session.provider === "claude" ? OWNER_TIP.claude : OWNER_TIP.codex;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span role="img" aria-label={`${owner}, ${tip}`} className={cn(CHIP, "shrink-0", OWNER_CHIP_CLASS)} />}
      >
        {owner === "maru" ? <MaruMark aria-hidden className={CHIP_ICON} /> : <TerminalIcon aria-hidden className={CHIP_ICON} />}
        <span aria-hidden>{owner}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{tip}</TooltipPopup>
    </Tooltip>
  );
}
