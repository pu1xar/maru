// Markdown as the Claude Code CLI prints it (DESIGN.md 6i, measured on 2.1.325): headings and
// bold as bold text without their marks, inline code in the suggestion color without backticks,
// "- " and "1. " list markers, fenced code without fences, tables in box lines, quotes behind a
// bar, links as "text (url)". It parses with the chat's own pipeline (ChatMarkdown.tsx), so file
// paths resolve the same way and open in the right panel.
import type { Element, Parents, Root } from "hast";
import { Children, createContext, Fragment, isValidElement, memo, use, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { defaultUrlTransform } from "react-markdown";

import type { FileTarget } from "~/rightPanel";
import { useFileOpen } from "~/rightPanel";
import { isWindowsDrivePathHref } from "~/t3-shared/markdownLinks";
import { CHAT_MARKDOWN_REHYPE_PLUGINS, CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS } from "~/t3-shared/markdownPipeline";
import { extractCodeBlock, nodeToPlainText } from "../chat/MarkdownCodeBlock.logic";
import {
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  type MarkdownFileLinkMeta,
} from "../chat/MarkdownFileLink.logic";
import { hastPlainTextDeep } from "../chat/markdownHast.logic";
import { createMarkdownRenderer } from "../chat/markdownRenderer";
import { layoutTable } from "./terminalModel";

const CwdContext = createContext<string | undefined>(undefined);
/** Cells the markdown has across (the terminal's columns less the bullet gutter); tables fit in it. */
export const TermColumnsContext = createContext<number>(Infinity);

const CONTAINERS = new Set(["blockquote", "li", "ul", "ol", "div", "details", "section"]);

/**
 * Marks a block that starts on the line right after the previous block ends (no empty line in
 * the source). Measured: the CLI keeps such blocks together ("Sources:" right above its list) and
 * puts one empty line where the source had one.
 */
export function rehypeTightBlocks() {
  return (tree: Root) => {
    const visit = (parent: Parents) => {
      let prev: Element | null = null;
      for (const child of parent.children) {
        if (child.type !== "element") continue;
        const end = prev?.position?.end.line;
        const start = child.position?.start.line;
        if (end !== undefined && start !== undefined && start - end <= 1) child.properties = { ...child.properties, dataTight: "" };
        prev = child;
        if (CONTAINERS.has(child.tagName)) visit(child);
      }
    };
    visit(tree);
  };
}

/** " term-tight" for a block the source wrote right under the previous one. */
function tight(node: { properties?: Record<string, unknown> } | undefined): string {
  return node?.properties?.dataTight != null ? " term-tight" : "";
}

function metaTarget(meta: MarkdownFileLinkMeta, cwd: string | undefined): FileTarget {
  return {
    path: meta.filePath.replace(/[\\/]+$/, "") || "/",
    ...(meta.line !== undefined ? { line: meta.line } : {}),
    ...(meta.endLine !== undefined ? { endLine: meta.endLine } : {}),
    ...(meta.workspaceLookupPath && cwd ? { lookup: { lookup: meta.workspaceLookupPath, root: cwd } } : {}),
  };
}

/** A path that opens in the right panel; plain text outside a session view. */
export function TermPath({ target, className, children }: { target: FileTarget; className?: string; children: ReactNode }) {
  const open = useFileOpen();
  if (!open) return <span className={className}>{children}</span>;
  // A span, not a button: a long path wraps inside the line as the CLI's text does.
  const go = () => open(target);
  return (
    <span
      role="link"
      tabIndex={0}
      className={`term-path ${className ?? ""}`}
      title={target.path}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        go();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        go();
      }}
    >
      {children}
    </span>
  );
}

/** List items with their markers as text ("- ", "1. "), as the CLI prints them. */
function TermList({ children, marker, className }: { children: ReactNode; marker: (index: number) => string; className: string }) {
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <div className={`term-md-list${className}`}>
      {items.map((item, i) => (
        <div key={i} className="term-md-li">
          <span className="term-md-marker">{marker(i)}</span>
          <div>{item}</div>
        </div>
      ))}
    </div>
  );
}

function rows(node: unknown): string[][] {
  const out: string[][] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object" || !("children" in n) || !Array.isArray(n.children)) return;
    for (const child of n.children as unknown[]) {
      if (child && typeof child === "object" && (child as { tagName?: string }).tagName === "tr") {
        const cells = ((child as { children: unknown[] }).children ?? []).filter(
          (c) => c && typeof c === "object" && ["th", "td"].includes((c as { tagName?: string }).tagName ?? ""),
        );
        out.push(cells.map((c) => hastPlainTextDeep(c).replace(/\s+/g, " ").trim()));
      } else walk(child);
    }
  };
  walk(node);
  return out;
}

/** Each column's alignment from the GFM delimiter row (the header cells' `align` attribute). */
function columnAlign(node: unknown): Array<"left" | "center" | "right" | null> {
  let first: unknown[] | null = null;
  const find = (n: unknown) => {
    if (first || !n || typeof n !== "object" || !("children" in n) || !Array.isArray(n.children)) return;
    for (const child of n.children as unknown[]) {
      if (child && typeof child === "object" && (child as { tagName?: string }).tagName === "tr") {
        first = (child as { children?: unknown[] }).children ?? [];
        return;
      }
      find(child);
    }
  };
  find(node);
  return ((first ?? []) as unknown[])
    .filter((c) => c && typeof c === "object" && ["th", "td"].includes((c as { tagName?: string }).tagName ?? ""))
    .map((c) => {
      const value = (c as { properties?: { align?: unknown } }).properties?.align;
      return value === "left" || value === "center" || value === "right" ? value : null;
    });
}

