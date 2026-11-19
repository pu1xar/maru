// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/ExpandedImageDialog.tsx (media dialog, close button in the
// corner, previous and next buttons with the arrow keys, the name and position under the picture,
// focus back to the opener). Local changes: pictures only (no video, SnapShot text or media actions
// menu), the picture fits the window instead of T3's ZoomableImage pan and zoom, and "원본 열기"
// opens the bytes in a new tab at full size. Labels are Korean.
import { ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";

import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

export interface PreviewImage {
  src: string;
  name: string;
}

export function ImagePreviewDialog(props: { images: readonly PreviewImage[]; index: number; onClose: () => void }) {
  const [offset, setOffset] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [returnFocus] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const count = props.images.length;
  const index = count > 0 ? (((props.index + offset) % count) + count) % count : 0;
  const item = props.images[index];
  // The host unmounts the dialog outright, so focus goes back to the opener here (T3 does the same).
  const close = () => {
    flushSync(props.onClose);
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (count <= 1 || event.defaultPrevented) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    setOffset((o) => o + (event.key === "ArrowLeft" ? -1 : 1));
  };
  if (!item) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-start-1 h-full max-h-[92vh] w-[92vw] max-w-[92vw] items-center justify-center overflow-visible [--media-width:92vw] [--media-height:calc(100vh-160px)] sm:[--media-width:calc(92vw-96px)]"
        onKeyDown={onKeyDown}
        initialFocus={closeRef}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <DialogTitle className="sr-only">Enlarged image</DialogTitle>
        <Button ref={closeRef} type="button" size="icon-sm" variant="media-close" className="absolute right-0 top-0 z-20" onClick={close} aria-label="Close">
          <XIcon />
        </Button>
        {count > 1 ? (
          <Button
            type="button"
            size="icon"
            variant="media-navigation"
            className="left-0 top-auto bottom-0 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
            aria-label="Previous image"
            onClick={() => setOffset((o) => o - 1)}
          >
            <ChevronLeftIcon className="size-5" />
          </Button>
        ) : null}
        <div className="relative isolate z-10 flex max-h-full max-w-[var(--media-width)] flex-col items-center">
          {failed === item.src ? (
            <div role="alert" className="flex h-48 w-[min(var(--media-width),32rem)] items-center justify-center rounded-lg border border-border/70 bg-black p-6 text-center text-sm text-white">
              Could not load the image. The file may have been moved or deleted.
            </div>
          ) : (
            <img
              key={item.src}
              src={item.src}
              alt={item.name}
              data-image-preview=""
              draggable={false}
              onError={() => setFailed(item.src)}
              className="block h-auto max-h-[var(--media-height)] w-auto max-w-[var(--media-width)] rounded-lg border border-border/70 object-contain shadow-2xl"
            />
          )}
          <div className="mt-2 flex max-w-[var(--media-width)] items-center justify-center gap-2 text-xs text-white/80 max-sm:px-10">
            <span className="truncate" aria-live="polite" aria-atomic="true">
              {item.name}
              {count > 1 ? ` (${index + 1}/${count})` : ""}
            </span>
            <a href={item.src} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-white/80 underline-offset-2 hover:text-white hover:underline">
              <ExternalLinkIcon aria-hidden className="size-3" />
              Open original
            </a>
          </div>
        </div>
        {count > 1 ? (
          <Button
            type="button"
            size="icon"
            variant="media-navigation"
            className="right-0 top-auto bottom-0 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
            aria-label="Next image"
            onClick={() => setOffset((o) => o + 1)}
          >
            <ChevronRightIcon className="size-5" />
          </Button>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
