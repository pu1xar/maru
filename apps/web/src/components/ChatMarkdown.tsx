// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/ChatMarkdown.tsx
// Local changes: the component map keeps T3's markdown rendering (headings, GitHub alerts and
// Claude insight callouts, ordered list gutters, task checkboxes, tables, details, code block
// frames, external links, file path chips, images) and drops what reaches T3's server and app
// state: editor, panel, preview and media opens for file chips, pull request cards and linking,
// thread links, citations, context references, skills, Codex directives and artifact templates,
// math, the image expand dialog, asset-backed images and "Run in terminal". A ```mermaid block
// draws as a diagram with Pele (chat/MarkdownMermaidCodeBlock.tsx, DESIGN.md 7g; T3 does the
// same), except where the `diagrams` prop is off (the user's own bubble keeps what was typed). Code blocks
// keep the parsed <pre> and color its code with highlight.js (MarkdownCodeBlockCode) instead of
// T3's Shiki. Settings T3 reads at runtime are fixed to its defaults: links open in a new tab and
// math is off. Line endings become LF before the parse (chat/markdownLineEndings.ts), and a
// streamed answer's last line waits while it is a fence still arriving (chat/streamingFence.ts).
import {
  type ClipboardEvent as ReactClipboardEvent,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  createContext,
  memo,
  use,
} from "react";
import {
  InfoIcon,
  LightbulbIcon,
  MessageSquareWarningIcon,
  OctagonAlertIcon,
  StarIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type {
  Components,
  ExtraProps as ReactMarkdownExtraProps,
  Options as ReactMarkdownOptions,
} from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import type { PluggableList } from "unified";

import { cn } from "~/lib/utils";
import { chatMarkdownClipboardPayload } from "~/markdown-clipboard";
import { createIncrementalMarkdownPlugin } from "~/markdown-incremental";
import { buildFileLinkParentSuffixByPath, fileLinkLabel } from "~/t3-shared/fileLinks";
import {
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  isMarkdownFileLinkLabel,
  isWindowsDrivePathHref,
  normalizeMarkdownLinkDestination,
} from "~/t3-shared/markdownLinks";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  remarkAssistantInsights,
} from "~/t3-shared/markdownPipeline";
import {
  extractCodeBlock,
  extractFenceLanguage,
  isClosedCodeFence,
  extractFenceTitle,
  extractPreCodeMeta,
  nodeToPlainText,
} from "./chat/MarkdownCodeBlock.logic";
import { MarkdownCodeBlock, MarkdownCodeBlockCode } from "./chat/MarkdownCodeBlock";
import { MarkdownDetails } from "./chat/MarkdownDetails";
import { MarkdownMermaidCodeBlock } from "./chat/MarkdownMermaidCodeBlock";
import { isMermaidLanguage } from "./chat/MarkdownMermaid.logic";
import {
  MarkdownExternalLinkContent,
  resolveExternalWebLinkHost,
} from "./chat/MarkdownExternalLink";
import { MarkdownFileLink } from "./chat/MarkdownFileLink";
import { MarkdownFileImage } from "./chat/MarkdownFileImage";
import { MarkdownDocumentImage } from "./chat/MarkdownDocumentImage";
import { fileLinkImagePath, markdownImagePath } from "./chat/MarkdownFileLinkMeta.logic";
import {
  isLocalEditorFileHref,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  type MarkdownFileLinkMeta,
} from "./chat/MarkdownFileLink.logic";
import {
  authoredImageSizeStyle,
  ChatMarkdownImage,
  ChatMarkdownImageFallback,
  isDirectMarkdownImageSource,
  markdownImageCopy,
  resolveProtocolRelativeMediaUrl,
} from "./chat/MarkdownImage";
import { MarkdownTable } from "./chat/MarkdownTable";
import { rehypeChipPunctuation } from "./chat/markdownChipPunctuation";
import { handleMarkdownFragmentClick, rehypeHeadingIds } from "./chat/markdownFragments";
import { hastHasText, plainHastText } from "./chat/markdownHast.logic";
import { normalizeMarkdownLineEndings } from "./chat/markdownLineEndings";
import { withoutPartialFenceLine } from "./chat/streamingFence";
import { createMarkdownRenderer } from "./chat/markdownRenderer";
import { splitMarkdownBlocks } from "./chat/markdownStreamBlocks";
import { rehypeTextDirection } from "./chat/markdownTextDirection";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface ChatMarkdownProps {
  renderInsights?: boolean;
  /** Compact markdown transforms remove blocks before rendering inside a label. */
  inline?: boolean;
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
  className?: string;
  lineBreaks?: boolean;
  parseRawHtml?: boolean;
  /** Draw ```mermaid blocks as diagrams (default), or keep them as code. */
  diagrams?: boolean;
  /** Keep one list per configuration (a module constant): it keys the shared parse cache. */
  extraRemarkPlugins?: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  headingLevelOffset?: number | undefined;
  /**
   * Draw a picture file named by `![](path)` or `<img>` as the picture at the text's width (the file
   * view), not as a chip with a small preview (chat). Relative sources resolve under `cwd`.
   */
  documentImages?: boolean;
}

