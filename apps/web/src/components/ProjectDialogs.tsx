// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: the form dialog layout of components/CustomSnoozeDialog.tsx and
// components/AddProjectToMachineDialog.tsx (form, header, panel, labelled fields, inline error,
// footer) and the confirm footer of components/ConfirmDialogHost.tsx. Local change: the fields and
// the writes are maru's projects (DESIGN.md 6c, shown as "Group"), and both dialogs close
// with their own buttons, so the corner close button is off.
import type { Project, SessionSummary } from "@maru/shared";
import { useEffect, useId, useRef, useState } from "react";

import { displayName } from "~/model";
import { createProject, deleteProject, describeError, renameSession, updateProject } from "~/projectsApi";
import { Button } from "./ui/button";
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
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { toastManager } from "./ui/toast";
import { plural } from "../lib/plural.ts";

export type ProjectDialogRequest =
  | { kind: "create" }
  | { kind: "rename"; project: Project }
  | { kind: "delete"; project: Project; sessionCount: number };

export type ProjectFormRequest = Exclude<ProjectDialogRequest, { kind: "delete" }>;
type DeleteRequest = Extract<ProjectDialogRequest, { kind: "delete" }>;

/** A failed project write shown as a toast, for writes with no dialog left to show it. */
export function reportProjectFailure(title: string, error: unknown) {
  toastManager.add({ type: "error", title, description: describeError(error) });
}

/**
 * Runs a write for a dialog: the error shows inline while the dialog is open, and as a toast
 * when the dialog was closed before the reply came.
 */
function useDialogWrite(open: boolean, failure: string, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openRef = useRef(open);
  // Read by a reply that arrives after a later render closed the dialog.
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const run = async (write: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await write();
      onClose();
    } catch (err) {
      if (openRef.current) setError(describeError(err));
      else reportProjectFailure(failure, err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error: error === null ? null : `${failure}: ${error}`, setError, run };
}

function formCopy(request: ProjectFormRequest): {
  title: string;
  submit: string;
  busy: string;
  failure: string;
} {
  switch (request.kind) {
    case "create":
      return {
        title: "New group",
        submit: "Create",
        busy: "Creating",
        failure: "Could not create the group",
      };
    case "rename":
      return {
        title: "Rename group",
        submit: "Save",
        busy: "Saving",
        failure: "Could not rename",
      };
  }
}

/**
 * Create and rename forms. The dialog closes when the server accepts the write;
 * the list itself changes when the server's update arrives over /ws.
 */
export function ProjectFormDialog(props: {
  open: boolean;
  request: ProjectFormRequest;
  onClose: () => void;
  /** After the exit animation, so the parent can unmount the dialog. */
  onClosed: () => void;
}) {
  const { open, request, onClose } = props;
  const id = useId();
  const [name, setName] = useState(request.kind === "rename" ? request.project.name : "");
  const copy = formCopy(request);
  const { busy, error, setError, run } = useDialogWrite(open, copy.failure, onClose);
  const canSubmit = !busy && name.trim() !== "";

  const submit = () =>
    run(() =>
      request.kind === "create"
        ? createProject({ name: name.trim() })
        : updateProject(request.project.id, { name: name.trim() }),
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) props.onClosed();
      }}
    >
      <DialogPopup className="sm:max-w-md" showCloseButton={false}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                nativeInput
                id={`${id}-name`}
                value={name}
                onChange={(event) => {
                  setName(event.currentTarget.value);
                  setError(null);
                }}
                autoComplete="off"
              />
            </div>
            {error ? (
              <p role="alert" className="text-destructive-foreground text-sm">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy ? copy.busy : copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Delete confirmation. The server moves the project's sessions back to 미분류. */
export function DeleteProjectDialog(props: {
  open: boolean;
  /** `sessionCount` is taken when the dialog opens. */
  request: DeleteRequest;
  onClose: () => void;
  onClosed: () => void;
}) {
  const { open, request, onClose } = props;
  const { project, sessionCount } = request;
  const { busy, error, run } = useDialogWrite(open, "Could not delete the group", onClose);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) props.onClosed();
      }}
    >
      <DialogPopup className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete group "{project.name}"?</DialogTitle>
          <DialogDescription>
            {sessionCount > 0 ? `${plural(sessionCount, "session")} will move to Unsorted` : "This group is empty"}
          </DialogDescription>
          {error ? (
            <p role="alert" className="text-destructive-foreground text-sm">
              {error}
            </p>
          ) : null}
        </DialogHeader>
        <DialogFooter>
          {/* The dialog's initial focus goes to its first action, so Enter cancels. */}
          <DialogClose render={<DialogAction variant="outline" />}>Cancel</DialogClose>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => void run(() => deleteProject(project.id))}
          >
            {busy ? "Deleting" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Renames a session in its own record (Claude transcript, Codex thread), so the terminal's
 * resume picker shows the same name when it can be written. A session a process holds open is
 * named in maru only, and the reply's notice says so.
 */
export function RenameSessionDialog(props: {
  open: boolean;
  session: SessionSummary;
  onClose: () => void;
  onClosed: () => void;
}) {
  const { open, session, onClose } = props;
  const id = useId();
  const [name, setName] = useState(session.name ?? displayName(session));
  const { busy, error, setError, run } = useDialogWrite(open, "Could not rename", onClose);
  const canSubmit = !busy && name.trim() !== "";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) props.onClosed();
      }}
    >
      <DialogPopup className="sm:max-w-md" showCloseButton={false}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit)
              void run(async () => {
                const res = await renameSession({ provider: session.provider, account: session.account, id: session.id, name: name.trim() });
                if (res.notice) toastManager.add({ type: "info", title: "Renamed", description: res.notice });
              });
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                nativeInput
                id={`${id}-name`}
                value={name}
                onChange={(event) => {
                  setName(event.currentTarget.value);
                  setError(null);
                }}
                autoComplete="off"
              />
            </div>
            {error ? (
              <p role="alert" className="text-destructive-foreground text-sm">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy ? "Saving" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
