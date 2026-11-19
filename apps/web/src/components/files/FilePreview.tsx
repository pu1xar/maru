// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: components/files/FilePreviewPanel.tsx (header with path and actions, preview and word
// wrap toggles in the header, the preview kinds: code with line numbers and a highlighted target
// range, Markdown preview or source, image, PDF, audio, video, unsupported binary),
// files/fileSurfaceChrome.tsx (inline subheader, FileSurfaceAction, FileSurfaceLoading,
// FileSurfaceFailure), files/ReadOnlySourcePreview.tsx (virtualized lines with an opaque gutter)
// and FileBrowserPanel.tsx (folder rows).
// Local change: read only. T3 edits text in a Pierre editor, highlights code with Shiki and
// renders Office, CSV and Notebook; here code is colored by the chat's highlight.js engine in a
// worker (lib/fileSyntax.ts) and those kinds show as text or as an unsupported file. Text
// arrives in pages from GET /api/file (DESIGN.md 6e). The lines are virtualized here
// (codeLines.ts) instead of by Pierre.
import { fileApiUrl, fileRawUrl, type FileLookup, type FileView } from "@maru/shared";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  FileIcon,
  FolderIcon,
  RotateCwIcon,
  WrapTextIcon,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useFileSpans } from "~/lib/fileSyntax";
import { observeResize } from "~/lib/observeResize";
import { syntaxLanguageForPath } from "~/lib/syntaxLanguages";
import { lineStartOffsets, lineTokens } from "~/lib/syntaxSpans";
import type { SyntaxToken } from "~/lib/syntaxTokens";
import { cn } from "~/lib/utils";
import { shortPath } from "~/model";
import type { FileTarget, FileTargetKind } from "~/rightPanel";
import { SyntaxTokens } from "../chat/SyntaxHighlight";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatBytes } from "../settings/parts.logic";
import { codeBody, displayColumns, lineAt, lineOffsets, lineRange, widestLine } from "./codeLines";
import { plural } from "../../lib/plural.ts";

const ChatMarkdown = lazy(() => import("../ChatMarkdown"));

type TextPage = Extract<FileView, { kind: "text" }>;

type Loaded =
  | { status: "loading" }
  | { status: "error"; error: string; detail: string | null }
  | { status: "ready"; view: Exclude<FileView, TextPage> }
  | { status: "text"; pages: TextPage[]; loadingMore: boolean };

/** A failed file request: the server's short label, and more about it where the server has more. */
class FileFetchError extends Error {
  readonly detail: string | null;
  constructor(message: string, detail: string | null) {
    super(message);
    this.detail = detail;
  }
}

async function fetchView(path: string, offset: number, signal?: AbortSignal, lookup?: FileLookup): Promise<FileView> {
  const res = await fetch(fileApiUrl(path, offset, lookup), { signal });
  const body = (await res.json().catch(() => null)) as (FileView & { error?: string; detail?: string }) | null;
  if (!res.ok || !body) throw new FileFetchError(body?.error ?? `HTTP ${res.status}`, body?.detail ?? null);
  return body;
}

function failureOf(err: unknown): { error: string; detail: string | null } {
  if (err instanceof FileFetchError) return { error: err.message, detail: err.detail };
  return { error: "Failed to load", detail: err instanceof Error ? err.message : String(err) };
}

function lineCount(pages: readonly TextPage[]): number {
  let n = 0;
  for (const p of pages) for (let i = 0; i < p.text.length; i++) if (p.text.charCodeAt(i) === 10) n++;
  return n;
}

export { formatBytes };

function dirnameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function basenameOf(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1) || p;
}

/**
 * One file or folder. Pages of a text file load until the target line is in view, then on
 * request; every page stays reachable. `onKind` hears what the path turned out to be.
 */
