// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: the confirm footer of components/ConfirmDialogHost.tsx and the dialog layout of
// components/AddProjectToMachineDialog.tsx. Local change: a confirmed bulk write (an
// earlier dashboard's "선택 삭제" and "전체 완전삭제") that lists every item it will take before the
// confirm, then calls the server one item at a time and lists each item's outcome, since the
// server's management calls take one session each.
import { CheckIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { describeError } from "~/projectsApi";
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
import { Spinner } from "../ui/spinner";
import { runSequential, type BulkResult } from "./manageModel";
import { plural } from "../../lib/plural.ts";

export interface BulkJob<T, R> {
  title: string;
  /** Facts the reader needs before confirming (permanence, the trash rule). */
  description?: ReactNode;
  confirmLabel: string;
  items: readonly T[];
  /** The item's name in the lists. */
  label: (item: T) => string;
  /** A second line under the name before the run (account, size, folder). */
  sublabel?: (item: T) => string;
  run: (item: T) => Promise<R>;
  /** The result line for an item that went through. */
  detail: (value: R) => string;
  /** After the last item, with every result. */
  onFinished?: (results: ReadonlyArray<BulkResult<T, R>>) => void;
}

/** Mount with a fresh `key` per job; it closes only when no item is running. */
export function BulkRunDialog<T, R>(props: {
  open: boolean;
  job: BulkJob<T, R>;
  onClose: () => void;
  onClosed: () => void;
}) {
  const { job } = props;
  const [results, setResults] = useState<ReadonlyArray<BulkResult<T, R>> | null>(null);
  const [running, setRunning] = useState(false);
  const total = job.items.length;

  const start = async () => {
    setRunning(true);
    setResults([]);
    const all = await runSequential(job.items, job.run, describeError, (sofar) => setResults([...sofar]));
    setRunning(false);
    job.onFinished?.(all);
  };

  const failed = results?.filter((r) => !r.ok).length ?? 0;
  const done = results?.length ?? 0;
  const finished = results !== null && !running;

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next && !running) props.onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) props.onClosed();
      }}
    >
      <DialogPopup className="sm:max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{job.title}</DialogTitle>
          {results === null ? (
            job.description ? <DialogDescription>{job.description}</DialogDescription> : null
          ) : (
            <DialogDescription className="tabular-nums" aria-live="polite">
              {running ? `${done} / ${total} processing` : `${total} total, ${done - failed} succeeded, ${failed} failed`}
            </DialogDescription>
          )}
        </DialogHeader>
        {results === null && total > 0 ? (
          <DialogPanel className="max-h-[50vh] overflow-y-auto p-0">
            <ul aria-label="Items to process">
              {job.items.map((item, i) => (
                <li key={i} className="flex min-w-0 flex-col border-b border-border/60 px-6 py-2 text-sm last:border-b-0">
                  <span className="truncate">{job.label(item)}</span>
                  {job.sublabel ? <span className="truncate text-xs text-muted-foreground">{job.sublabel(item)}</span> : null}
                </li>
              ))}
            </ul>
          </DialogPanel>
        ) : null}
        {results !== null ? (
          <DialogPanel className="max-h-[50vh] overflow-y-auto p-0">
            <ul aria-label="Results">
              {results.map((r, i) => (
                <li key={i} className="flex items-start gap-2 border-b border-border/60 px-6 py-2 text-sm">
                  {r.ok ? (
                    <CheckIcon aria-label="Succeeded" className="mt-0.5 size-3.5 shrink-0 text-success-foreground" />
                  ) : (
                    <XIcon aria-label="Failed" className="mt-0.5 size-3.5 shrink-0 text-destructive-foreground" />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{job.label(r.item)}</span>
                    <span
                      className={
                        r.ok ? "text-xs text-muted-foreground" : "text-xs wrap-anywhere text-destructive-foreground"
                      }
                    >
                      {r.ok ? job.detail(r.value) : r.error}
                    </span>
                  </div>
                </li>
              ))}
              {running ? (
                <li className="flex items-center gap-2 px-6 py-2 text-sm text-muted-foreground">
                  <Spinner size="sm" />
                  {job.label(job.items[done]!)}
                </li>
              ) : null}
            </ul>
          </DialogPanel>
        ) : null}
        <DialogFooter>
          {finished ? (
            <Button onClick={props.onClose}>Close</Button>
          ) : (
            <>
              {/* The dialog's initial focus goes to its first action, so Enter cancels. */}
              <DialogClose render={<DialogAction variant="outline" />} disabled={running}>
                Cancel
              </DialogClose>
              <Button variant="destructive" disabled={running || total === 0} onClick={() => void start()}>
                {running ? "Working" : `${job.confirmLabel} ${plural(total, "item")}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
