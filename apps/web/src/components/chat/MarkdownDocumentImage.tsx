// A picture a Markdown document names by file path, drawn as the picture itself at the width of the
// text (DESIGN.md 6e, "파일 보기의 Markdown 그림"), where a chat message draws a chip with a small
// preview (MarkdownFileImage.tsx). The bytes come from GET /api/file/raw, so the server's request
// checks apply unchanged. A click opens the same dialog the attachment pictures use. A file that is
// missing or unreadable draws `fallback` (the file chip) instead.
import { fileRawUrl } from "@maru/shared";
import { useState, type CSSProperties, type ReactNode } from "react";

import { ImagePreviewDialog } from "./ImagePreviewDialog";

function authoredWidth(width: string | number | undefined): CSSProperties | undefined {
  const parsed = Number(typeof width === "string" ? width.trim().replace(/px$/i, "") : width);
  return Number.isFinite(parsed) && parsed > 0 ? { maxWidth: `min(100%, ${parsed}px)` } : undefined;
}

export function MarkdownDocumentImage(props: {
  path: string;
  name: string;
  alt: string;
  copyMarkdown: string;
  width?: string | number | undefined;
  fallback: ReactNode;
}) {
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  if (failedPath === props.path) return <>{props.fallback}</>;
  const src = fileRawUrl(props.path);
  return (
    <span data-markdown-document-image="" data-markdown-copy={props.copyMarkdown} className="my-2 block">
      <button
        type="button"
        aria-label={`Enlarge ${props.name}`}
        className="inline-block max-w-full cursor-zoom-in align-top focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => setOpen(true)}
      >
        <img
          src={src}
          alt={props.alt || props.name}
          decoding="async"
          loading="lazy"
          draggable={false}
          onError={() => setFailedPath(props.path)}
          className="block h-auto max-w-full rounded-md"
          style={authoredWidth(props.width)}
        />
      </button>
      {open ? <ImagePreviewDialog images={[{ src, name: props.name }]} index={0} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}