export function FilePreview({
  target,
  onOpen,
  onKind,
}: {
  target: FileTarget;
  onOpen: (t: FileTarget) => void;
  onKind: (kind: FileTargetKind) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  // Markdown opens as a preview, and as source when the link names a line.
  const [preview, setPreview] = useState(target.line === undefined);
  const [previewLine, setPreviewLine] = useState(target.line);
  if (previewLine !== target.line) {
    setPreviewLine(target.line);
    setPreview(target.line === undefined);
  }
  const [wrap, setWrap] = useState(false);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  // The "더 보기" request in flight; a reload or a new target abandons it.
  const moreCtrl = useRef<AbortController | null>(null);

  // Fetches the file whenever the path changes or the user reloads.
  useEffect(() => {
    const ctrl = new AbortController();
    setLoaded({ status: "loading" });
    (async () => {
      try {
        const first = await fetchView(target.path, 0, ctrl.signal, target.lookup);
        if (first.kind === "directory") onKind("directory");
        else if (first.kind !== "ambiguous") onKind("file");
        if (first.kind !== "text") return setLoaded({ status: "ready", view: first });
        const pages = [first];
        // Bring the target line into the loaded pages. Later pages read the path the lookup found.
        while (target.line !== undefined && pages.at(-1)!.nextOffset !== null && lineCount(pages) < target.line) {
          pages.push((await fetchView(first.path, pages.at(-1)!.nextOffset!, ctrl.signal)) as TextPage);
        }
        setLoaded({ status: "text", pages, loadingMore: false });
      } catch (err) {
        if (!ctrl.signal.aborted) setLoaded({ status: "error", ...failureOf(err) });
      }
    })();
    return () => {
      ctrl.abort();
      moreCtrl.current?.abort();
    };
    // onKind is left out: the parent passes a new closure for this same path on every render.
  }, [target.path, target.line, target.lookup?.lookup, target.lookup?.root, reloadKey]);

  const loadMore = async () => {
    if (loaded.status !== "text" || loaded.loadingMore) return;
    const next = loaded.pages.at(-1)?.nextOffset;
    if (next == null) return;
    const ctrl = new AbortController();
    moreCtrl.current = ctrl;
    setLoaded((prev) => (prev.status === "text" ? { ...prev, loadingMore: true } : prev));
    try {
      const page = (await fetchView(loaded.pages[0]!.path, next, ctrl.signal)) as TextPage;
      if (ctrl.signal.aborted) return;
      setLoaded((prev) => (prev.status === "text" ? { status: "text", pages: [...prev.pages, page], loadingMore: false } : prev));
    } catch (err) {
      if (!ctrl.signal.aborted) setLoaded({ status: "error", ...failureOf(err) });
    }
  };
  const reload = () => setReloadKey((k) => k + 1);

  const size =
    loaded.status === "text" ? loaded.pages[0]!.size
    : loaded.status === "ready" && "size" in loaded.view ? loaded.view.size
    : null;
  // A lookup can read a file somewhere else than the link said; the header shows where.
  const shownPath =
    loaded.status === "text" ? loaded.pages[0]!.path : loaded.status === "ready" ? loaded.view.path : target.path;
  const isMarkdown = loaded.status === "text" && loaded.pages[0]!.language === "markdown";
  const showsLines = loaded.status === "text" && !(isMarkdown && preview);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <FileHeader
        path={shownPath}
        size={size}
        canDownload={loaded.status === "text" || (loaded.status === "ready" && "size" in loaded.view)}
        onReload={reload}
        preview={isMarkdown ? { on: preview, set: setPreview } : null}
        wrap={showsLines ? { on: wrap, set: setWrap } : null}
      />
      <div ref={setScroller} className="min-h-0 flex-1 overflow-auto">
        {loaded.status === "loading" ? (
          <div role="status" aria-label="Loading" className="flex min-h-full items-center justify-center text-muted-foreground">
            <Spinner size="lg" />
          </div>
        ) : loaded.status === "error" ? (
          <SurfaceMessage tone="error" label={loaded.error} detail={loaded.detail} onRetry={reload} />
        ) : loaded.status === "text" ? (
          <TextBody
            path={shownPath}
            pages={loaded.pages}
            target={target}
            preview={isMarkdown && preview}
            wrap={wrap}
            scroller={scroller}
            loadingMore={loaded.loadingMore}
            onLoadMore={loadMore}
          />
        ) : (
          <ViewBody view={loaded.view} onOpen={onOpen} />
        )}
      </div>
    </div>
  );
}

interface Switch {
  on: boolean;
  set: (on: boolean) => void;
}

