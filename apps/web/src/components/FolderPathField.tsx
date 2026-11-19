// A working folder typed as a path (DESIGN.md 6f, 6l and 6z), as the usage dashboard's folder field
// worked: type `~/projects/` and the subfolders list right below, the arrow keys pick a row, Tab or
// the right arrow complete it and go one folder in, Enter takes it. Every place on the web that
// asks for a folder uses this field (the new session dialog, the dialogs that move a session to
// another folder); the Android app has the same behavior in components/FolderPathInput.tsx.
// Where the browser runs on the Mac itself, a Finder button opens the Mac's folder dialog.
//
// The folders come from the server (`GET /api/fs-complete`), so this works from a phone or another
// computer. A path is taken only when the server reads it as a folder; why not is shown under the
// field. The list floats under the field (it takes no room, so a press that blurs the field cannot
// move the controls around it). Pure rules (what Tab fills, how a path is judged) are in lib/folderInput.ts.
import { CheckIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import {
  folderFieldView,
  folderInputKind,
  folderKeyAction,
  judgeFolder,
  moveHighlight,
  readFolders as readFolderState,
  tabComplete,
  withEntry,
  type FolderLookup,
} from "~/lib/folderInput";
import { pickFolderOnMac, useFinderAvailable } from "~/lib/createSession";
import { folderName } from "~/lib/sessionMeta";
import { cn } from "~/lib/utils";
import { shortPath } from "~/model";
import { completeFolder, describeError } from "~/projectsApi";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Spinner } from "./ui/spinner";

/** How long typing pauses before the folders are read; the usage dashboard waited 130 ms too. */
const TYPING_PAUSE_MS = 130;

const readFolders = (value: string) => readFolderState(value, completeFolder);