const HEADING =({ children, level, node }: { children?: ReactNode; level: number; node?: { properties?: Record<string, unknown> } }) => (
  <div className={`${level === 1 ? "term-md-h1" : "term-md-h"}${tight(node)}`} role="heading" aria-level={level}>
    {children}
  </div>
);

const COMPONENTS: Partial<Components> = {
  h1: ({ children, node }) => <HEADING level={1} node={node}>{children}</HEADING>,
  h2: ({ children, node }) => <HEADING level={2} node={node}>{children}</HEADING>,
  h3: ({ children, node }) => <HEADING level={3} node={node}>{children}</HEADING>,
  h4: ({ children, node }) => <HEADING level={4} node={node}>{children}</HEADING>,
  h5: ({ children, node }) => <HEADING level={5} node={node}>{children}</HEADING>,
  h6: ({ children, node }) => <HEADING level={6} node={node}>{children}</HEADING>,
  p: ({ children, node }) => <div className={`term-md-p${tight(node)}`}>{children}</div>,
  ul: ({ children, node }) => (
    <TermList marker={() => "- "} className={tight(node)}>
      {children}
    </TermList>
  ),
  ol: ({ children, start, node }) => (
    <TermList marker={(i) => `${(start ?? 1) + i}. `} className={tight(node)}>
      {children}
    </TermList>
  ),
  li: ({ children }) => <>{children}</>,
  blockquote: ({ children, node }) => <div className={`term-md-quote${tight(node)}`}>{children}</div>,
  hr: ({ node }) => <div className={`term-md-hr${tight(node)}`} aria-hidden />,
  img: ({ alt }) => <span className="term-dim">[{alt || "image"}]</span>,
  input: ({ checked, type }) => (type === "checkbox" ? <span>{checked ? "[x] " : "[ ] "}</span> : null),
  details: ({ children }) => <div>{children}</div>,
  summary: ({ children }) => <div className="term-bold">{children}</div>,
  table: function TermTable({ node }) {
    const columns = use(TermColumnsContext);
    const laid = layoutTable(rows(node), columns, columnAlign(node));
    if (laid.kind === "box") return <pre className={`term-md-table${tight(node)}`}>{laid.lines.join("\n")}</pre>;
    // Too wide for the screen: the CLI lists each row as "Header: value" lines between rules.
    return (
      <div className={`term-md-records${tight(node)}`}>
        {laid.records.map((record, r) => (
          <Fragment key={r}>
            {r > 0 ? <div className="term-dim">{laid.rule}</div> : null}
            {record.map((field, f) =>
              field.lines.map((line, l) => (
                <div key={`${f}:${l}`}>
                  {l === 0 && field.label ? <b>{`${field.label}:`}</b> : null}
                  {l === 0 && field.label ? ` ${line}` : line}
                </div>
              )),
            )}
          </Fragment>
        ))}
        {laid.more ? (
          <>
            <div className="term-dim">{laid.rule}</div>
            <div>{laid.more}</div>
          </>
        ) : null}
      </div>
    );
  },
  pre: function TermPre({ children, node }) {
    const block = extractCodeBlock(children);
    return <pre className={`term-md-pre${tight(node)}`}>{block ? block.code.replace(/\n$/, "") : nodeToPlainText(children)}</pre>;
  },
  code: function TermCode({ node, children }) {
    const cwd = use(CwdContext);
    const text = nodeToPlainText(children);
    if (node?.properties?.dataInlineCode == null) return <code>{children}</code>;
    const meta = resolveInlineCodeFileLinkMeta(text, cwd, cwd);
    if (meta) {
      return (
        <TermPath target={metaTarget(meta, cwd)} className="term-md-code">
          {text}
        </TermPath>
      );
    }
    return <span className="term-md-code">{children}</span>;
  },
  a: function TermLink({ href, children, node }) {
    const cwd = use(CwdContext);
    const normalized = href ? (rewriteMarkdownFileUriHref(href) ?? href) : "";
    const meta = normalized ? resolveMarkdownFileLinkMeta(normalized, cwd, cwd) : null;
    const label = hastPlainTextDeep(node);
    if (meta) {
      return (
        <TermPath target={metaTarget(meta, cwd)} className="term-md-code">
          {children}
        </TermPath>
      );
    }
    // The CLI prints a link as its text and then the address (measured: "CLI commands (https://…)").
    const same = !href || label === href || label === href.replace(/^mailto:/, "");
    return (
      <>
        <a className="term-md-link" href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
        {same ? null : <span> ({href})</span>}
      </>
    );
  },
};

// Measured: the CLI keeps a single newline inside a paragraph as a line break (command output,
// agent results), so the pipeline is the one with remark-breaks.
const render = createMarkdownRenderer({
  remarkPlugins: CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  rehypePlugins: [...CHAT_MARKDOWN_REHYPE_PLUGINS, rehypeTightBlocks],
  components: COMPONENTS,
  // ChatMarkdown's markdownUrlTransform without its editor links: file paths stay, other
  // addresses go through react-markdown's safe-protocol filter.
  urlTransform: (href) =>
    isWindowsDrivePathHref(href) ? href : (rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href)),
});

export const TerminalMarkdown = memo(function TerminalMarkdown({
  text,
  cwd,
  streaming = false,
}: {
  text: string;
  cwd: string | undefined;
  streaming?: boolean;
}) {
  return (
    <CwdContext value={cwd}>
      {/* Finished text keeps its parse in the shared cache; a streaming one changes every delta. */}
      <div className="term-md">{render(text, !streaming)}</div>
    </CwdContext>
  );
});
