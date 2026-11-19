// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: apps/web/src/components/chat/MarkdownExternalLink.tsx and
// apps/web/src/components/chat/externalLinkContextMenu.ts (resolveExternalWebLinkHost).
// Local change: every web link shows T3's fallback globe icon. T3 loads a favicon per host from
// Google's favicon service and a brand icon for source control hosts; this viewer sends link
// hosts nowhere.
import { GlobeIcon } from "lucide-react";
import { Children, type ReactNode } from "react";

function resolveExternalWebLink(href: string | null | undefined): URL | null {
  if (!href) return null;
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export function resolveExternalWebLinkHost(href: string | undefined): string | null {
  return resolveExternalWebLink(href)?.hostname || null;
}

// Inline-level and selectable: triple-click selection stops at block-level and select-none boxes.
const MARKDOWN_LINK_FAVICON_CLASS_NAME = "inline-block size-[14px] [vertical-align:-0.125em]";

function MarkdownLinkFavicon() {
  return (
    <span className="ms-[0.25em] me-[0.2em]" aria-hidden>
      <GlobeIcon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />
    </span>
  );
}

function leadingExternalLinkTextLength(text: string): number {
  const protocol = /^(?:https?:\/\/)/i.exec(text)?.[0];
  if (protocol) return protocol.length;
  // A whole code point, so a surrogate pair is not split across elements.
  return Array.from(text.slice(0, 2))[0]?.length ?? 0;
}

// Keep short labels such as PR numbers intact in narrow table columns.
function breakableExternalLinkText(text: string): ReactNode[] {
  return Array.from(text.matchAll(/\s+|\S+/g), ({ 0: word, index: start }) =>
    word.length <= 16 ? (
      word
    ) : (
      <span key={start} className="[overflow-wrap:anywhere]">
        {word}
      </span>
    ),
  );
}

export function MarkdownExternalLinkContent({
  plainText,
  children,
}: {
  plainText: string | null;
  children: ReactNode;
}) {
  if (plainText) {
    const leadingLength = leadingExternalLinkTextLength(plainText);
    return (
      <>
        <span className="whitespace-nowrap">
          <MarkdownLinkFavicon />
          {plainText.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(plainText.slice(leadingLength))}
      </>
    );
  }

  const childNodes = Children.toArray(children);
  const firstChild = childNodes[0];

  if (typeof firstChild === "string" && firstChild.length > 0) {
    const leadingLength = leadingExternalLinkTextLength(firstChild);
    return (
      <>
        <span className="whitespace-nowrap">
          <MarkdownLinkFavicon />
          {firstChild.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(firstChild.slice(leadingLength))}
        {childNodes.slice(1)}
      </>
    );
  }

  return (
    <>
      <span className="[overflow-wrap:anywhere]">
        <MarkdownLinkFavicon />
        {firstChild}
      </span>
      {childNodes.slice(1)}
    </>
  );
}