const EMPTY_REMARK_PLUGINS: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [];

const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;

function orderedListGutterStyle(
  itemValues: ReadonlyArray<unknown>,
  start: unknown,
): { "--list-gutter": string } | undefined {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  let number = Number.isNaN(parsedStart) ? 1 : parsedStart;
  let markerWidth = String(number).length;
  for (const value of itemValues) {
    const written = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isNaN(written)) number = written;
    markerWidth = Math.max(markerWidth, String(number).length);
    number += 1;
  }
  if (markerWidth <= 1) return undefined;
  return { "--list-gutter": `${markerWidth + 2}ch` };
}

// Local change: titles take the theme's text tokens (T3 picks palette steps), so they read at 4.5:1
// on the light canvas too; T3's amber-600 and emerald-600 came to 3.1:1 and 3.6:1 there.
const GITHUB_ALERT_PRESENTATIONS: Record<
  string,
  { label: string; Icon: typeof InfoIcon; borderClassName: string; titleClassName: string }
> = {
  insight: {
    label: "Insight",
    Icon: StarIcon,
    borderClassName: "border-info",
    titleClassName: "text-info-foreground",
  },
  note: {
    label: "Note",
    Icon: InfoIcon,
    borderClassName: "border-blue-500/70",
    titleClassName: "text-info-foreground",
  },
  tip: {
    label: "Tip",
    Icon: LightbulbIcon,
    borderClassName: "border-emerald-500/70",
    titleClassName: "text-success-foreground",
  },
  important: {
    label: "Important",
    Icon: MessageSquareWarningIcon,
    borderClassName: "border-purple-500/70",
    titleClassName: "text-purple-600 dark:text-purple-400",
  },
  warning: {
    label: "Warning",
    Icon: TriangleAlertIcon,
    borderClassName: "border-amber-500/70",
    titleClassName: "text-warning-foreground",
  },
  caution: {
    label: "Caution",
    Icon: OctagonAlertIcon,
    borderClassName: "border-red-500/70",
    titleClassName: "text-error-foreground",
  },
};

/** The small picture under a file chip whose path names a picture (DESIGN.md 6e), else nothing. */
function fileLinkImage(meta: MarkdownFileLinkMeta, authoredImage = false) {
  // An authored image (`![](src)`) says it is a picture, so a relative source is read under the base folder.
  const path = authoredImage ? markdownImagePath(meta) : fileLinkImagePath(meta);
  return path === null ? null : <MarkdownFileImage path={path} name={meta.basename} />;
}

function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const rewrittenHref = rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
  return WINDOWS_DRIVE_PATH_REGEX.test(rewrittenHref)
    ? rewrittenHref.replaceAll("\\", "/")
    : rewrittenHref;
}

