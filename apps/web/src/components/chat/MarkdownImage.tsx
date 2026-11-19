// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: apps/web/src/components/chat/ChatMarkdownMedia.tsx (ChatMarkdownImage,
// ChatMarkdownImageFallback, markdownImageCopy, authoredImageSizeStyle) and
// packages/client-runtime/src/markdownImages.ts (the direct source pattern).
// Local changes: only direct sources (http, https, blob, protocol-relative) load, as T3 loads
// them. T3 turns workspace and host file paths into signed asset URLs through its server and
// plays video and audio; this viewer has no asset route, so those show the unavailable label.
// The expand dialog and media actions menu are left out.
import { TriangleAlertIcon } from "lucide-react";
import { useState, type ComponentProps, type CSSProperties } from "react";

import { cn } from "~/lib/utils";

const DIRECT_IMAGE_SOURCE_PATTERN = /^(?:https?:|data:|blob:|\/\/)/i;

const CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME = "max-w-[min(100%,30rem)]";
const CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME = cn(
  "max-h-[30rem]",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
);
const CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME = "inline-block!";
const CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME = cn(
  "h-auto w-auto object-contain",
  CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
);

export function isDirectMarkdownImageSource(source: string): boolean {
  return DIRECT_IMAGE_SOURCE_PATTERN.test(source);
}

export function resolveProtocolRelativeMediaUrl(src: string): string {
  if (!src.startsWith("//")) return src;
  const protocol =
    typeof window !== "undefined" && window.location.protocol === "http:" ? "http:" : "https:";
  return `${protocol}${src}`;
}

export function markdownImageCopy(alt: string, src: string, title: string | undefined): string {
  const escapedAlt = alt.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  const titleSuffix =
    title === undefined ? "" : ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return `![${escapedAlt}](${markdownDestination(src)}${titleSuffix})`;
}

// Raw HTML sources keep spaces and parentheses that a bare Markdown destination cannot hold.
function markdownDestination(src: string): string {
  if (!/[\s<>()]/.test(src)) return src;
  const escaped = src
    .replaceAll("\\", "\\\\")
    .replaceAll("<", "\\<")
    .replaceAll(">", "\\>")
    .replaceAll("\n", "%0A")
    .replaceAll("\r", "%0D");
  return `<${escaped}>`;
}

function parseImageDimension(value: string | number | undefined): number {
  return Number(typeof value === "string" ? value.trim().replace(/px$/i, "") : value);
}

export function authoredImageSizeStyle(
  width: string | number | undefined,
  height: string | number | undefined,
  maxHeightRem = 30,
): CSSProperties | undefined {
  const parsedWidth = parseImageDimension(width);
  const parsedHeight = parseImageDimension(height);
  const hasWidth = Number.isFinite(parsedWidth) && parsedWidth > 0;
  const hasHeight = Number.isFinite(parsedHeight) && parsedHeight > 0;
  if (hasWidth && hasHeight) {
    return {
      width: parsedWidth,
      height: "auto",
      aspectRatio: `${parsedWidth} / ${parsedHeight}`,
      maxWidth: `min(100%, 30rem, ${(maxHeightRem * parsedWidth) / parsedHeight}rem)`,
    };
  }
  if (hasWidth) return { maxWidth: `min(100%, 30rem, ${parsedWidth}px)` };
  if (hasHeight) return { maxHeight: `min(30rem, ${parsedHeight}px)` };
  return undefined;
}

export function ChatMarkdownImageFallback(props: {
  readonly alt: string;
  readonly copyMarkdown?: string | undefined;
}) {
  return (
    <span
      data-markdown-copy={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        "rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground",
      )}
    >
      <span data-thread-find-ignore className="inline-flex items-center gap-1.5">
        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
        {["Image cannot be shown", props.alt].filter(Boolean).join(", ")}
      </span>
    </span>
  );
}

export function ChatMarkdownImage(props: {
  readonly src: string;
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === props.src) {
    return <ChatMarkdownImageFallback alt={props.alt} copyMarkdown={props.copyMarkdown} />;
  }
  return (
    <img
      {...props.imageProps}
      src={props.src}
      alt={props.alt}
      data-markdown-copy={props.copyMarkdown}
      decoding="async"
      loading="lazy"
      draggable={false}
      className={cn(CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME, props.className)}
      style={props.style}
      onError={() => setFailedSrc(props.src)}
    />
  );
}
