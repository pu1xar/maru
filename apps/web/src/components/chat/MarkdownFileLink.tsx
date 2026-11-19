// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: apps/web/src/components/chat/MarkdownFileLink.tsx, apps/web/src/components/ContextChip.tsx
// (contextChipVariants with kind "neutral", ContextChipLabel) and chat/FileTagChip.tsx.
// Local changes: a click opens the file in the right panel at its line, T3's default action
// (handleOpenInFilePreview); T3's editor, browser and media targets and its context menu are left
// out. Outside a session view the chip only shows the path. The icon is lucide's file or folder
// icon instead of T3's Pierre file-type icons.
import { FileIcon, FolderIcon } from "lucide-react";
import { memo } from "react";

import type { FileLookup } from "@maru/shared";
import { cn } from "~/lib/utils";
import { useFileOpen } from "~/rightPanel";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const MARKDOWN_FILE_LINK_CLASS_NAME = "chat-markdown-file-link";

// T3 contextChipVariants base classes with the neutral accent.
const CONTEXT_CHIP_CLASS_NAME =
  "inline-flex max-w-full items-center gap-[0.2em] font-medium leading-[normal] text-(--context-chip-ink) [--context-chip-ink:var(--context-chip-accent)] [--document-icon-stroke:var(--context-chip-ink)] [&_svg]:block [&_svg]:size-[1em] [&_svg]:shrink-0 [&_svg]:self-center [button&,a&,[data-popup-open]&]:cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current rounded-sm disabled:cursor-default [--context-chip-accent:currentColor]";

// T3 ContextChipLabel classes.
const CONTEXT_CHIP_LABEL_CLASS_NAME =
  "block min-w-0 self-baseline overflow-x-clip text-ellipsis whitespace-nowrap underline decoration-transparent decoration-1 underline-offset-[0.2em] transition-colors motion-reduce:transition-none [:is(button:enabled,a):hover>&]:decoration-current";

export const MarkdownFileLink = memo(function MarkdownFileLink({
  targetPath,
  filePath,
  line,
  endLine,
  lookup,
  label,
  copyMarkdown,
}: {
  /** The resolved path with its position, shown in the tooltip. */
  targetPath: string;
  /** The resolved path without its position. */
  filePath: string;
  line?: number;
  endLine?: number;
  /** The link as written, when relative, and the folder to look in when `filePath` is missing. */
  lookup?: FileLookup;
  label: string;
  /** Markdown the chip copies as (markdown-clipboard reads `data-markdown-copy`). */
  copyMarkdown: string;
}) {
  const open = useFileOpen();
  const isFolder = /[\\/]$/.test(targetPath);
  const Icon = isFolder ? FolderIcon : FileIcon;
  const path = filePath.replace(/[\\/]+$/, "") || "/";
  const target = {
    path,
    ...(line !== undefined ? { line } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
    ...(lookup ? { lookup } : {}),
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          open ? (
            <button
              type="button"
              dir="ltr"
              className={cn(CONTEXT_CHIP_CLASS_NAME, MARKDOWN_FILE_LINK_CLASS_NAME)}
              data-slot="context-chip"
              data-markdown-copy={copyMarkdown}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                open(target);
              }}
            />
          ) : (
            <span
              dir="ltr"
              tabIndex={0}
              className={cn(CONTEXT_CHIP_CLASS_NAME, MARKDOWN_FILE_LINK_CLASS_NAME)}
              data-slot="context-chip"
              data-markdown-copy={copyMarkdown}
            />
          )
        }
      >
        <Icon aria-hidden />
        <span className={CONTEXT_CHIP_LABEL_CLASS_NAME} data-slot="context-chip-label">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top" variant="code">
        {targetPath}
      </TooltipPopup>
    </Tooltip>
  );
});
