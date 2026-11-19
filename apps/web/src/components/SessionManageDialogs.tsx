// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: the confirm footer of components/ConfirmDialogHost.tsx and the dialog layout of
// components/AddProjectToMachineDialog.tsx. Local change: the actions are an earlier dashboard's
// session delete and trash, ported to maru (DESIGN.md 6, 6a). The delete confirm says where this
// session goes (trash or gone) from its size, measured as the server measures it. The trash list
// is shared with the trash dialog of the settings screen's session management
// (settings/manage/ManagePopovers.tsx).
import { TRASH_THRESHOLD_BYTES, type SessionSummary, type TrashItem, type TrashList } from "@maru/shared";
import { RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { cn } from "~/lib/utils";
import { displayName } from "~/model";
import { deleteSession, describeError, fetchSessionUnits, listTrash, purgeTrash, restoreTrash } from "~/projectsApi";
import { formatBytes } from "./files/FilePreview";
import { ClaudeAI, OpenAI } from "./Icons";
import { deleteBytesOf, deleteOutcome, needsSubtreeBytes } from "./settings/manageModel";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogAction,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { toastManager } from "./ui/toast";
import { plural } from "../lib/plural.ts";
import { monthDay } from "../lib/dateText.ts";

// ---- Trash summary for the sidebar foot, read on start, every minute and after each change ----

let trash: TrashList | null = null;
const trashListeners = new Set<() => void>();
let trashTimer: ReturnType<typeof setInterval> | null = null;

export function refreshTrash(): void {
  listTrash()
    .then((t) => {
      trash = t;
      for (const l of [...trashListeners]) l();
    })
    .catch(() => {
      // The next refresh tries again.
    });
}

function subscribeTrash(listener: () => void): () => void {
  trashListeners.add(listener);
  if (!trashTimer) {
    refreshTrash();
    trashTimer = setInterval(refreshTrash, 60_000);
  }
  return () => {
    trashListeners.delete(listener);
  };
}

export function useTrash(): TrashList | null {
  return useSyncExternalStore(subscribeTrash, () => trash);
}

// ---- Delete ----

/**
 * The size the server's delete weighs against the trash threshold, or null while it is not known.
 * Claude: the transcript and the session's subtrees in every account (the index's size is the
 * transcript alone, so the subtrees are read when the transcript does not settle it). Codex: the
 * index's size settles only a session over the threshold, since its subagent threads count too.
 */
function useDeleteBytes(s: SessionSummary, open: boolean): number | null {
  const [subtree, setSubtree] = useState<{ key: string; bytes: number } | null>(null);
  const needsSubtree = open && needsSubtreeBytes(s);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the session's subtree size from the server when the dialog opens
  useEffect(() => {
    if (!needsSubtree) return;
    let live = true;
    fetchSessionUnits(s.account, s.id)
      .then((u) => live && setSubtree({ key: s.key, bytes: u.totalBytes }))
      .catch(() => {
        // Unknown: the dialog states the rule instead.
      });
    return () => {
      live = false;
    };
  }, [needsSubtree, s.account, s.id, s.key]);
  return deleteBytesOf(s, subtree?.key === s.key ? subtree.bytes : null);
}

export function DeleteSessionDialog(props: {
  open: boolean;
  session: SessionSummary;
  onClose: () => void;
  onClosed: () => void;
  /** After the server removed the session (a session outside the list has no /ws update to show it). */
  onDeleted?: () => void;
}) {
  const { open, session: s, onClose } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bytes = useDeleteBytes(s, open);
  const outcome = deleteOutcome(bytes);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await deleteSession({ provider: s.provider, account: s.account, id: s.id });
      toastManager.add({
        type: "success",
        title: r.outcome === "trashed" ? "Moved to Trash" : "Permanently deleted",
        description: `${displayName(s)}, ${formatBytes(r.sizeBytes)}${r.ids.length > 1 ? `, ${plural(r.ids.length, "thread")}` : ""}`,
      });
      refreshTrash();
      props.onDeleted?.();
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
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
      <DialogPopup className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete session "{displayName(s)}"?</DialogTitle>
          <DialogDescription>
            {outcome === "trash"
              ? `Moves to Trash, ${formatBytes(bytes ?? 0)}`
              : outcome === "purge"
                ? `Permanently deleted right away, ${formatBytes(bytes ?? 0)}`
                : `Over ${formatBytes(TRASH_THRESHOLD_BYTES)} goes to Trash, otherwise it is permanently deleted right away`}
          </DialogDescription>
          {error ? (
            <p role="alert" className="text-destructive-foreground text-sm">
              {error}
            </p>
          ) : null}
        </DialogHeader>
        <DialogFooter>
          {/* The dialog's initial focus goes to its first action, so Enter cancels. */}
          <DialogClose render={<DialogAction variant="outline" />} disabled={busy}>
            Cancel
          </DialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void run()}>
            {busy ? "Deleting" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ---- Trash ----

function when(ms: number): string {
  const d = new Date(ms);
  return `${monthDay(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Count and size of the trash, with the unreadable entries when there are any. */
export function trashSummary(list: TrashList | null): string {
  if (!list) return "Loading";
  return (
    `${plural(list.items.length, "item")}, ${formatBytes(list.totalBytes)}` +
    (list.unreadable.length ? `, ${list.unreadable.length} unreadable` : "")
  );
}

/**
 * The trash entries, newest first, each with restore and a two-step purge, for the settings
 * screen's trash tab; `itemClassName` frames each row and `padClassName` (default `px-6`) pads the
 * error and empty lines.
 */
export function TrashEntries(props: { list: TrashList | null; itemClassName?: string; padClassName?: string }) {
  const { list } = props;
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (item: TrashItem, kind: "restore" | "purge") => {
    setBusyKey(item.key);
    setError(null);
    try {
      if (kind === "restore") {
        await restoreTrash(item.key);
        toastManager.add({ type: "success", title: "Restored", description: item.name ?? item.id });
      } else {
        const r = await purgeTrash(item.key);
        toastManager.add({ type: "success", title: "Permanently deleted", description: `${formatBytes(r.freedBytes)} freed` });
      }
      setConfirmPurge(null);
      refreshTrash();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyKey(null);
    }
  };

  const items = [...(list?.items ?? [])].sort((a, b) => b.deletedAt - a.deletedAt);
  const pad = props.padClassName ?? "px-6";
  return (
    <>
      {error ? (
        <p role="alert" className={cn(pad, "py-2 text-sm text-destructive-foreground")}>
          {error}
        </p>
      ) : null}
      {list && items.length === 0 ? <p className={cn(pad, "py-6 text-sm text-muted-foreground")}>Empty</p> : null}
      <ul>
        {items.map((item) => (
          <li key={item.key} className={cn("flex items-center gap-3 py-2.5 text-sm", props.itemClassName)}>
            {item.provider === "claude" ? (
              <ClaudeAI aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <OpenAI aria-hidden className="size-3.5 shrink-0 text-black dark:text-white" />
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium" title={item.id}>
                {item.name || item.id}
              </span>
              <span className="truncate text-xs text-muted-foreground tabular-nums">
                {item.account}, {formatBytes(item.sizeBytes)}
                {item.threads > 1 ? `, ${plural(item.threads, "thread")}` : ""}, deleted {when(item.deletedAt)}
              </span>
              {item.problem ? <span className="truncate text-xs text-warning-foreground">{item.problem}</span> : null}
            </div>
            <Button
              size="xs"
              variant="outline"
              disabled={busyKey !== null || item.problem !== null}
              onClick={() => void act(item, "restore")}
            >
              <RotateCcwIcon />
              Restore
            </Button>
            {confirmPurge === item.key ? (
              <Button size="xs" variant="destructive" disabled={busyKey !== null} onClick={() => void act(item, "purge")}>
                {busyKey === item.key ? "Deleting" : "Confirm permanent delete"}
              </Button>
            ) : (
              <Button size="xs" variant="ghost-muted" disabled={busyKey !== null} onClick={() => setConfirmPurge(item.key)}>
                <Trash2Icon />
                Delete permanently
              </Button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
