// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/MarkdownMermaidCodeBlock.tsx
// Local changes: the diagram component is loaded with React.lazy (DESIGN.md 7g); a source that did
// not draw falls back to the code block with one error line above it (T3 keeps its error inside
// the diagram component); "Expand diagram" opens the existing ImagePreviewDialog on a blob URL
// of the drawn SVG (T3 hands the URL to its media viewer); labels are fixed English.
import { CodeIcon, WorkflowIcon } from "lucide-react";
import { Suspense, lazy, use, useEffect, useState, type ReactNode } from "react";

import { serializeCodeBlockToMarkdown } from "~/markdown-clipboard";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ImagePreviewDialog } from "./ImagePreviewDialog";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { mermaidBlockView, mermaidFailureLine } from "./MarkdownMermaid.logic";
import { findRevealRef, MarkdownFindContext } from "./markdownFindContext";

const MermaidDiagram = lazy(() => import("./MermaidDiagram"));

export function MarkdownMermaidCodeBlock({
  code,
  fenceTitle,
  open,
  children,
}: {
  code: string;
  fenceTitle: string | null;
  /** The block is the last of a streamed answer and its closing fence has not arrived. */
  open: boolean;
  /** The ordinary code block's <pre>, shown for the source view and when drawing fails. */
  children: ReactNode;
}) {
  const [showCode, setShowCode] = useState(false);
  // The failure belongs to one source; a changed source gets a fresh attempt.
  const [failure, setFailure] = useState<{ code: string; error: unknown } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const searching = use(MarkdownFindContext);
  const failed = failure?.code === code ? failure : null;
  const view = mermaidBlockView({ code, open, showCode, failed: failed !== null });
  const diagram = view === "diagram";

  // The blob URL lives while the dialog is open.
  useEffect(() => {
    if (expanded === null) return;
    return () => URL.revokeObjectURL(expanded);
  }, [expanded]);

  const toggleLabel = showCode ? "Show diagram" : "Show code";
  const toggle =
    open || failed ? null : (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              onClick={() => setShowCode((value) => !value)}
              aria-label={toggleLabel}
            />
          }
        >
          {showCode ? <WorkflowIcon className="size-3" /> : <CodeIcon className="size-3" />}
        </TooltipTrigger>
        <TooltipPopup side="top">{toggleLabel}</TooltipPopup>
      </Tooltip>
    );

  const source = (
    <MarkdownCodeBlock
      code={code}
      language="mermaid"
      fenceTitle={fenceTitle}
      canWrap
      viewToggle={toggle}
    >
      {children}
    </MarkdownCodeBlock>
  );

  if (!diagram) {
    if (!failed) return source;
    const line = mermaidFailureLine(failed.error);
    return (
      <>
        <p
          role="status"
          data-thread-find-ignore
          title={line.detail}
          className="mt-[0.65rem] mb-0 text-xs text-error-foreground"
        >
          {line.summary}
        </p>
        {source}
      </>
    );
  }

  return (
    <MarkdownCodeBlock
      code={code}
      language="mermaid"
      fenceTitle={fenceTitle}
      canWrap={false}
      diagram
      viewToggle={toggle}
    >
      <div
        className="chat-markdown-mermaid overflow-x-auto"
        data-markdown-mermaid=""
        data-markdown-copy={serializeCodeBlockToMarkdown(code, "mermaid")}
      >
        <RenderErrorBoundary
          resetKeys={[code]}
          fallback={<MermaidCrash code={code} onCrash={setFailure} />}
        >
          <Suspense
            fallback={
              <span
                data-thread-find-ignore
                className="flex h-12 items-center justify-center text-xs text-muted-foreground"
              >
                Drawing diagram
              </span>
            }
          >
            <MermaidDiagram
              source={code}
              onFailed={(error) => setFailure({ code, error })}
              onExpand={(svg) => {
                void import("./MermaidDiagram").then((module) =>
                  setExpanded(module.diagramImageUrl(svg)),
                );
              }}
            />
          </Suspense>
        </RenderErrorBoundary>
        {searching ? (
          <pre
            ref={findRevealRef(() => setShowCode(true))}
            hidden
            aria-hidden
            data-markdown-find-source=""
          >
            {code}
          </pre>
        ) : null}
      </div>
      {expanded !== null ? (
        <ImagePreviewDialog
          images={[{ src: expanded, name: "Mermaid diagram" }]}
          index={0}
          onClose={() => setExpanded(null)}
        />
      ) : null}
    </MarkdownCodeBlock>
  );
}

/** The diagram component threw (the chunk did not load, say): report it and show the code. */
function MermaidCrash({
  code,
  onCrash,
}: {
  code: string;
  onCrash: (failure: { code: string; error: unknown }) => void;
}) {
  useEffect(() => {
    onCrash({ code, error: new Error("The diagram renderer failed to load") });
  }, [code, onCrash]);
  return null;
}
