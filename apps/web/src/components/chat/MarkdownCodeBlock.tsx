// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/MarkdownCodeBlock.tsx
// Local changes: T3 highlights with @pierre/diffs and Shiki through SuspenseShikiCodeBlock; here
// ChatMarkdown keeps its <pre> and puts `MarkdownCodeBlockCode` inside it, which colors the code
// with lib/syntaxHighlight.ts (highlight.js, theme-token colors) once that loads. The frame,
// header and actions keep T3's layout; the frame's background, border color and text color come
// from index.css (the chat code surface tokens, which Settings can recolor) instead of T3's
// secondary and input tints. The header names the language in text instead of a Pierre file icon.
// "Run in terminal" is left out (this viewer sends nothing to a terminal).
// Line wrap starts from T3's `wordWrap` setting default (true).
import { CheckIcon, CopyIcon, FileTextIcon, WrapTextIcon } from "lucide-react";
import { useState, type ElementType, type HTMLAttributes, type ReactNode } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { resolveSyntaxLanguage } from "~/lib/syntaxLanguages";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure } from "./markdownActionFailure";
import { SyntaxTokens, useSyntaxTokens } from "./SyntaxHighlight";

/** T3's `wordWrap` client setting default. */
const DEFAULT_CODE_WRAP = true;

const THREAD_FIND_IGNORE_PROPS = {
  "data-thread-find-ignore": "",
} as HTMLAttributes<HTMLDivElement>;

export function MarkdownCodeBlockFrame({
  as: Wrapper = "div",
  language,
  fenceTitle,
  wrapped = true,
  title,
  actions,
  headerProps,
  children,
}: {
  as?: ElementType;
  language: string;
  fenceTitle: string | null;
  wrapped?: boolean;
  title?: ReactNode;
  actions?: ReactNode;
  headerProps?: HTMLAttributes<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <Wrapper
      dir="ltr"
      className="chat-markdown-codeblock my-[0.65rem] text-start overflow-hidden rounded-lg border leading-snug"
      data-language={language}
      data-wrap={wrapped ? "true" : "false"}
    >
      <div
        {...headerProps}
        className={cn(
          "chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none",
          headerProps?.className,
        )}
      >
        {title ?? (
          <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-2xs">
            <MarkdownCodeBlockTitleContent fenceTitle={fenceTitle} language={language} />
          </span>
        )}
        {actions}
      </div>
      {children}
    </Wrapper>
  );
}

function MarkdownCodeBlockTitleContent({
  fenceTitle,
  language,
}: {
  fenceTitle: string | null;
  language: string;
}) {
  if (fenceTitle) {
    return (
      <>
        <FileTextIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{fenceTitle}</span>
      </>
    );
  }
  return <span className="truncate">{language}</span>;
}

/**
 * A fenced block's <code>: the parsed element (`children`) until the highlighter has tokens for
 * it, then the same text as colored spans. A fence language with no grammar stays plain.
 */
export function MarkdownCodeBlockCode({
  code,
  language,
  className,
  children,
}: {
  code: string;
  language: string;
  className: string | undefined;
  children: ReactNode;
}) {
  const tokens = useSyntaxTokens(code, resolveSyntaxLanguage(language));
  if (tokens === null) return children;
  return (
    <code className={className}>
      <SyntaxTokens tokens={tokens} />
    </code>
  );
}

export function MarkdownCodeBlock({
  code,
  language,
  fenceTitle,
  viewToggle,
  canWrap = true,
  diagram = false,
  children,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  viewToggle?: ReactNode;
  canWrap?: boolean;
  diagram?: boolean;
  children: ReactNode;
}) {
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard({
    timeout: 1200,
    onError: (cause) =>
      reportMarkdownActionFailure(
        {
          operation: "copy-code-block",
          language,
          ...(fenceTitle ? { fenceTitle } : {}),
        },
        cause,
      ),
  });
  const [wrapOverride, setWrapOverride] = useState<boolean | null>(null);
  const wrapped = wrapOverride ?? DEFAULT_CODE_WRAP;
  const wrapLabel = wrapped ? "Unwrap lines" : "Wrap lines";
  const copyLabel = copied ? "Copied" : "Copy code";

  const handleCopy = () => copyToClipboard(code);

  const copyButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            onClick={handleCopy}
            aria-label={copyLabel}
          />
        }
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{copyLabel}</TooltipPopup>
    </Tooltip>
  );

  if (diagram) {
    return (
      <div className="my-[0.65rem] border border-transparent" data-language={language}>
        <div className="flex items-center justify-end gap-0.5 pt-1.5 pr-1.5 select-none">
          {viewToggle}
          {copyButton}
        </div>
        {children}
      </div>
    );
  }

  return (
    <MarkdownCodeBlockFrame
      language={language}
      fenceTitle={fenceTitle}
      wrapped={wrapped}
      headerProps={THREAD_FIND_IGNORE_PROPS}
      actions={
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Code block actions">
          {canWrap ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant={wrapped ? "secondary" : "ghost-muted"}
                    size="icon-xs"
                    aria-pressed={wrapped}
                    onClick={() => setWrapOverride(!wrapped)}
                    aria-label={wrapLabel}
                  />
                }
              >
                <WrapTextIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
          {viewToggle}
          {copyButton}
        </span>
      }
    >
      {children}
    </MarkdownCodeBlockFrame>
  );
}
