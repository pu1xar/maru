// Markdown for assistant text: marked's lexer (plain JavaScript, so it ships in OTA updates) drawn
// with React Native views. Paragraphs, headings, lists, quotes, code, tables as rows, inline
// emphasis, code, links and file chips. Anything else falls back to its raw text. The rules that
// need no React Native (no strikethrough, block spacing, list markers, a fence's label, color at a
// fraction) are in markdownModel.ts; the chat code colors are in lib/timelineTones.ts.
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Linking, ScrollView, StyleSheet, View, useWindowDimensions, type TextStyle } from "react-native";
import { Text } from "./ui/Text.tsx";
import { useAppearance } from "../appearance.tsx";
import { CheckIcon, CopyIcon, FileIcon, FileTextIcon, FolderIcon, GlobeIcon, WorkflowIcon, WrapTextIcon } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import type { Token, Tokens } from "marked";
import { extractFenceTitle } from "../../../web/src/components/chat/MarkdownFenceTitle.logic.ts";
import { isMermaidLanguage } from "../../../web/src/components/chat/MarkdownMermaid.logic.ts";
import { fenceClosed } from "../mermaid/model.ts";
import { fonts, usePalette, type Palette } from "../theme.ts";
import { type } from "../typography.ts";
import { Press } from "./Press.tsx";
import {
  blockGaps,
  codeLanguage,
  codeMeta,
  decodeEntities,
  inlineCodeBox,
  inlineCodeFitsBox,
  inlineLeafText,
  listGutter,
  listItemGap,
  listMarker,
  markdownLeafStarts,
  tableColumnWidths,
  TABLE_CELL_PAD,
  tildesAsText,
  withAlpha,
  lexMarkdown,
} from "./markdownModel.ts";
import { clampActive, highlightSegments, occurrencesIn } from "../lib/threadFind.ts";
import { inlineImages, messageFiles, type FileChip, type MessageFiles } from "../lib/markdownFiles.ts";
import { addToast } from "../lib/toast.ts";
import { FileImagePreview } from "./FileImage.tsx";
import { chatCode, findPaint, isLightPalette } from "../lib/timelineTones.ts";
import { useFindHighlight } from "./timeline/findHighlight.ts";

const HEADINGS = [type.h1, type.h2, type.h3, type.h4, type.h4, type.h4] as const;

/** A find's paint over the leaves of one message: the query, the active occurrence and where each leaf's count starts. */
interface Hl {
  query: string;
  active: number | null;
  starts: Map<Token, number>;
}

/** What every block of one message reads: colors, the base text, the find's paint, the file chips. */
interface Md {
  p: Palette;
  base: TextStyle;
  hl: Hl | null;
  files: MessageFiles;
  code: ReturnType<typeof chatCode>;
  /** The user's bubble keeps decimal numbers in nested ordered lists. */
  decimalOnly: boolean;
  /** The text column's width, which decides whether inline code can be a box. */
  lineWidth: number;
  /** Inline code's size over the text around it (settings, inline code text size; web --chat-inline-code-ratio). */
  inlineRatio: number;
}

/** The lists a block sits inside, by kind (a nested list's marker depends on it). */
interface Anc {
  ul: number;
  ol: number;
}
const TOP: Anc = { ul: 0, ol: 0 };

/** `text` of `token` with the find's occurrences painted (every one light, the active one strong); plain text without a find. */
function painted(text: string, token: Token, m: Md): ReactNode {
  const hl = m.hl;
  if (!hl) return text;
  const first = hl.starts.get(token);
  if (first === undefined || occurrencesIn(text, hl.query) === 0) return text;
  return highlightSegments(text, hl.query, first, hl.active).map((seg, i) =>
    seg.hit ? (
      <Text key={i} style={findPaint(m.p, seg.active)}>
        {seg.text}
      </Text>
    ) : (
      seg.text
    ),
  );
}