// Heading ids are added after sanitizing, which would prefix them a second time.
const CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS = [
  ...CHAT_MARKDOWN_REHYPE_PLUGINS,
  rehypeHeadingIds,
  rehypeTextDirection,
  rehypeChipPunctuation,
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

const CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS = [
  rehypeHeadingIds,
  rehypeTextDirection,
  rehypeChipPunctuation,
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

function markdownUrlTransform(href: string) {
  if (isWindowsDrivePathHref(href)) return href;
  if (isLocalEditorFileHref(href)) return href;
  return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
}

function fileLinkSourcesKey(text: string, cwd: string | undefined): string {
  const hrefs = extractMarkdownLinkHrefs(text)
    .map(normalizeMarkdownLinkHrefKey)
    .filter((href) => resolveMarkdownFileLinkMeta(href, cwd, cwd));
  const spans = extractInlineCodeSpans(text).filter((span) =>
    resolveInlineCodeFileLinkMeta(span, cwd, cwd),
  );
  return JSON.stringify([[...new Set(hrefs)], [...new Set(spans)]]);
}

function resolveFileLinkSources(key: string, cwd: string | undefined) {
  const [hrefs, spans] = JSON.parse(key) as [string[], string[]];
  const markdownFileLinkMetaByHref = new Map<string, MarkdownFileLinkMeta>();
  for (const href of hrefs) {
    const meta = resolveMarkdownFileLinkMeta(href, cwd, cwd);
    if (meta) markdownFileLinkMetaByHref.set(href, meta);
  }
  const inlineCodeFileLinkMetaByText = new Map<string, MarkdownFileLinkMeta>();
  for (const span of spans) {
    const meta = resolveInlineCodeFileLinkMeta(span, cwd, cwd);
    if (meta) inlineCodeFileLinkMetaByText.set(span, meta);
  }
  const fileLinkParentSuffixByPath = buildFileLinkParentSuffixByPath([
    ...[...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath),
    ...[...inlineCodeFileLinkMetaByText.values()].map((meta) => meta.filePath),
  ]);
  return { markdownFileLinkMetaByHref, inlineCodeFileLinkMetaByText, fileLinkParentSuffixByPath };
}

function useChatMarkdownState({
  text,
  inline = false,
  cwd,
  isStreaming = false,
  diagrams = true,
  headingLevelOffset = 0,
  documentImages = false,
}: ChatMarkdownProps) {
  const handleCopy = (event: ReactClipboardEvent<HTMLElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !event.clipboardData) return;
    const payload = chatMarkdownClipboardPayload(selection);
    if (!payload) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload.text);
    event.clipboardData.setData("text/html", payload.html);
  };
  // Keyed by the file links found, not the text, so streamed text that adds none keeps the
  // renderer context, and every block reading it, unchanged.
  // A template literal marks the key as a string, so the compiler memoizes the maps on its value.
  const fileLinksKey = `${fileLinkSourcesKey(text, cwd)}`;
  const { markdownFileLinkMetaByHref, inlineCodeFileLinkMetaByText, fileLinkParentSuffixByPath } =
    resolveFileLinkSources(fileLinksKey, cwd);
  const fileLinkChip = (
    fileLinkMeta: MarkdownFileLinkMeta,
    copyMarkdown: string,
    authoredImage = false,
    withPreview = true,
  ) => (
    <>
    <MarkdownFileLink
      targetPath={fileLinkMeta.targetPath}
      filePath={fileLinkMeta.filePath}
      {...(fileLinkMeta.line !== undefined ? { line: fileLinkMeta.line } : {})}
      {...(fileLinkMeta.endLine !== undefined ? { endLine: fileLinkMeta.endLine } : {})}
      {...(fileLinkMeta.workspaceLookupPath && cwd
        ? { lookup: { lookup: fileLinkMeta.workspaceLookupPath, root: cwd } }
        : {})}
      label={fileLinkLabel(
        {
          path: fileLinkMeta.filePath,
          ...(fileLinkMeta.line !== undefined ? { line: fileLinkMeta.line } : {}),
          ...(fileLinkMeta.column !== undefined ? { column: fileLinkMeta.column } : {}),
          ...(fileLinkMeta.endLine !== undefined ? { endLine: fileLinkMeta.endLine } : {}),
        },
        fileLinkParentSuffixByPath,
      )}
      copyMarkdown={copyMarkdown}
    />
    {withPreview ? fileLinkImage(fileLinkMeta, authoredImage) : null}
    </>
  );

  const componentState = {
    cwd,
    diagrams,
    documentImages,
    fileLinkChip,
    headingLevelOffset,
    inlineCodeFileLinkMetaByText,
    inline,
    isStreaming,
    markdownFileLinkMetaByHref,
  };
  return { componentState, handleCopy };
}