function FileHeader(props: {
  path: string;
  size: number | null;
  canDownload: boolean;
  onReload: () => void;
  preview: Switch | null;
  wrap: Switch | null;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const shown = shortPath(props.path);
  const dir = dirnameOf(shown);
  return (
    <div className="mb-3 flex h-7 min-h-7 shrink-0 items-center gap-2 px-3">
      <div className="flex min-w-0 flex-1 items-baseline text-xs" title={props.path}>
        {dir === "/" ? null : (
          // Cut from the left so the folders next to the name stay; the isolate keeps the path in
          // its own order inside the right-to-left box.
          <span className="min-w-0 truncate text-muted-foreground" dir="rtl">
            <bdi dir="ltr">{`${dir}/`}</bdi>
          </span>
        )}
        {/* The folders give way first; the name is cut only when it alone is wider than the row. */}
        <span className="flex min-w-0 max-w-full shrink-0 items-baseline">
          <span className="min-w-0 truncate text-foreground">{basenameOf(shown)}</span>
          {props.size !== null ? (
            <span className="ms-2 shrink-0 text-muted-foreground tabular-nums">{formatBytes(props.size)}</span>
          ) : null}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {props.preview ? (
          <SurfaceToggle label="Preview" pressed={props.preview.on} onPressedChange={props.preview.set}>
            <EyeIcon className="size-3.5" />
          </SurfaceToggle>
        ) : null}
        {props.wrap ? (
          <SurfaceToggle label="Wrap" pressed={props.wrap.on} onPressedChange={props.wrap.set}>
            <WrapTextIcon className="size-3.5" />
          </SurfaceToggle>
        ) : null}
        <SurfaceAction label={isCopied ? "Copied" : "Copy path"} onClick={() => copyToClipboard(props.path, undefined)}>
          {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </SurfaceAction>
        <SurfaceAction label="Reload" onClick={props.onReload}>
          <RotateCwIcon className="size-3.5" />
        </SurfaceAction>
        {props.canDownload ? (
          <SurfaceAction label="Download original" href={fileRawUrl(props.path)} download={basenameOf(props.path)}>
            <DownloadIcon className="size-3.5" />
          </SurfaceAction>
        ) : null}
      </div>
    </div>
  );
}

/** T3's FileSurfaceAction without a pressed state. */
function SurfaceAction(props: { label: string; onClick?: () => void; href?: string; download?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={props.label}
            onClick={props.onClick}
            {...(props.href ? { render: <a href={props.href} download={props.download} /> } : {})}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** T3's FileSurfaceAction with a pressed state. */
function SurfaceToggle(props: { label: string; pressed: boolean; onPressedChange: (pressed: boolean) => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0"
            pressed={props.pressed}
            onPressedChange={props.onPressedChange}
            aria-label={props.label}
            variant="ghost"
            size="sm"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** T3's FileSurfaceFailure, also for states that are not errors (an unsupported file). */
function SurfaceMessage(props: { tone: "error" | "muted"; label: string; detail?: string | null; onRetry?: () => void }) {
  return (
    <div
      role={props.tone === "error" ? "alert" : undefined}
      className="flex min-h-full flex-col items-center justify-center gap-3 px-6 py-6 text-center text-xs leading-relaxed"
    >
      <div>
        <p className={props.tone === "error" ? "text-destructive-foreground" : "text-muted-foreground"}>{props.label}</p>
        {props.detail ? <p className="wrap-anywhere text-muted-foreground">{props.detail}</p> : null}
      </div>
      {props.onRetry ? (
        <Button size="xs" variant="outline" onClick={props.onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

function TextBody(props: {
  path: string;
  pages: TextPage[];
  target: FileTarget;
  preview: boolean;
  wrap: boolean;
  scroller: HTMLDivElement | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const { pages, target } = props;
  const text = useMemo(() => pages.map((p) => p.text).join(""), [pages]);
  const more = pages.at(-1)!.nextOffset !== null;
  const remaining = more ? pages[0]!.size - pages.at(-1)!.nextOffset! : 0;

  return (
    <div className="flex min-w-0 flex-col">
      {props.preview ? (
        <div className="max-w-4xl px-6 py-5">
          <Suspense fallback={<Spinner />}>
            <ChatMarkdown text={text} cwd={dirnameOf(props.path)} documentImages />
          </Suspense>
        </div>
      ) : (
        <CodeLines path={props.path} text={text} line={target.line} endLine={target.endLine} wrap={props.wrap} scroller={props.scroller} />
      )}
      {more ? (
        <div className="px-3 py-3">
          <Button size="xs" variant="outline" disabled={props.loadingMore} onClick={props.onLoadMore}>
            {props.loadingMore ? "Loading" : `Show more (${formatBytes(remaining)} left)`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Measures one line's height and a monospace column's width in the lines' own font. */
const PROBE = "0000000000";
/** Rendered past each edge of the viewport, so ordinary scrolling rarely reaches an unrendered line. */
const OVERSCAN_PX = 800;
/** Until the probe is measured: text-xs with leading-5 at the default root size. */
const FALLBACK_ROW_HEIGHT = 20;

interface LineMetrics {
  rowHeight: number;
  charWidth: number;
  /** px of the horizontal space around a line's text: the gutter's padding and the text's end padding. */
  inset: number;
  viewportWidth: number;
  viewportHeight: number;
}

/** Where the first line starts, in the scroller's content coordinates. */
function originTop(scroller: HTMLElement, origin: HTMLElement): number {
  return origin.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/**
 * The lines with numbers, the target range tinted. Only the lines near the scroller's viewport are
 * in the DOM; spacers above and below stand in for the rest (codeLines.ts).
 */
function CodeLines(props: { path: string; text: string; line?: number; endLine?: number; wrap: boolean; scroller: HTMLDivElement | null }) {
  const { scroller, wrap } = props;
  const body = useMemo(() => codeBody(props.text), [props.text]);
  const lines = useMemo(() => body.split("\n"), [body]);
  // Colors arrive from a worker after the plain lines are up; the spans index into `body`.
  const language = useMemo(() => syntaxLanguageForPath(props.path), [props.path]);
  const spans = useFileSpans(body, language);
  const lineStarts = useMemo(() => (spans ? lineStartOffsets(body) : null), [spans, body]);
  const columns = useMemo(() => lines.map(displayColumns), [lines]);
  const widest = useMemo(() => widestLine(columns), [columns]);
  const digits = String(lines.length).length;
  const from = props.line ?? 0;
  const to = props.endLine ?? props.line ?? 0;

  const blockRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const insetProbeRef = useRef<HTMLSpanElement | null>(null);
  const originRef = useRef<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = useState<LineMetrics | null>(null);

  // Font metrics and the scroller's size, before paint and again whenever either changes size
  // (panel resize, window height, UI scale, the panel's zoom, the chat code font the lines are drawn in).
  useLayoutEffect(() => {
    const probe = probeRef.current;
    const insetProbe = insetProbeRef.current;
    if (!scroller || !probe || !insetProbe) return;
    const measure = () => {
      const box = probe.getBoundingClientRect();
      const next: LineMetrics = {
        rowHeight: box.height,
        charWidth: box.width / PROBE.length,
        inset: insetProbe.getBoundingClientRect().width,
        viewportWidth: scroller.clientWidth,
        viewportHeight: scroller.clientHeight,
      };
      setMetrics((prev) =>
        prev &&
        prev.rowHeight === next.rowHeight &&
        prev.charWidth === next.charWidth &&
        prev.inset === next.inset &&
        prev.viewportWidth === next.viewportWidth &&
        prev.viewportHeight === next.viewportHeight
          ? prev
          : next,
      );
    };
    measure();
    return observeResize([scroller, probe, insetProbe], measure);
  }, [scroller]);

  const rowHeight = metrics?.rowHeight || FALLBACK_ROW_HEIGHT;
  // Wrapped, a line's text gets the row minus the gutter (digits and its padding) and its end padding.
  const wrapColumns =
    wrap && metrics
      ? Math.max(1, Math.floor((metrics.viewportWidth - digits * metrics.charWidth - metrics.inset) / metrics.charWidth))
      : wrap
        ? 80
        : null;
  // Heights of rendered wrapped lines; a new wrap width starts a new map. Within one mount lines
  // only grow at the end ("더 보기"), so the heights of earlier lines stay valid.
  const measured = useMemo(() => new Map<number, number>(), [wrapColumns, rowHeight]);
  const [measureVersion, setMeasureVersion] = useState(0);
  const offsets = useMemo(
    () => lineOffsets(columns, rowHeight, wrapColumns, measured),
    // measureVersion says `measured` changed in place.
    [columns, rowHeight, wrapColumns, measured, measureVersion],
  );
  const total = offsets[lines.length]!;

  // The span of the lines, in px from the first line, that is in the DOM.
  const viewRef = useRef({ top: -OVERSCAN_PX, bottom: window.innerHeight + OVERSCAN_PX });
  const [view, setView] = useState(viewRef.current);
  // The line at the top of the viewport and how far into it, against the offsets in layoutRef.
  const anchorRef = useRef<{ line: number; delta: number } | null>(null);
  const layoutRef = useRef(offsets);
  /** Re-reads the scroll position; `flush` renders a new span before the browser paints the scroll. */
  const syncView = useCallback(
    (flush: boolean) => {
      const origin = originRef.current;
      if (!scroller || !origin) return;
      const top = scroller.scrollTop - originTop(scroller, origin);
      const bottom = top + scroller.clientHeight;
      const line = lineAt(layoutRef.current, top);
      anchorRef.current = { line, delta: top - layoutRef.current[line]! };
      const prev = viewRef.current;
      if (top >= prev.top && bottom <= prev.bottom) return;
      const next = { top: top - OVERSCAN_PX, bottom: bottom + OVERSCAN_PX };
      viewRef.current = next;
      if (flush) flushSync(() => setView(next));
      else setView(next);
    },
    [scroller],
  );

  // A new layout (wrap toggle, width, measured rows, more lines) keeps the line that was at the
  // top where it was, so the text being read does not move.
  useLayoutEffect(() => {
    const before = layoutRef.current;
    layoutRef.current = offsets;
    const origin = originRef.current;
    const anchor = anchorRef.current;
    if (before === offsets || !scroller || !origin || !anchor || anchor.line >= lines.length) return;
    const height = offsets[anchor.line + 1]! - offsets[anchor.line]!;
    const want = originTop(scroller, origin) + offsets[anchor.line]! + Math.min(anchor.delta, height);
    if (Math.abs(scroller.scrollTop - want) > 0.5) scroller.scrollTop = want;
  }, [offsets, scroller, lines.length]);

  // Scroll events of the scroller, a DOM element outside React. A jump past the rendered span
  // (End, a thumb drag) renders the new span synchronously, so no blank frame shows.
  useEffect(() => {
    if (!scroller) return;
    const onScroll = () => syncView(true);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [scroller, syncView]);
  // A new layout or a taller viewport can leave part of the viewport outside the rendered span.
  useLayoutEffect(() => syncView(false), [syncView, offsets, metrics]);

  // Brings the target range to the middle once per target, after the first measurement.
  const scrolledFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    const origin = originRef.current;
    if (!scroller || !origin || !metrics || from < 1 || from > lines.length) return;
    const key = `${from}:${to}`;
    if (scrolledFor.current === key) return;
    scrolledFor.current = key;
    const top = offsets[from - 1]!;
    const height = offsets[Math.min(Math.max(to, from), lines.length)]! - top;
    scroller.scrollTop = originTop(scroller, origin) + top - Math.max(0, (scroller.clientHeight - height) / 2);
    syncView(false);
  }, [scroller, metrics, from, to, offsets, lines.length, syncView]);

  // Wrapped lines: replaces the estimates of the rendered lines with their real heights.
  useLayoutEffect(() => {
    const block = blockRef.current;
    if (wrapColumns === null || !block) return;
    let changed = false;
    for (const row of block.querySelectorAll<HTMLElement>("[data-line-index]")) {
      const i = Number(row.dataset.lineIndex);
      const height = row.getBoundingClientRect().height;
      if (Math.abs(height - (offsets[i + 1]! - offsets[i]!)) > 0.5) {
        measured.set(i, height);
        changed = true;
      }
    }
    if (changed) setMeasureVersion((v) => v + 1);
  });

  const { start, end } = lineRange(offsets, view.top, view.bottom);
  // The digits and the gutter's px-3 padding; spacing units, so the panel's zoom scales both.
  const gutterStyle = { width: `calc(${digits}ch + var(--spacing) * 6)` };
  const rows: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const n = i + 1;
    const hit = n >= from && n <= to;
    rows.push(
      <div key={n} data-line-index={i} className={cn("flex", hit && "bg-warning-surface")}>
        <span
          className={cn(
            // Opaque, so text scrolled sideways passes under it; a target line tints it on top.
            "sticky left-0 shrink-0 select-none bg-side-surface px-3 text-right text-muted-foreground",
            hit && "bg-linear-to-r from-warning-surface to-warning-surface",
          )}
          style={gutterStyle}
        >
          {n}
        </span>
        <span className={cn("pe-4 text-foreground/90", wrap ? "min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere" : "whitespace-pre")}>
          {spans && lineStarts ? <ColoredLine tokens={lineTokens(body, spans, lineStarts, i)} /> : lines[i] || " "}
        </span>
      </div>,
    );
  }

  return (
    // The browser's own scroll anchoring is off here: the anchor effect above keeps the top line.
    // text-xs on leading-5, both at the chat code text size (index.css --chat-code-ratio).
    <div
      ref={blockRef}
      className={cn(
        "relative py-2 font-chat-code text-[calc(var(--text-xs)*var(--chat-code-ratio,1))] leading-[calc(var(--spacing)*5*var(--chat-code-ratio,1))] [overflow-anchor:none]",
        !wrap && "min-w-max",
      )}
    >
      <span ref={probeRef} aria-hidden className="pointer-events-none invisible absolute top-0 left-0 whitespace-pre">
        {PROBE}
      </span>
      {/* The gutter's padding (px-3, both sides) and the text's end padding (pe-4): 10 spacing units. */}
      <span ref={insetProbeRef} aria-hidden className="pointer-events-none invisible absolute top-0 left-0 h-px w-10" />
      {wrap ? null : (
        // An unseen copy of the widest line gives the block the scroll width of the whole file.
        <div aria-hidden className="invisible flex h-0 overflow-hidden">
          <span className="shrink-0 px-3" style={gutterStyle} />
          <span className="whitespace-pre pe-4">{lines[widest]}</span>
        </div>
      )}
      <div ref={originRef} style={{ height: offsets[start] }} />
      {rows}
      <div style={{ height: total - offsets[end]! }} />
    </div>
  );
}

/** One line's tokens as colored spans; an empty line keeps its height with a space. */
function ColoredLine({ tokens }: { tokens: ReadonlyArray<SyntaxToken> }) {
  return tokens.length === 0 ? " " : <SyntaxTokens tokens={tokens} />;
}

function ViewBody({ view, onOpen }: { view: Exclude<FileView, TextPage>; onOpen: (t: FileTarget) => void }) {
  if (view.kind === "directory") {
    return (
      <ul className="py-1">
        {view.entries.length === 0 ? <li className="px-4 py-3 text-sm text-muted-foreground">Empty folder</li> : null}
        {view.entries.map((e) => (
          <li key={e.name}>
            <button
              type="button"
              className="flex h-7 w-full items-center gap-2 px-3 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              onClick={() =>
                onOpen({
                  path: `${view.path === "/" ? "" : view.path}/${e.name}`,
                  ...(e.kind === "other" ? {} : { kind: e.kind }),
                })
              }
            >
              {e.kind === "directory" ? (
                <FolderIcon aria-hidden className="size-3.5 shrink-0 text-icon-muted" />
              ) : (
                <FileIcon aria-hidden className="size-3.5 shrink-0 text-icon-muted" />
              )}
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
              {e.size !== null ? (
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(e.size)}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    );
  }
  if (view.kind === "ambiguous") {
    return (
      <div className="pb-2">
        <p className="px-3 pb-1 text-xs text-muted-foreground">{plural(view.candidates.length, "candidate")}</p>
        <ul>
          {view.candidates.map((c) => (
            <li key={c}>
              <button
                type="button"
                title={shortPath(c)}
                className="flex h-7 w-full items-center gap-2 px-3 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                onClick={() => onOpen({ path: c })}
              >
                <FileIcon aria-hidden className="size-3.5 shrink-0 text-icon-muted" />
                <span className="min-w-0 truncate" dir="rtl">
                  <bdi dir="ltr">{c.startsWith(`${view.root}/`) ? c.slice(view.root.length + 1) : shortPath(c)}</bdi>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (view.kind === "binary") {
    return <SurfaceMessage tone="muted" label="File cannot be previewed" />;
  }
  const src = fileRawUrl(view.path);
  switch (view.media) {
    case "image":
      return (
        <div className="flex min-h-full items-start justify-center p-4">
          <img src={src} alt={basenameOf(view.path)} className="max-w-full rounded-sm" />
        </div>
      );
    case "pdf":
      return <iframe src={src} title={basenameOf(view.path)} className="size-full min-h-[70vh] border-0" />;
    case "audio":
      return (
        <div className="p-4">
          <audio src={src} controls className="w-full" />
        </div>
      );
    case "video":
      return (
        <div className="p-4">
          <video src={src} controls className="max-h-[80vh] w-full" />
        </div>
      );
  }
}
