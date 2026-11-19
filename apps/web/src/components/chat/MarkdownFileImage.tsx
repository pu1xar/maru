// A picture a message names by file path (DESIGN.md 6e, "채팅의 그림 경로"): a small preview under
// the path's file chip. The bytes come from GET /api/file/raw, the route the right panel's image tab
// reads, so the server's request checks apply unchanged. The browser loads the image lazily (only
// rows the virtualized timeline mounts hold an <img>) and scales a large one down itself. A click
// opens the picture in the same dialog the attachment pictures use. A file that is missing or
// unreadable leaves the chip alone.
import { fileRawUrl } from "@maru/shared";
import { useState } from "react";

import { ImagePreviewDialog } from "./ImagePreviewDialog";

export function MarkdownFileImage(props: { path: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  if (failed) return null;
  const src = fileRawUrl(props.path);
  return (
    <span data-markdown-file-image="" data-markdown-copy="" data-thread-find-ignore className="my-1 block">
      <button
        type="button"
        aria-label={`Enlarge ${props.name}`}
        className="block max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-border/60 bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => setOpen(true)}
      >
        <img
          src={src}
          alt={props.name}
          decoding="async"
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
          className="block h-auto max-h-48 w-auto max-w-[min(100%,20rem)] object-contain"
        />
      </button>
      {open ? <ImagePreviewDialog images={[{ src, name: props.name }]} index={0} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}