const ChatMarkdownRendererContext = createContext<
  ReturnType<typeof useChatMarkdownState>["componentState"]
>(null!);

// Isolate streamed source text from the renderer context; only offset-based renderers need it.
const ChatMarkdownTextContext = createContext("");

function markdownHeadingRenderer(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as const;
  return function MarkdownHeading({
    node: _node,
    ...props
  }: ComponentProps<typeof Tag> & ReactMarkdownExtraProps) {
    const { headingLevelOffset } = use(ChatMarkdownRendererContext);
    return (
      <Tag
        {...props}
        aria-level={headingLevelOffset > 0 ? Math.min(level + headingLevelOffset, 6) : undefined}
      />
    );
  };
}

// Native word selection stops at hyphens and dots, so a double-click takes the whole span.
function selectInlineCode(event: ReactMouseEvent<HTMLElement>) {
  window.getSelection()?.selectAllChildren(event.currentTarget);
}

const CHAT_MARKDOWN_COMPONENTS = {
  h1: markdownHeadingRenderer(1),
  h2: markdownHeadingRenderer(2),
  h3: markdownHeadingRenderer(3),
  h4: markdownHeadingRenderer(4),
  h5: markdownHeadingRenderer(5),
  h6: markdownHeadingRenderer(6),
  blockquote: function MarkdownBlockquote({ node: _node, children, ...props }) {
    const alertKind = String((props as Record<string, unknown>)["data-alert"] ?? "");
    const alert = GITHUB_ALERT_PRESENTATIONS[alertKind];
    if (!alert) {
      return <blockquote {...props}>{children}</blockquote>;
    }
    return (
      <div
        role="note"
        data-markdown-alert={alertKind}
        dir={props.dir}
        className={cn("my-1 border-s-2 ps-3", alert.borderClassName)}
      >
        <p
          data-thread-find-ignore="true"
          data-markdown-alert-label=""
          className={cn("flex items-center gap-1.5 font-medium", alert.titleClassName)}
        >
          <alert.Icon aria-hidden className="size-3.5 shrink-0" />
          {alert.label}
        </p>
        {children}
      </div>
    );
  },
  ol: function MarkdownOrderedList({ node, start, style, ...props }) {
    const itemValues =
      node?.children?.flatMap((child) =>
        child.type === "element" && child.tagName === "li" ? [child.properties.value] : [],
      ) ?? [];
    const gutterStyle = orderedListGutterStyle(itemValues, start);
    return (
      <ol {...props} start={start} style={gutterStyle ? { ...style, ...gutterStyle } : style} />
    );
  },
  input: function MarkdownInput({ node: _node, type, checked, disabled, ...props }) {
    return (
      <input
        {...props}
        type={type}
        checked={type === "checkbox" ? checked === true : checked}
        disabled={disabled}
        readOnly={type === "checkbox"}
      />
    );
  },
  a: function MarkdownAnchor({ node, href, children, title: _title, ...props }) {
    const { cwd, markdownFileLinkMetaByHref, fileLinkChip } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownTextContext);
    const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
    const fileLinkMeta = normalizedHref
      ? (markdownFileLinkMetaByHref.get(normalizedHref) ??
        resolveMarkdownFileLinkMeta(normalizedHref, cwd, cwd))
      : null;
    if (!fileLinkMeta) {
      const faviconHost = resolveExternalWebLinkHost(href);
      const hasText = hastHasText(node);
      const isSameDocumentLink = href?.startsWith("#") ?? false;
      const onClick = props.onClick;
      const link = (
        <a
          {...props}
          data-markdown-image-link={!hasText || undefined}
          href={href}
          target={isSameDocumentLink ? undefined : "_blank"}
          rel={isSameDocumentLink ? undefined : "noopener noreferrer"}
          onClick={(event) => {
            onClick?.(event);
            if (isSameDocumentLink && href) handleMarkdownFragmentClick(event, href);
          }}
        >
          {faviconHost && hasText ? (
            <MarkdownExternalLinkContent plainText={plainHastText(node)}>
              {children}
            </MarkdownExternalLinkContent>
          ) : (
            children
          )}
        </a>
      );
      if (!faviconHost || !href) {
        return link;
      }
      return (
        <Tooltip>
          <TooltipTrigger render={link} />
          <TooltipPopup side="top">{href}</TooltipPopup>
        </Tooltip>
      );
    }

    const label = nodeToPlainText(children);
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    const source = start !== undefined && end !== undefined ? text.slice(start, end) : "";
    const copyMarkdown =
      source.startsWith("[") && source.includes("](")
        ? source
        : `[${(label || fileLinkMeta.basename).replace(/[\\[\]]/g, "\\$&")}](${normalizedHref})`;
    const chip = fileLinkChip(fileLinkMeta, copyMarkdown);
    return isMarkdownFileLinkLabel(label, normalizedHref) ? (
      chip
    ) : (
      <span data-markdown-copy={copyMarkdown}>
        <span className="whitespace-normal">{children} </span>
        {chip}
      </span>
    );
  },
  code: function MarkdownCode({ node, children, className, ...props }) {
    const { cwd, inlineCodeFileLinkMetaByText, fileLinkChip } = use(ChatMarkdownRendererContext);
    if (node?.properties?.dataInlineCode != null) {
      const codeText = nodeToPlainText(children);
      const fileLinkMeta =
        inlineCodeFileLinkMetaByText.get(codeText.trim()) ??
        resolveInlineCodeFileLinkMeta(codeText, cwd, cwd);
      if (fileLinkMeta) {
        return fileLinkChip(fileLinkMeta, `\`${codeText}\``);
      }
      return (
        <code {...props} className={className} onDoubleClick={selectInlineCode}>
          {children}
        </code>
      );
    }
    return (
      <code {...props} className={className}>
        {children}
      </code>
    );
  },
  img: function MarkdownImage({ node, title, src, alt, ...props }) {
    const { cwd, documentImages, fileLinkChip } = use(ChatMarkdownRendererContext);
    const localSrc = node?.properties?.dataLocalSrc;
    const markdownTitle = node?.properties?.dataMarkdownTitle;
    const authoredSrc = typeof localSrc === "string" ? localSrc : src;
    const authoredTitle = typeof markdownTitle === "string" ? markdownTitle : title;
    const srcString =
      typeof authoredSrc === "string" ? normalizeMarkdownLinkDestination(authoredSrc) : "";
    const altText = alt ?? "";
    const copyMarkdown = markdownImageCopy(altText, srcString, authoredTitle);
    const { className, style: _style, width, height, ...imageProps } = props;
    if (isDirectMarkdownImageSource(srcString)) {
      const mediaSrc = resolveProtocolRelativeMediaUrl(srcString);
      return (
        <ChatMarkdownImage
          key={mediaSrc}
          src={mediaSrc}
          alt={altText}
          copyMarkdown={copyMarkdown}
          className={className}
          style={authoredImageSizeStyle(width, height)}
          imageProps={imageProps}
        />
      );
    }
    const fileLinkMeta = srcString ? resolveMarkdownFileLinkMeta(srcString, cwd, cwd) : null;
    if (fileLinkMeta) {
      const picture = documentImages ? markdownImagePath(fileLinkMeta) : null;
      if (picture !== null) {
        return (
          <MarkdownDocumentImage
            path={picture}
            name={fileLinkMeta.basename}
            alt={altText}
            copyMarkdown={copyMarkdown}
            width={width}
            fallback={fileLinkChip(fileLinkMeta, copyMarkdown, false, false)}
          />
        );
      }
      return fileLinkChip(fileLinkMeta, copyMarkdown, true);
    }
    return <ChatMarkdownImageFallback alt={altText} copyMarkdown={copyMarkdown} />;
  },
  table: function MarkdownTableRenderer({ node: _node, ...props }) {
    return <MarkdownTable {...props} />;
  },
  details: function MarkdownDetailsRenderer({ node: _node, children, open: detailsOpen }) {
    return <MarkdownDetails open={detailsOpen}>{children}</MarkdownDetails>;
  },
  pre: function MarkdownPre({ node, children, ...props }) {
    const { diagrams, isStreaming } = use(ChatMarkdownRendererContext);
    const text = use(ChatMarkdownTextContext);
    const codeBlock = extractCodeBlock(children);
    if (!codeBlock) {
      return <pre {...props}>{children}</pre>;
    }
    const language = extractFenceLanguage(codeBlock.className);
    const fenceTitle = extractFenceTitle(extractPreCodeMeta(node));
    const codeElement = (
      <pre {...props}>
        <MarkdownCodeBlockCode
          code={codeBlock.code}
          language={language}
          className={codeBlock.className}
        >
          {children}
        </MarkdownCodeBlockCode>
      </pre>
    );
    if (diagrams && isMermaidLanguage(language)) {
      return (
        <MarkdownMermaidCodeBlock
          code={codeBlock.code}
          fenceTitle={fenceTitle}
          open={isStreaming && !isClosedCodeFence(node, text, codeBlock.code)}
        >
          {codeElement}
        </MarkdownMermaidCodeBlock>
      );
    }
    return (
      <MarkdownCodeBlock code={codeBlock.code} language={language} fenceTitle={fenceTitle}>
        {codeElement}
      </MarkdownCodeBlock>
    );
  },
} satisfies Components;