export function FolderPathField(props: {
  value: string;
  onValueChange: (value: string) => void;
  /** Absolute paths shown while the field is empty. */
  recent: readonly string[];
  /** The folder the text names (absolute, `~` resolved) once the server read it as a folder; null otherwise. */
  onResolved: (path: string | null) => void;
  /** Enter on a folder that can be taken, with its absolute path. */
  onConfirm: (path: string) => void;
  /** A reason this folder is not wanted though it exists (the session's own folder, say). */
  reject?: (path: string) => string | null;
  /**
   * Whether to offer the Finder button (default true); it shows only where the browser runs on
   * the Mac itself. The dialog opens at the folder the text names, else `finderStart`, else the
   * first recent folder.
   */
  finder?: boolean;
  finderStart?: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
  "aria-labelledby"?: string;
}) {
  const { value, onValueChange, onResolved, reject } = props;
  const listId = useId();
  const kind = folderInputKind(value);
  const [open, setOpen] = useState(true);
  const [hi, setHi] = useState(-1);
  const [lookup, setLookup] = useState<FolderLookup | null>(null);
  const [confirmReason, setConfirmReason] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [finding, setFinding] = useState(false);
  const finderAvailable = useFinderAvailable() && props.finder !== false;
  const listRef = useRef<HTMLUListElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  // Reads the folders a pause after the last key.
  useEffect(() => {
    if (kind !== "path") return;
    let live = true;
    const timer = setTimeout(() => {
      readFolders(value).then(
        (r) => {
          if (live) setLookup({ key: value, list: r.list, check: r.check, error: null });
        },
        (e: unknown) => {
          if (live) setLookup({ key: value, list: null, check: null, error: describeError(e) });
        },
      );
    }, TYPING_PAUSE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [kind, value]);

  const view = folderFieldView(value, lookup, props.recent, reject);
  const { fresh, resolvedPath, rows, rowBase } = view;
  useEffect(() => {
    onResolved(resolvedPath);
  }, [resolvedPath, onResolved]);

  const showRows = open && rows.length > 0 && !props.disabled;

  useEffect(() => {
    setHi(-1);
    setConfirmReason(null);
  }, [value]);
  useEffect(() => {
    if (hi < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-row="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  /** The text a row stands for: a recent folder as typed `~/...`, a subfolder after the text it was listed for. */
  const rowText = (dir: string): string => (kind === "empty" ? shortPath(dir) : withEntry(rowBase, dir));

  /** Reads the folder now (not what the last pause read), and takes it when it can be. */
  const confirm = async (text: string): Promise<void> => {
    setConfirming(true);
    setConfirmReason(null);
    try {
      const check = (await readFolders(text)).check;
      const v = judgeFolder(text, check);
      const why = v.ok ? (reject?.(v.path) ?? null) : v.reason;
      if (valueRef.current !== value && text === value) return; // the text moved on meanwhile
      if (!v.ok || why !== null) {
        setConfirmReason(why ?? "");
        return;
      }
      if (text !== valueRef.current) onValueChange(text);
      setOpen(false);
      props.onConfirm(v.path);
    } catch (e) {
      setConfirmReason(describeError(e));
    } finally {
      setConfirming(false);
    }
  };

  /** The listing for the text as it is now, from the last answer when that is for it. */
  const currentDirs = async (): Promise<string[]> => {
    if (kind === "empty") return [...props.recent];
    if (fresh?.list) return fresh.list.dirs;
    return (await readFolders(value)).list.dirs;
  };

  /** Opens the Mac's folder dialog; the folder chosen goes into the field as typed `~/...`. */
  const openFinder = async (): Promise<void> => {
    setFinding(true);
    setConfirmReason(null);
    try {
      const chosen = await pickFolderOnMac(resolvedPath ?? props.finderStart ?? props.recent[0] ?? null);
      if (chosen) onValueChange(shortPath(chosen));
    } catch (e) {
      setConfirmReason(describeError(e));
    } finally {
      setFinding(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    // A key that only edits a Korean (or any IME) syllable in progress is not ours (composing).
    const action = folderKeyAction({
      key: event.key,
      shiftKey: event.shiftKey,
      composing: event.nativeEvent.isComposing || event.keyCode === 229,
      kind,
      rows: rows.length,
      highlighted: hi,
      listOpen: showRows,
      caretAtEnd: input.selectionStart === input.value.length && input.selectionEnd === input.value.length,
    });
    if (action === null) return;
    switch (action.type) {
      case "move": {
        event.preventDefault();
        setOpen(true);
        setHi((cur) => moveHighlight(open ? cur : -1, rows.length, action.dir));
        return;
      }
      case "complete": {
        event.preventDefault();
        const picked = hi >= 0 ? rows[hi] : undefined;
        if (kind === "empty") {
          if (picked !== undefined) onValueChange(`${shortPath(picked)}/`);
          return;
        }
        const typed = value;
        void currentDirs().then((dirs) => {
          if (valueRef.current !== typed) return;
          const next = tabComplete(typed, dirs, hi);
          if (next !== null) onValueChange(next);
        });
        return;
      }
      case "confirm": {
        event.preventDefault();
        if (props.disabled || confirming) return;
        const picked = hi >= 0 ? rows[hi] : undefined;
        void confirm(picked !== undefined ? rowText(picked) : value);
        return;
      }
      case "swallow":
        event.preventDefault();
        return;
      case "close":
        // Closes the list first; a second Escape reaches the dialog.
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
    }
  };

  const reason = confirmReason ?? view.reason;
  const checking = view.checking;
  return (
    <div className="relative flex min-w-0 flex-col gap-1.5">
      <div className="flex items-start gap-2">
      <Input
        nativeInput
        font="mono"
        size="sm"
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showRows}
        aria-controls={listId}
        aria-activedescendant={showRows && hi >= 0 ? `${listId}-${hi}` : undefined}
        aria-labelledby={props["aria-labelledby"]}
        aria-invalid={kind !== "empty" && reason ? true : undefined}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        placeholder="~/projects/..."
        value={value}
        onChange={(e) => {
          setOpen(true);
          onValueChange(e.currentTarget.value);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {finderAvailable ? (
        <Button type="button" size="sm" variant="outline" disabled={finding || props.disabled} onClick={() => void openFinder()}>
          {finding ? <Spinner size="sm" aria-hidden /> : <FolderOpenIcon aria-hidden />}
          {finding ? "Choosing in Finder" : "Finder"}
        </Button>
      ) : null}
      </div>
      <div role="status" className="flex min-h-4 items-center gap-1.5 text-xs">
        {kind === "empty" ? (
          <span className="text-muted-foreground">Enter a path starting with ~ or /, or pick a recent folder</span>
        ) : lookup?.error && fresh === null && lookup.key === value ? (
          <span className="text-destructive-foreground">{lookup.error}</span>
        ) : reason ? (
          <span className={rows.length > 0 && confirmReason === null ? "text-muted-foreground" : "text-destructive-foreground"}>
            {reason}
          </span>
        ) : resolvedPath ? (
          <>
            <CheckIcon aria-hidden className="size-3 shrink-0 text-success-foreground" />
            <span dir="ltr" className="min-w-0 truncate font-mono text-muted-foreground">
              {resolvedPath}
            </span>
          </>
        ) : checking || confirming ? (
          <>
            <Spinner aria-hidden className="size-3 text-muted-foreground" />
            <span className="text-muted-foreground">Reading folder</span>
          </>
        ) : null}
      </div>
      {showRows ? (
        <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-md border bg-popover shadow-lg">
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={kind === "empty" ? "Recent folders" : "Subfolders"}
            className="max-h-52 overflow-y-auto p-1"
          >
            {kind === "empty" ? (
              <li role="presentation" className="px-2 pt-1 pb-0.5 text-muted-foreground text-xs">
                Recent folders
              </li>
            ) : null}
            {rows.map((dir, i) => (
              <li
                key={dir}
                id={`${listId}-${i}`}
                data-row={i}
                role="option"
                aria-selected={i === hi}
                // The field keeps focus: a press on a row must not blur it.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onValueChange(`${rowText(dir)}/`);
                  setOpen(true);
                }}
                className={cn(
                  "flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-accent",
                  i === hi && "bg-accent",
                )}
              >
                <FolderIcon aria-hidden className="size-3.5 shrink-0 text-icon-muted" />
                {kind === "empty" ? (
                  <MiddleTruncate className="font-mono text-xs" value={shortPath(dir)} />
                ) : (
                  <span className="min-w-0 truncate font-mono text-xs">{folderName(dir)}</span>
                )}
              </li>
            ))}
          </ul>
          {kind !== "empty" ? (
            <p className="border-t px-3 py-1 text-muted-foreground text-xs">↑↓ select, Tab or → complete, Enter confirm, Esc close</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