export const Markdown = memo(function Markdown({
  text,
  size,
  color,
  cwd,
  inBubble,
}: {
  text: string;
  size?: number;
  color?: string;
  /** The thread's folder: file paths under it draw as chips. */
  cwd?: string | undefined;
  /** Drawn inside the user's bubble: code takes the bubble's surface and ordered lists stay decimal. */
  inBubble?: boolean;
}) {
  const p = usePalette();
  const find = useFindHighlight();
  const tokens = useMemo(() => {
    try {
      return tildesAsText(lexMarkdown(text));
    } catch {
      return null;
    }
  }, [text]);
  const leaves = useMemo(() => (tokens && find ? markdownLeafStarts(tokens, find.query) : null), [tokens, find?.query]);
  const hl = useMemo<Hl | null>(
    () => (find && leaves ? { query: find.query, active: clampActive(find.active, leaves.total), starts: leaves.starts } : null),
    [find, leaves],
  );
  const files = useMemo(() => messageFiles(text, cwd), [text, cwd]);
  const body = size === undefined ? type.body : { fontSize: size, lineHeight: Math.round(size * 1.6) };
  // Prose is the foreground at 90% (web ChatMarkdown text-foreground/90); a caller's color is used as given.
  const base: TextStyle = { color: color ?? withAlpha(p.text, 0.9), fontSize: body.fontSize, lineHeight: body.lineHeight };
  const code = useMemo(() => chatCode(p, inBubble === true), [p, inBubble]);
  // The column the text runs in: the screen less the conversation's side gutters and a bubble's padding.
  const lineWidth = useWindowDimensions().width - 64;
  const inlineRatio = useAppearance().env.inlineCode;
  const md = useMemo<Md>(
    () => ({ p, base, hl, files, code, decimalOnly: inBubble === true, lineWidth, inlineRatio }),
    [p, base.color, base.fontSize, base.lineHeight, hl, files, code, inBubble, lineWidth, inlineRatio],
  );
  if (!tokens) return <Text style={base} selectable>{text}</Text>;
  return <Blocks tokens={tokens} m={md} anc={TOP} />;
});

/** Blocks one under another with the web's collapsed margins (headings 20 above and 8 below, the rest 10). */
function Blocks({ tokens, m, anc }: { tokens: Token[]; m: Md; anc: Anc }) {
  const blocks = tokens.filter((t) => t.type !== "space");
  const gaps = blockGaps(blocks.map((t) => t.type));
  return (
    <View>
      {blocks.map((t, i) => (
        <View key={i} style={{ marginTop: gaps[i] }}>
          <Block token={t} m={m} anc={anc} />
        </View>
      ))}
    </View>
  );
}

function Block({ token, m, anc }: { token: Token; m: Md; anc: Anc }) {
  const { p, base } = m;
  switch (token.type) {
    case "space":
      return null;
    case "paragraph":
      return (
        <>
          <Text style={base} selectable>{inline((token as Tokens.Paragraph).tokens, m)}</Text>
          <Previews tokens={(token as Tokens.Paragraph).tokens} m={m} />
        </>
      );
    case "heading": {
      const h = token as Tokens.Heading;
      const step = HEADINGS[Math.min(h.depth, 6) - 1] ?? type.h4;
      // h6 is the muted step (index.css), the others the foreground.
      const color = h.depth === 6 ? p.muted : p.text;
      return <Text style={[base, { color, fontSize: step.fontSize, lineHeight: step.lineHeight, fontWeight: "600" }]} selectable>{inline(h.tokens, m)}</Text>;
    }
    case "code": {
      const c = token as Tokens.Code;
      // A closed ```mermaid fence outside the user's bubble offers a diagram (DESIGN.md 7g).
      const diagram = !m.decimalOnly && isMermaidLanguage(codeLanguage(c.lang)) && fenceClosed(c.raw);
      return <CodeBlock code={c.text} info={c.lang} m={m} token={token} diagram={diagram} />;
    }
    case "blockquote": {
      const q = token as Tokens.Blockquote;
      return (
        <View style={{ borderLeftWidth: 2, borderLeftColor: withAlpha(typeof base.color === "string" ? base.color : p.text, 0.35), paddingLeft: 13 }}>
          <Blocks tokens={q.tokens} m={m} anc={anc} />
        </View>
      );
    }
    case "list":
      return <List list={token as Tokens.List} m={m} anc={anc} />;
    case "table":
      return <Table table={token as Tokens.Table} m={m} />;
    case "hr":
      // Dark: the muted text color, light: the border (index.css hr). The margins are the blocks' own.
      return <View style={{ height: 1, backgroundColor: isLightPalette(p) ? p.border : p.muted }} />;
    case "text": {
      const tt = token as Tokens.Text;
      return (
        <>
          <Text style={base} selectable>{tt.tokens ? inline(tt.tokens, m) : painted(tt.text, token, m)}</Text>
          {tt.tokens ? <Previews tokens={tt.tokens} m={m} /> : null}
        </>
      );
    }
    default:
      return <Text style={base} selectable>{painted("raw" in token ? String(token.raw) : "", token, m)}</Text>;
  }
}