// Shared lists, so every message with the same options shares a processor and its cache.
const CHAT_MARKDOWN_REMARK_PLUGIN_SETS = {
  plain: CHAT_MARKDOWN_REMARK_PLUGINS,
  breaks: CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} satisfies Record<string, PluggableList>;

const combinedPlugins = new WeakMap<PluggableList, WeakMap<PluggableList, PluggableList>>();

// One combined list per pair, so a stable extra list shares a renderer and its parse cache.
const INSIGHT_REMARK_PLUGINS: PluggableList = [remarkAssistantInsights];

function withExtraPlugins(shared: PluggableList, extra: PluggableList): PluggableList {
  if (extra.length === 0) return shared;
  let byShared = combinedPlugins.get(extra);
  if (!byShared) combinedPlugins.set(extra, (byShared = new WeakMap()));
  let combined = byShared.get(shared);
  if (!combined) byShared.set(shared, (combined = [...shared, ...extra]));
  return combined;
}

const markdownRenderers = new WeakMap<
  PluggableList,
  WeakMap<PluggableList, ReturnType<typeof createMarkdownRenderer>>
>();

function markdownRenderer(remarkPlugins: PluggableList, rehypePlugins: PluggableList) {
  let byRehype = markdownRenderers.get(remarkPlugins);
  if (!byRehype) markdownRenderers.set(remarkPlugins, (byRehype = new WeakMap()));
  let renderer = byRehype.get(rehypePlugins);
  if (!renderer) {
    renderer = createMarkdownRenderer({
      remarkPlugins,
      rehypePlugins,
      components: CHAT_MARKDOWN_COMPONENTS,
      urlTransform: markdownUrlTransform,
    });
    byRehype.set(rehypePlugins, renderer);
  }
  return renderer;
}

