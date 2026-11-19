// Choosing a session's new working folder by typing its path (DESIGN.md 6l and 6z): the path field
// (FolderPathField.tsx) lists the subfolders under what is typed, completes with Tab and has a
// Finder button where the browser runs on the Mac itself, and the button below takes the folder the
// text names. The folders come from the server (`GET /api/fs-complete`), so this works from a phone
// or another computer. Three places open it: the folder chip of a session's header, and (through
// RehomeFolderDialog.tsx) the sidebar's session menu and the settings session table.
// The layout is the app's T3 dialog (ui/dialog.tsx), as SessionManageDialogs.tsx uses it.
import { useState } from "react";

import { shortPath } from "~/model";
import { FolderPathField } from "./FolderPathField";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

export function FolderBrowseDialog(props: {
  open: boolean;
  /** The session's folder now; taking it again changes nothing, so it is refused as a choice. */
  current: string | null;
  /** Absolute folders offered while the field is empty (the recent session folders). */
  recent: readonly string[];
  /** This server's run holds the session between turns: taking a folder closes that run first. */
  closeFirst: boolean;
  onClose: () => void;
  onClosed: () => void;
  onChoose: (dir: string) => void;
}) {
  const [text, setText] = useState("");
  const [resolved, setResolved] = useState<string | null>(null);
  const rejectCurrent = (dir: string): string | null => (dir === props.current ? "This is the current working folder" : null);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) props.onClosed();
      }}
    >
      <DialogPopup className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Choose working folder</DialogTitle>
          {props.current ? (
            <p dir="ltr" className="truncate font-mono text-muted-foreground text-xs">
              Current: {shortPath(props.current)}
            </p>
          ) : null}
        </DialogHeader>
        <DialogPanel className="min-h-96">
          <FolderPathField
            autoFocus
            value={text}
            onValueChange={setText}
            recent={props.recent}
            onResolved={setResolved}
            reject={rejectCurrent}
            onConfirm={props.onChoose}
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button disabled={resolved === null} onClick={() => resolved && props.onChoose(resolved)}>
            {props.closeFirst ? "Close process and change to this folder" : "Change to this folder"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
