// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/V2ItemInspector.tsx
// Local changes: the item on the wire is the whole detail, so nothing is fetched or streamed
// (T3 fetches omitted output with useTurnItemDetail and subscribes to live command output).
// JSON, commands and diffs take their colors from SyntaxHighlight.tsx (highlight.js and theme
// tokens) instead of the @pierre/diffs highlighter. Tool output images and the "Open diff" button
// are gone; a file change shows its diff here, with line numbers, tinted added and removed lines
// and the file's syntax colors. A notice's folded body (`x.body`) shows below its message.
// UI text is Korean.
import type { OrchestrationV2ProjectedTurnItem } from "@maru/shared";
import { ExternalLinkIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import {
  isJsonToolText,
  toolCallLines,
  turnItemOutputText,
} from "../../client-runtime/work-log/itemDetail.ts";
import { formatWorkspaceRelativePath } from "../../filePathDisplay.ts";
import type { SyntaxLanguage } from "../../lib/syntaxLanguages.ts";
import { cn } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import {
  diffHunkLanguages,
  highlightDiffRows,
  parseUnifiedDiff,
  type DiffLineType,
} from "./diffView.logic";
import { ShellCommandBlock } from "./ShellCommandBlock";
import { HighlightedText, SyntaxTokens, useSyntaxEngine } from "./SyntaxHighlight";
import { useInitialOutputReady } from "./timelineRowContext";

interface V2ItemInspectorProps {
  readonly onInitialOutputReady?: (() => void) | undefined;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly cwd?: string | undefined;
  readonly workspaceRoot?: string | undefined;
}

const DIFF_COUNT_FORMAT = new Intl.NumberFormat("en-US");

function formatDiffCount(count: number): string {
  return DIFF_COUNT_FORMAT.format(count);
}

/** Only web links open from a search result. */
function resolveExternalWebLinkHref(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Tool output and diffs: text-2xs at the chat code text size (index.css --chat-code-ratio). */
const monoClassName =
  "font-mono text-(length:--font-size-code,calc(var(--text-2xs)*var(--chat-code-ratio,1))) leading-relaxed whitespace-pre-wrap break-words select-text";

/** JSON objects and arrays; a bare `14` or `true` from a command is just output. */
function isJsonDocumentText(text: string): boolean {
  return /^\s*[[{]/.test(text) && isJsonToolText(text);
}

/**
 * A value as preformatted text. Objects print as JSON; `highlightJson` colors a string that is a
 * JSON document (a tool's output or arguments) as JSON too.
 */
function StructuredValue({
  value,
  highlightJson = false,
  framed = false,
}: {
  readonly value: unknown;
  readonly highlightJson?: boolean;
  /** A tool's output: a thin border sets it apart from the call above it (TOOL_OUTPUT_FRAME). */
  readonly framed?: boolean;
}) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return null;
  const language: SyntaxLanguage | null =
    typeof value !== "string" || (highlightJson && isJsonDocumentText(text)) ? "json" : null;
  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto",
        framed && TOOL_OUTPUT_FRAME,
        language === null ? "text-muted-foreground" : "text-foreground/85",
        monoClassName,
      )}
    >
      <HighlightedText code={text} language={language} />
    </pre>
  );
}

const DIFF_LINE_CLASS_NAMES: Record<DiffLineType, string> = {
  context: "",
  add: "bg-diff-addition/10",
  del: "bg-diff-deletion/10",
};

const DIFF_MARKERS: Record<DiffLineType, string> = { context: " ", add: "+", del: "-" };

/**
 * A unified diff as rows: old and new line numbers, a +/- column, and the line in its file's
 * syntax colors. Long lines wrap, so the numbers never scroll away from their lines.
 */