const MarkdownSource = memo(function MarkdownSource({
  text,
  remarkPlugins,
  rehypePlugins,
  shared,
  cache,
}: {
  text: string;
  remarkPlugins: PluggableList;
  rehypePlugins: PluggableList;
  /** The plugins are one of the shared sets. */
  shared: boolean;
  /** The text will not change again; streamed text would only fill the cache with prefixes. */
  cache: boolean;
}) {
  // Per-instance plugins, such as the incremental parser, set up their state on every render.
  const render = shared
    ? markdownRenderer(remarkPlugins, rehypePlugins)
    : createMarkdownRenderer({
        remarkPlugins,
        rehypePlugins,
        components: CHAT_MARKDOWN_COMPONENTS,
        urlTransform: markdownUrlTransform,
      });
  return (
    <ChatMarkdownTextContext value={text}>{render(text, shared && cache)}</ChatMarkdownTextContext>
  );
});

function ChatMarkdown({
  text: typed,
  className,
  inline = false,
  lineBreaks = false,
  parseRawHtml = true,
  extraRemarkPlugins = EMPTY_REMARK_PLUGINS,
  renderInsights = false,
  ...props
}: ChatMarkdownProps) {
  const normalized = normalizeMarkdownLineEndings(typed);
  const text = props.isStreaming === true ? withoutPartialFenceLine(normalized) : normalized;
  const { componentState, handleCopy } = useChatMarkdownState({ text, inline, ...props });
  const hasInsights = renderInsights && text.includes("★ Insight");
  // Streaming re-renders only the last block.
  const streamingBlocks =
    props.isStreaming === true && !inline && extraRemarkPlugins.length === 0
      ? splitMarkdownBlocks(text)
      : null;
  const incrementalParsing =
    props.isStreaming === true &&
    !hasInsights &&
    streamingBlocks === null &&
    extraRemarkPlugins.length === 0 &&
    /(?:^|\n) {0,3}(?:`{3}|~{3})/.test(text);
  const Root = inline ? "span" : "div";
  const sharedRemarkPlugins = CHAT_MARKDOWN_REMARK_PLUGIN_SETS[lineBreaks ? "breaks" : "plain"];
  // The incremental parser keeps per-instance state, so its output is not shared.
  const uncachedPlugins = incrementalParsing;
  const remarkPlugins = incrementalParsing
    ? [...sharedRemarkPlugins, ...extraRemarkPlugins, createIncrementalMarkdownPlugin()]
    : withExtraPlugins(
        hasInsights
          ? withExtraPlugins(INSIGHT_REMARK_PLUGINS, sharedRemarkPlugins)
          : sharedRemarkPlugins,
        extraRemarkPlugins,
      );
  const blocks = streamingBlocks ?? [text];

  return (
    <Root
      className={cn(
        "chat-markdown w-full min-w-0 [overflow-wrap:anywhere] [word-break:break-word]",
        !inline &&
          "text-sm leading-relaxed text-foreground/[calc(90%+var(--appearance-contrast-boost)/10)]",
        className,
      )}
      data-streaming={componentState.isStreaming ? "" : undefined}
      onCopy={handleCopy}
    >
      <ChatMarkdownRendererContext value={componentState}>
        {blocks.map((source, index) => (
          <MarkdownSource
            // Streamed blocks only change at the end.
            key={index}
            text={source}
            remarkPlugins={remarkPlugins}
            rehypePlugins={
              parseRawHtml
                ? CHAT_MARKDOWN_RENDER_REHYPE_PLUGINS
                : CHAT_MARKDOWN_LITERAL_HTML_REHYPE_PLUGINS
            }
            shared={!uncachedPlugins}
            // Every block before the last is finished, so its parse can be reused.
            cache={!props.isStreaming || index < blocks.length - 1}
          />
        ))}
      </ChatMarkdownRendererContext>
    </Root>
  );
}

export default memo(ChatMarkdown);
