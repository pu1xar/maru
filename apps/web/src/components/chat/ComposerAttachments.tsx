// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: apps/web/src/components/chat/ComposerAttachmentStrip.tsx (ComposerAttachmentMediaRow,
// ComposerAttachmentFileList, ComposerAttachButton: 64px picture tiles with a corner remove button,
// then one row per file with its size). Local changes: maru's upload store (lib/composerAttachments.ts)
// instead of T3's draft store and upload queue, no SnapShot, video or HEIC thumbnail paths (the
// server converts a HEIC and the tile shows its copy), Korean labels, and a drop zone for the
// composer frame (T3 takes drops on its editor).
import { CircleAlertIcon, FileIcon, ImageIcon, PaperclipIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";

import { dragHasFiles, type ComposerAttachment } from "~/lib/composerAttachments";
import { formatBytes } from "~/lib/composerAttachments.logic";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ImagePreviewDialog, type PreviewImage } from "./ImagePreviewDialog";

function progressLabel(a: ComposerAttachment): string {
  if (a.sizeBytes <= 0) return "Uploading";
  return `${Math.min(99, Math.floor((a.sentBytes / a.sizeBytes) * 100))}%`;
}

/** Pictures as tiles, then files as rows; each with a remove button. Click a tile to see it large. */
export function ComposerAttachmentStrip(props: { items: readonly ComposerAttachment[]; onRemove: (localId: string) => void }) {
  const [preview, setPreview] = useState<{ images: PreviewImage[]; index: number } | null>(null);
  // A picture the browser cannot draw (a HEIC on a desktop) shows an icon until the server's copy replaces it.
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  if (props.items.length === 0) return null;
  const pictures = props.items.filter((a) => a.previewUrl !== null);
  const files = props.items.filter((a) => a.previewUrl === null);
  const images: PreviewImage[] = pictures.map((a) => ({ src: a.previewUrl!, name: a.name }));
  return (
    <div data-composer-attachments="" className="flex flex-col gap-2">
      {pictures.length > 0 ? (
        <div className="flex max-w-full flex-wrap gap-2">
          {pictures.map((a, i) => (
            <div key={a.localId} className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border/80 bg-background">
              <button
                type="button"
                className="h-full w-full cursor-zoom-in"
                aria-label={`Enlarge ${a.name}`}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => setPreview({ images, index: i })}
              >
                {broken.has(a.previewUrl!) ? (
                  <span role="img" aria-label={a.name} className="flex size-full items-center justify-center text-secondary-label">
                    <ImageIcon aria-hidden className="size-4" />
                  </span>
                ) : (
                  <img
                    src={a.previewUrl!}
                    alt={a.name}
                    draggable={false}
                    onError={() => setBroken((prev) => new Set(prev).add(a.previewUrl!))}
                    className="h-full w-full object-cover"
                  />
                )}
              </button>
              {a.status === "uploading" ? (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs text-foreground tabular-nums">
                  {progressLabel(a)}
                </span>
              ) : null}
              <AttachmentState item={a} className="absolute bottom-1 left-1" />
              <span className="absolute right-1 top-1 flex">
                <Button
                  variant="media-close"
                  size="icon-xs"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => props.onRemove(a.localId)}
                  aria-label={`Remove ${a.name}`}
                >
                  <XIcon />
                </Button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="flex flex-col gap-1">
          {files.map((a) => (
            <div key={a.localId} className="flex min-w-0 items-center gap-2 py-1 text-sm text-foreground">
              <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate" title={a.uploaded?.path ?? a.name}>
                {a.name}
              </span>
              <span className="shrink-0 text-xs text-secondary-label tabular-nums">
                {a.status === "uploading" ? progressLabel(a) : formatBytes(a.sizeBytes)}
              </span>
              <AttachmentState item={a} />
              <Button
                variant="ghost"
                size="icon-xs"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => props.onRemove(a.localId)}
                aria-label={`Remove ${a.name}`}
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {preview ? <ImagePreviewDialog images={preview.images} index={preview.index} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

/** A failed upload, or a picture the server sends by path only, says why in a tooltip. */
function AttachmentState({ item, className }: { item: ComposerAttachment; className?: string }) {
  const reason = item.status === "failed" ? item.error ?? "Upload failed" : item.uploaded?.notice;
  if (!reason) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={reason}
            className={cn(
              "inline-flex shrink-0 items-center justify-center rounded bg-background/85 p-0.5",
              item.status === "failed" ? "text-destructive" : "text-warning-foreground",
              className,
            )}
          />
        }
      >
        <CircleAlertIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {reason}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The paperclip button: opens the system file chooser (several files at once). */
export function ComposerAttachButton(props: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        data-composer-file-input=""
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          props.onFiles(files);
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={props.disabled}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => inputRef.current?.click()}
              aria-label="Attach file"
            />
          }
        >
          {/* The clip's weight sits in its upper loop; 1px down reads as centered on the row. */}
          <PaperclipIcon className="translate-y-px" />
        </TooltipTrigger>
        <TooltipPopup side="top">Attach file (paste or drag and drop also work)</TooltipPopup>
      </Tooltip>
    </>
  );
}

/**
 * Drop handlers for a composer frame and whether files hover over it. While a composer is on the
 * page a file dropped elsewhere does nothing, instead of the browser leaving maru to show the file.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const guard = (event: globalThis.DragEvent) => {
      if (dragHasFiles(event.dataTransfer)) event.preventDefault();
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, [enabled]);
  const handlers = {
    onDragEnter: (event: DragEvent) => {
      if (!enabled || !dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!enabled || !dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: DragEvent) => {
      if (!enabled || !dragHasFiles(event.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (event: DragEvent) => {
      if (!enabled || !dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current = 0;
      setOver(false);
      onFiles(Array.from(event.dataTransfer.files));
    },
  };
  return { over, handlers };
}

/** The frame's highlight while files hover over it. */
export function DropHint(props: { show: boolean; children?: ReactNode; className?: string }) {
  if (!props.show) return null;
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] border-2 border-dashed border-primary/60 bg-primary/10 text-sm font-medium text-foreground",
        props.className,
      )}
    >
      {props.children ?? "Drop to attach"}
    </div>
  );
}