function DiffView({ diff, path }: { readonly diff: string; readonly path: string }) {
  const parsed = parseUnifiedDiff(diff);
  const languages = diffHunkLanguages(parsed, path);
  const engine = useSyntaxEngine(languages.some((language) => language !== null));
  const tokensByRow = engine
    ? highlightDiffRows(parsed, languages, engine.highlightSyntaxCached)
    : null;
  const numberWidth = `${Math.max(2, String(parsed.maxLineNumber).length)}ch`;
  return (
    <div
      className={cn(
        "max-h-96 overflow-auto rounded-md border border-border/45 bg-muted/15 py-1",
        monoClassName,
      )}
      data-diff-view=""
    >
      {parsed.rows.map((row, index) => {
        // Rows of one diff string keep their positions.
        if (row.kind === "file") {
          return parsed.fileCount > 1 ? (
            <div key={index} className="px-2 pt-1 pb-0.5 text-muted-foreground wrap-anywhere">
              {formatWorkspaceRelativePath(row.path, undefined)}
            </div>
          ) : null;
        }
        if (row.kind === "hunk" || row.kind === "note") {
          return (
            <div key={index} className="px-2 text-muted-foreground wrap-anywhere">
              {row.text}
            </div>
          );
        }
        const tokens = tokensByRow?.get(index);
        return (
          <div key={index} className={cn("flex min-w-0", DIFF_LINE_CLASS_NAMES[row.type])}>
            <span
              aria-hidden
              className="shrink-0 ps-2 text-end text-muted-foreground tabular-nums select-none"
              style={{ width: `calc(${numberWidth} + 0.5rem)` }}
            >
              {row.oldNumber ?? ""}
            </span>
            <span
              aria-hidden
              className="shrink-0 ps-2 text-end text-muted-foreground tabular-nums select-none"
              style={{ width: `calc(${numberWidth} + 0.5rem)` }}
            >
              {row.newNumber ?? ""}
            </span>
            <span
              className={cn(
                "w-[3ch] shrink-0 text-center select-none",
                row.type === "add"
                  ? "text-diff-addition-foreground"
                  : row.type === "del"
                    ? "text-diff-deletion-foreground"
                    : undefined,
              )}
            >
              {DIFF_MARKERS[row.type]}
            </span>
            <span className="min-w-0 flex-1 pe-2 text-foreground/85 wrap-anywhere">
              {tokens ? <SyntaxTokens tokens={tokens} /> : row.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The border around a tool's output (user request 2026-11-19: a command's result read as part of
 * the highlighted command above it). Only the border: no fill, the text colors stay. Android's
 * WorkRows "output" block draws the same frame.
 */
const TOOL_OUTPUT_FRAME = "rounded-md border border-border/60 px-2 py-1.5";

function ToolOutput({ output }: { readonly output: string | null }) {
  return output ? <StructuredValue value={output} highlightJson framed /> : null;
}

function ToolCallBody(props: {
  readonly command?: string;
  readonly args?: unknown;
  readonly output: string | null;
  readonly exitCode?: number | undefined;
}) {
  const call = toolCallLines({ command: props.command, args: props.args });
  return (
    <div className={cn("space-y-1.5", monoClassName)}>
      {call.command ? <ShellCommandBlock command={call.command} /> : null}
      {call.args ? (
        <div className="text-foreground/85">
          {call.args.map(([key, value]) => (
            <div key={key}>
              <span className="text-muted-foreground">{key} </span>
              {isJsonDocumentText(value) ? (
                <StructuredValue value={value} highlightJson />
              ) : (
                value
              )}
            </div>
          ))}
        </div>
      ) : null}
      {call.argsText ? <StructuredValue value={call.argsText} highlightJson /> : null}
      <ToolOutput output={props.output} />
      {props.exitCode !== undefined && props.exitCode !== 0 ? (
        <div className="text-destructive-foreground">exit {props.exitCode}</div>
      ) : null}
    </div>
  );
}

function Section({ children }: { readonly children: ReactNode }) {
  return <div className="space-y-2">{children}</div>;
}

export const V2ItemInspector = memo(function V2ItemInspector(props: V2ItemInspectorProps) {
  const item = props.projectedItem.item;
  const body = props.projectedItem.x?.body;
  useInitialOutputReady(false, props.onInitialOutputReady);
  return (
    <div className="space-y-2 text-xs" data-v2-item-inspector={item.type}>
      {item.type === "reasoning" && item.text ? (
        <div className="rounded-md border border-border/45 bg-muted/15 p-2 italic text-muted-foreground">
          <ChatMarkdown text={item.text} cwd={props.cwd} lineBreaks />
        </div>
      ) : null}

      {item.type === "command_execution" ? (
        <ToolCallBody
          command={item.input}
          exitCode={item.exitCode}
          output={turnItemOutputText(item)}
        />
      ) : null}

      {item.type === "file_change" ? (
        <Section>
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 font-mono text-muted-foreground wrap-anywhere">
              {formatWorkspaceRelativePath(item.fileName, props.workspaceRoot)}
            </span>
            {item.additions !== undefined || item.deletions !== undefined ? (
              <span>
                <span className="text-diff-addition-foreground">+{formatDiffCount(item.additions ?? 0)}</span>{" "}
                <span className="text-diff-deletion-foreground">-{formatDiffCount(item.deletions ?? 0)}</span>
              </span>
            ) : null}
          </div>
          {item.diffStr?.trim() ? <DiffView diff={item.diffStr} path={item.fileName} /> : null}
          {item.changes !== undefined && item.changes.length > 0 ? (
            <ul className="space-y-1 font-mono text-muted-foreground">
              {item.changes.map((change) => (
                <li
                  key={JSON.stringify([change.operation, change.oldPath, change.path])}
                  className="wrap-anywhere"
                >
                  {change.operation} {change.oldPath ? `${change.oldPath} -> ` : ""}
                  {formatWorkspaceRelativePath(change.path, props.workspaceRoot)}
                  {change.fileType || change.mimeType
                    ? ` (${[change.fileType, change.mimeType].filter(Boolean).join(", ")})`
                    : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}

      {item.type === "file_search" && item.pattern?.trim() ? (
        <div className={cn("text-foreground/85", monoClassName)}>{item.pattern}</div>
      ) : null}

      {item.type === "web_search" && item.patterns?.length ? (
        <div className={cn("text-foreground/85", monoClassName)}>{item.patterns.join("\n")}</div>
      ) : null}

      {item.type === "file_search" && item.results?.length ? (
        <ul className="space-y-1">
          {item.results.map((result) => (
            <li key={JSON.stringify(result)}>
              <span className="font-mono text-foreground/80 wrap-anywhere">
                {formatWorkspaceRelativePath(result.fileName, props.workspaceRoot)}
                {result.line === undefined ? "" : `:${result.line}`}
                {result.column === undefined ? "" : `:${result.column}`}
              </span>
              {result.preview ? (
                <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{result.preview}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {item.type === "web_search" && item.results?.length ? (
        <ul className="space-y-1.5">
          {item.results.map((result) => {
            const safeHref = resolveExternalWebLinkHref(result.url);
            return (
              <li key={JSON.stringify(result)} className="min-w-0">
                {safeHref ? (
                  <a
                    href={safeHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-full items-center gap-1 font-medium text-foreground wrap-anywhere hover:underline"
                  >
                    {result.title ?? result.url}
                    <ExternalLinkIcon className="size-3 shrink-0" />
                  </a>
                ) : (
                  <p className="font-medium text-foreground wrap-anywhere">
                    {result.title ?? result.url ?? "Search result"}
                  </p>
                )}
                {result.snippet ? <p className="text-muted-foreground">{result.snippet}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {item.type === "dynamic_tool" ? (
        <ToolCallBody args={item.input} output={turnItemOutputText(item)} />
      ) : null}

      {item.type === "approval_request" ? <StructuredValue value={item.prompt} /> : null}
      {item.type === "user_input_request" ? (
        <StructuredValue
          value={item.questions
            .map((question) =>
              [question.question, ...question.options.map((option) => `- ${option.label}`)].join(
                "\n",
              ),
            )
            .join("\n\n")}
        />
      ) : null}
      {item.type === "notification" ? <StructuredValue value={item.detail} /> : null}
      {item.type === "system_notice" ? <StructuredValue value={item.message} /> : null}
      {item.type === "error" ? <StructuredValue value={item.failure.message} /> : null}
      {item.type === "todo_list" ? (
        <StructuredValue
          value={item.steps
            .map(
              (step) =>
                `${step.status === "completed" ? "✓" : step.status === "running" ? "◉" : "○"} ${step.text}`,
            )
            .join("\n")}
        />
      ) : null}
      {body?.trim() &&
      (item.type === "system_notice" || item.type === "notification") &&
      body.trim() !== (item.type === "system_notice" ? item.message : item.detail)?.trim() ? (
        <StructuredValue value={body} />
      ) : null}
    </div>
  );
});
