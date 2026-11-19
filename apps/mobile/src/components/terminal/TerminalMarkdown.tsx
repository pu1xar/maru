// Markdown in the terminal mode, drawn from terminalMarkdown.logic.ts (the web's
// TerminalMarkdown.tsx counterpart): bold text without marks, inline code in the accent color,
// "- " and "1. " markers, code without fences, box tables, a bar before a quote. One empty line
// separates blocks unless the source wrote them on adjoining lines (tight).
import { memo, useMemo } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { listMarker, terminalMarkdownBlocks, type TermMdBlock, type TermSpan } from "../../lib/terminalMarkdown.logic.ts";
import { R, T, roleColor, useTerm } from "./term.tsx";

function Spans({ spans }: { spans: readonly TermSpan[] }) {
  return (
    <>
      {spans.map((s, i) => {
        const href = s.link;
        return (
          <R
            key={i}
            bold={s.bold}
            italic={s.italic}
            underline={s.underline || href !== undefined}
            // Bold text of the default color is the profile's bold color; code is the accent; a link opens in the phone's browser.
            c={s.code ? "accent" : s.dim ? "dim" : s.bold ? "strong" : undefined}
            onPress={href ? () => void Linking.openURL(href).catch(() => undefined) : undefined}
          >
            {s.t}
          </R>
        );
      })}
    </>
  );
}

function BlockView({ block, italic }: { block: TermMdBlock; italic?: boolean }) {
  const { tokens, cellW } = useTerm();
  switch (block.k) {
    case "heading":
      return (
        <T bold italic={italic}>
          <Spans spans={block.spans} />
        </T>
      );
    case "p":
      return (
        <T italic={italic}>
          <Spans spans={block.spans} />
        </T>
      );
    case "pre":
      return <T italic={italic}>{block.text}</T>;
    case "hr":
      return <View style={{ height: 1, backgroundColor: roleColor(tokens, "subtle") }} />;
    case "quote":
      return (
        <View style={{ borderLeftWidth: Math.max(1, 0.25 * cellW), borderLeftColor: tokens.dim, paddingLeft: 1.75 * cellW }}>
          <Blocks blocks={block.blocks} italic />
        </View>
      );
    case "table": {
      const layout = block.layout;
      if (layout.kind === "box") return <T>{layout.lines.join("\n")}</T>;
      // Too wide for the screen: the CLI lists each row as "Header: value" lines between rules.
      return (
        <View>
          {layout.records.map((record, r) => (
            <View key={r}>
              {r > 0 ? <T c="dim">{layout.rule}</T> : null}
              {record.map((field, f) =>
                field.lines.map((line, l) => (
                  <T key={`${f}:${l}`}>
                    {l === 0 && field.label ? <R bold>{`${field.label}:`}</R> : null}
                    {l === 0 && field.label ? ` ${line}` : line}
                  </T>
                )),
              )}
            </View>
          ))}
          {layout.more ? (
            <>
              <T c="dim">{layout.rule}</T>
              <T>{layout.more}</T>
            </>
          ) : null}
        </View>
      );
    }
    case "list":
      return (
        <View>
          {block.items.map((item, i) => (
            <View key={i} style={styles.row}>
              <T>{listMarker(block.ordered, block.start, i)}</T>
              <View style={styles.fill}>
                <Blocks blocks={item} italic={italic} />
              </View>
            </View>
          ))}
        </View>
      );
  }
}

function Blocks({ blocks, italic }: { blocks: readonly TermMdBlock[]; italic?: boolean }) {
  const { grid } = useTerm();
  return (
    <View>
      {blocks.map((b, i) => (
        // Measured: the CLI keeps blocks on adjoining source lines together and puts one empty line where the source had one.
        <View key={i} style={{ marginTop: i > 0 && !b.tight ? grid.lineHeight : 0 }}>
          <BlockView block={b} italic={italic} />
        </View>
      ))}
    </View>
  );
}

export const TerminalMarkdown = memo(function TerminalMarkdown({ text, columns }: { text: string; columns: number }) {
  const blocks = useMemo(() => terminalMarkdownBlocks(text, columns), [text, columns]);
  return <Blocks blocks={blocks} />;
});

const styles = StyleSheet.create({
  row: { flexDirection: "row" },
  fill: { flex: 1, minWidth: 0 },
});
