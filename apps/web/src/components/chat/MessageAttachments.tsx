// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/TimelineUserMessageRow.tsx (the media block: pictures in a
// two-column grid of 4:3 tiles inside the bubble, a lone picture at its own shape when the message
// has no words, files as rows under them, a click opens the expanded preview). Local changes: the
// pictures come from the server's transcript blobs and stored files (lib/composerAttachments.logic.ts
// sentMessageAttachments), a file row opens the file in the right panel, no video, audio, SnapShot
// or context chips, Korean labels.
import { FileIcon, ImageOffIcon } from "lucide-react";
import { useState } from "react";

import type { SentAttachment } from "~/lib/composerAttachments.logic";
import { useFileOpen } from "~/rightPanel";
import { cn } from "~/lib/utils";
import { ImagePreviewDialog } from "./ImagePreviewDialog";

export function MessageAttachments(props: { attachments: readonly SentAttachment[]; standalone: boolean }) {
  const open = useFileOpen();
  const [preview, setPreview] = useState<number | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  if (props.attachments.length === 0) return null;
  const pictures = props.attachments.filter((a) => a.kind === "image" && a.url !== null && !failed.has(a.url));
  const rows = props.attachments.filter((a) => !pictures.includes(a));
  const lone = props.standalone && pictures.length === 1;
  return (
    <div data-message-attachments="" className={cn("flex flex-col gap-1", !props.standalone && "mb-2")}>
      {pictures.length > 0 ? (
        <div className={cn("grid", lone ? "max-w-full" : "max-w-[210px] grid-cols-2 gap-2")}>
          {pictures.map((a, i) => (
            <div key={a.key} className={cn("bg-background/70", lone ? "overflow-hidden rounded-xl" : "aspect-[4/3] overflow-hidden rounded-lg border border-border/80")}>
              <button type="button" className="block h-full w-full cursor-zoom-in" aria-label={`Enlarge ${a.name}`} onClick={() => setPreview(i)}>
                <img
                  src={a.url!}
                  alt={a.name}
                  decoding="async"
                  loading="lazy"
                  draggable={false}
                  onError={() => setFailed((prev) => new Set(prev).add(a.url!))}
                  className={cn("block", lone ? "h-48 w-auto min-w-24 max-w-full object-cover" : "size-full object-cover")}
                />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {rows.map((a) => {
        const Icon = a.kind === "image" ? ImageOffIcon : FileIcon;
        const label = (
          <>
            <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{a.name}</span>
          </>
        );
        return a.path && open ? (
          <button
            key={a.key}
            type="button"
            title={a.path}
            onClick={() => open({ path: a.path! })}
            className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md py-1 text-left text-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {label}
          </button>
        ) : (
          <div key={a.key} className="flex min-w-0 items-center gap-2 py-1 text-sm" title={a.path ?? a.name}>
            {label}
          </div>
        );
      })}
      {preview !== null ? (
        <ImagePreviewDialog images={pictures.map((a) => ({ src: a.url!, name: a.name }))} index={preview} onClose={() => setPreview(null)} />
      ) : null}
    </div>
  );
}