/** A list: a marker column (bullets by depth, numbers by depth), the items one under another. */
function List({ list, m, anc }: { list: Tokens.List; m: Md; anc: Anc }) {
  const start = typeof list.start === "number" ? list.start : 1;
  const maxDigits = String(start + list.items.length - 1).length;
  const gutter = listGutter(maxDigits, list.ordered);
  const inner: Anc = list.ordered ? { ul: anc.ul, ol: anc.ol + 1 } : { ul: anc.ul + 1, ol: anc.ol };
  return (
    <View>
      {list.items.map((item, i) => {
        const prev = list.items[i - 1];
        const gap = prev === undefined ? 0 : listItemGap(prev.tokens[prev.tokens.length - 1]?.type, item.tokens[0]?.type);
        const marker = item.task
          ? item.checked ? "☑" : "☐"
          : listMarker({ ordered: list.ordered, number: start + i, ancestors: anc, decimalOnly: m.decimalOnly });
        return (
          <View key={i} style={{ flexDirection: "row", marginTop: gap }}>
            <Text style={[m.base, { width: gutter, textAlign: "right" }]}>{`${marker} `}</Text>
            <View style={{ flex: 1 }}>
              <ItemBlocks tokens={item.tokens} m={m} anc={inner} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** An item's blocks: its own text runs on the item's line, a nested list or code sits 10 under it (web margins). */
function ItemBlocks({ tokens, m, anc }: { tokens: Token[]; m: Md; anc: Anc }) {
  const blocks = tokens.filter((t) => t.type !== "space");
  const gaps = blockGaps(blocks.map((t) => t.type));
  return (
    <View>
      {blocks.map((t, j) => (
        <View key={j} style={{ marginTop: gaps[j] }}>
          {t.type === "text" && (t as Tokens.Text).tokens ? (
            <>
              <Text style={m.base} selectable>{inline((t as Tokens.Text).tokens!, m)}</Text>
              <Previews tokens={(t as Tokens.Text).tokens!} m={m} />
            </>
          ) : (
            <Block token={t} m={m} anc={anc} />
          )}
        </View>
      ))}
    </View>
  );
}

/**
 * A fenced block: a header with the language (or the fence's title with a file icon) and two
 * actions (wrap, copy), then the code. Wrapped by default as on the web; unwrapped it scrolls
 * sideways. The frame, border and text colors are the chat code surface (lib/timelineTones.ts).
 */
function CodeBlock({ code, info, m, token, diagram }: { code: string; info: string | undefined; m: Md; token: Token; diagram: boolean }) {
  const c = m.code;
  const language = codeLanguage(info);
  const title = extractFenceTitle(codeMeta(info));
  const [wrapped, setWrapped] = useState(true);
  const [copied, setCopied] = useState(false);
  const [diagramOpen, setDiagramOpen] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  const text = (
    <Text style={{ color: c.text, fontFamily: fonts.mono, fontSize: type.code.fontSize, lineHeight: type.code.lineHeight }} selectable>{painted(code, token, m)}</Text>
  );
  return (
    <View style={[styles.code, { backgroundColor: c.surface, borderColor: c.border }]}>
      <View style={styles.codeHeader}>
        <View style={styles.codeTitle}>
          {title ? <FileTextIcon size={14} color={c.label} /> : null}
          <Text style={{ flexShrink: 1, color: c.label, fontFamily: fonts.mono, fontSize: type.tiny.fontSize, lineHeight: type.tiny.lineHeight }} numberOfLines={1}>{title ?? language}</Text>
        </View>
        <View style={styles.codeActions}>
          {diagram ? (
            <Press
              onPress={() => setDiagramOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="View diagram"
              hitSlop={10}
              style={styles.codeAction}
            >
              <WorkflowIcon size={12} color={m.p.muted} />
            </Press>
          ) : null}
          <Press
            onPress={() => setWrapped((w) => !w)}
            accessibilityRole="button"
            accessibilityLabel={wrapped ? "Unwrap lines" : "Wrap lines"}
            accessibilityState={{ selected: wrapped }}
            hitSlop={10}
            style={[styles.codeAction, wrapped ? { backgroundColor: c.secondary } : null]}
          >
            <WrapTextIcon size={12} color={wrapped ? c.ink : m.p.muted} />
          </Press>
          <Press
            onPress={() => void Clipboard.setStringAsync(code).then(() => setCopied(true)).catch(() => undefined)}
            accessibilityRole="button"
            accessibilityLabel={copied ? "Copied" : "Copy code"}
            hitSlop={10}
            style={styles.codeAction}
          >
            {copied ? <CheckIcon size={12} color={m.p.muted} /> : <CopyIcon size={12} color={m.p.muted} />}
          </Press>
        </View>
      </View>
      {wrapped ? (
        <View style={styles.codeBody}>{text}</View>
      ) : (
        <ScrollView horizontal contentContainerStyle={styles.codeBody}>{text}</ScrollView>
      )}
      {diagramOpen ? <DiagramSheet source={code} onClose={() => setDiagramOpen(false)} /> : null}
    </View>
  );
}

/**
 * The diagram sheet, loaded when first opened: its module carries the renderer's text (about 0.8 MB),
 * which stays unevaluated until a diagram is asked for.
 */
function DiagramSheet(props: { source: string; onClose: () => void }) {
  const Sheet = (require("./MermaidSheet.tsx") as typeof import("./MermaidSheet.tsx")).default;
  return <Sheet source={props.source} onClose={props.onClose} />;
}

/**
 * Column widths come from the cells (`tableColumnWidths`, the browser's auto layout: each column as wide
 * as its longest content within a minimum and the web's 24rem cap), and every row uses the same list, so
 * the columns line up. A table narrower than the lane fills it; a wider one scrolls sideways. Separators
 * are rows only, the outer columns sit flush with the prose, and the text is one step under the prose
 * (web index.css table: 0.875rem under 15px).
 */
function Table({ table, m }: { table: Tokens.Table; m: Md }) {
  const line = withAlpha(m.p.border, 0.6);
  const [lane, setLane] = useState<number | null>(null);
  const fontSize = (m.base.fontSize ?? type.body.fontSize) - 1;
  const tm = useMemo<Md>(() => ({ ...m, base: { ...m.base, fontSize, lineHeight: Math.round(fontSize * 1.6) } }), [m, fontSize]);
  const widths = useMemo(() => tableColumnWidths(table, fontSize, lane ?? m.lineWidth), [table, fontSize, lane, m.lineWidth]);
  const total = widths.reduce((a, b) => a + b, 0);
  const row = (cells: Tokens.TableCell[], head: boolean, key: number) => (
    <View key={key} style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: line }}>
      {widths.map((w, i) => {
        const c = cells[i];
        return (
          <Text
            key={i}
            style={[
              tm.base,
              {
                width: w,
                paddingVertical: head ? 9 : 7,
                paddingLeft: i === 0 ? 0 : TABLE_CELL_PAD,
                paddingRight: i === widths.length - 1 ? 0 : TABLE_CELL_PAD,
                fontWeight: head ? "600" : "400",
                textAlign: c?.align ?? table.align[i] ?? "left",
              },
            ]}
            selectable
          >
            {c ? inline(c.tokens, tm) : null}
          </Text>
        );
      })}
    </View>
  );
  return (
    <View onLayout={(e) => setLane(e.nativeEvent.layout.width)}>
      <ScrollView horizontal>
        <View style={{ width: total }}>
          {row(table.header, true, -1)}
          {table.rows.map((r, i) => row(r, false, i))}
        </View>
      </ScrollView>
    </View>
  );
}

/** The small pictures a paragraph's file paths name, one under another below it (web MarkdownFileImage). */
function Previews({ tokens, m }: { tokens: Token[]; m: Md }) {
  const images = inlineImages(tokens, m.files, (text) => m.hl !== null && occurrencesIn(text, m.hl.query) > 0);
  return images.map((image) => <FileImagePreview key={image.path} image={image} />);
}

/**
 * A file's icon and name inline, in the medium weight of the web's chip, in the text's own color.
 * A tap copies the path: the app has no file viewer, and a picture's preview opens itself.
 */
function FileChipText({ chip, m }: { chip: FileChip; m: Md }) {
  const color = typeof m.base.color === "string" ? m.base.color : m.p.text;
  return (
    <Text
      style={{ fontWeight: "500", color }}
      onPress={() =>
        void Clipboard.setStringAsync(chip.path)
          .then(() => addToast({ type: "success", title: "Path copied", description: chip.path }))
          .catch(() => undefined)
      }
    >
      {chip.folder ? <FolderIcon size={m.base.fontSize ?? type.body.fontSize} color={color} /> : <FileIcon size={m.base.fontSize ?? type.body.fontSize} color={color} />}
      {` ${chip.label}`}
    </Text>
  );
}

/** Plain text of inline tokens (a link's words). */
function plainText(tokens: Token[]): string {
  return tokens.map((t) => ("tokens" in t && Array.isArray(t.tokens) ? plainText(t.tokens as Token[]) : "text" in t ? String(t.text) : "")).join("");
}

const WEB_LINK = /^(?:https?:)?\/\//i;

/** `inLink`: the tokens are the words of a link, so a path in them stays prose. */
function inline(tokens: Token[], m: Md, inLink = false): ReactNode[] {
  const { p, base } = m;
  return tokens.map((t, i) => {
    switch (t.type) {
      case "strong":
        return <Text key={i} style={{ fontWeight: "700" }}>{inline((t as Tokens.Strong).tokens, m, inLink)}</Text>;
      case "em":
        return <Text key={i} style={{ fontStyle: "italic" }}>{inline((t as Tokens.Em).tokens, m, inLink)}</Text>;
      case "codespan": {
        const leaf = inlineLeafText(t) ?? "";
        // A find paints the code as typed, so a file chip yields to it while the query is in the span.
        const searched = m.hl !== null && occurrencesIn(leaf, m.hl.query) > 0;
        const chip = searched ? null : m.files.forCode((t as Tokens.Codespan).text);
        if (chip) return <FileChipText key={i} chip={chip} m={m} />;
        // The monospace font at the text's size in the web's box (index.css :not(pre) > code): a short
        // span is an inline view with the border, radius and padding; one wider than the line cannot be a view
        // (a view does not wrap), so it stays tinted text with a thin space each side for padding and breaks like
        // prose. The code itself carries no spaces (it read as ' code ' with the box padding on top).
        const size = (m.base.fontSize ?? type.body.fontSize) * m.inlineRatio;
        if (inlineCodeFitsBox(leaf, size, m.lineWidth)) {
          const box = inlineCodeBox(size);
          return (
            <View
              key={i}
              style={{
                backgroundColor: m.code.surface,
                borderColor: m.code.border,
                borderWidth: box.border,
                borderRadius: box.radius,
                paddingHorizontal: box.paddingHorizontal,
                paddingVertical: box.paddingVertical,
                transform: [{ translateY: box.drop }],
              }}
            >
              <Text style={{ color: m.code.ink, fontFamily: fonts.inlineMono, fontSize: size, lineHeight: box.lineHeight }}>{painted(leaf, t, m)}</Text>
            </View>
          );
        }
        return <Text key={i} style={{ backgroundColor: m.code.surface, color: m.code.ink, fontFamily: fonts.inlineMono, ...(m.inlineRatio === 1 ? null : { fontSize: size }) }}>{" "}{painted(leaf, t, m)}{" "}</Text>;
      }
      case "link": {
        const l = t as Tokens.Link;
        const file = m.files.forLink(l.href);
        if (file) {
          const chip = <FileChipText chip={file} m={m} />;
          return m.files.labelsFile(plainText(l.tokens), l.href) ? <Text key={i}>{chip}</Text> : <Text key={i}>{inline(l.tokens, m, true)} {chip}</Text>;
        }
        return (
          <Text key={i} style={{ color: p.info }} onPress={() => void Linking.openURL(l.href).catch(() => undefined)}>
            {WEB_LINK.test(l.href) ? <GlobeIcon size={14} color={p.info} /> : null}
            {WEB_LINK.test(l.href) ? " " : ""}
            {inline(l.tokens, m, true)}
          </Text>
        );
      }
      case "image": {
        // A picture file draws as its chip with the preview below the paragraph, as on the web.
        const chip = m.files.forImage((t as Tokens.Image).href);
        return chip ? <FileChipText key={i} chip={chip} m={m} /> : painted("raw" in t ? String(t.raw) : "", t, m);
      }
      case "br":
        return "\n";
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens) return <Text key={i}>{inline(tt.tokens, m, inLink)}</Text>;
        const decoded = decodeEntities(tt.text);
        // A find paints text as typed, so a bare path yields to it while the query is in the leaf.
        const parts = inLink || (m.hl !== null && occurrencesIn(decoded, m.hl.query) > 0) ? null : m.files.forText(decoded);
        if (!parts) return painted(decoded, t, m);
        return (
          <Text key={i}>
            {parts.map((part, j) => ("chip" in part ? <FileChipText key={j} chip={part.chip} m={m} /> : part.text))}
          </Text>
        );
      }
      case "escape":
        return painted((t as Tokens.Escape).text, t, m);
      default:
        return painted("raw" in t ? String(t.raw) : "", t, m);
    }
  });
}

const styles = StyleSheet.create({
  code: { borderRadius: 8, borderWidth: 1, overflow: "hidden" },
  codeHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingTop: 6, paddingRight: 6, paddingLeft: 12 },
  codeTitle: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
  codeActions: { flexDirection: "row", alignItems: "center", gap: 2 },
  codeAction: { width: 24, height: 24, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  // The pre's own padding (0.8rem 0.9rem), under the header.
  codeBody: { paddingHorizontal: 14, paddingVertical: 13 },
});
