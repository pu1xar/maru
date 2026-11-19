// The settings' previews of the terminal mode (the web's DisplayPanel TerminalPreview and
// TerminalThemeRows ThemePreview): a few lines in the terminal's own font, size and colors, under the
// Monospace font row and the Terminal color set row. They draw inside the same TermRoot the
// terminal mode does, so what they show is what the mode draws.
import { useState, type ReactNode } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { resolveTerminalTokens } from "../../../../web/src/lib/terminalTheme.logic.ts";
import { useAppearance } from "../../appearance.tsx";
import { usePalette } from "../../theme.ts";
import { TermRoot } from "./TermRoot.tsx";
import { Cells, R, T, useTerm } from "./term.tsx";

function Box(props: { label: string; children: ReactNode }) {
  const { prefs } = useAppearance();
  const p = usePalette();
  const [width, setWidth] = useState(0);
  const bg = resolveTerminalTokens(prefs.terminalColorset).bg;
  return (
    <View
      accessibilityLabel={props.label}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      // mt-1 mb-3 rounded-lg border border-border px-3 py-2
      style={[styles.box, { borderColor: p.border, backgroundColor: bg }]}
    >
      <TermRoot font={prefs.monoFont} fontSize={prefs.terminalFontSize} colorset={prefs.terminalColorset} width={width}>
        {props.children}
      </TermRoot>
    </View>
  );
}

/** Two lines under the font row, as T3 puts its font previews. */
export function TerminalFontPreview() {
  return (
    <Box label="Terminal font preview">
      <T>
        <R c="ok">{"⏺"}</R> <R bold>Bash</R>(ls -la)
      </T>
      <T>
        <R c="dim">{"  ⎿  "}</R>English and 한글 on one line 0O1lI
      </T>
    </Box>
  );
}

/**
 * One screen with every color role: the user's row, Claude's answer, a tool call, a diff with an
 * added and a removed line, an error, a warning, the progress line and the mode lines.
 */
export function TerminalThemePreview() {
  return (
    <Box label="Terminal color preview">
      <Lines />
    </Box>
  );
}

function Lines() {
  const { tokens, cellW } = useTerm();
  return (
    <>
      <View style={[styles.row, { backgroundColor: tokens.userBg }]}>
        <Cells n={2}>
          <T c="dim">{"❯ "}</T>
        </Cells>
        <T c="strong" style={styles.fill}>Add a timeout to config.json</T>
      </View>
      <View style={styles.row}>
        <Cells n={2}>
          <T c="claude">{"⏺ "}</T>
        </Cells>
        <T style={styles.fill}>I will create the file and update the value, 한글 is fine too</T>
      </View>
      <View style={styles.row}>
        <Cells n={2}>
          <T c="ok">{"⏺ "}</T>
        </Cells>
        <T style={styles.fill}>
          <R bold>Update</R>(config.json)
        </T>
      </View>
      <T c="dim">{"  ⎿  Added 1 line, removed 1 line"}</T>
      <View style={{ backgroundColor: tokens.delBg }}>
        <T c="code">
          <R style={{ color: tokens.delFg }}>{"  - "}</R>
          {'  "timeout": 30,'}
        </T>
      </View>
      <View style={{ backgroundColor: tokens.addBg }}>
        <T c="code">
          <R style={{ color: tokens.addFg }}>{"  + "}</R>
          {'  "timeout": 60,'}
        </T>
      </View>
      <View style={styles.row}>
        <Cells n={2}>
          <T c="err">{"⏺ "}</T>
        </Cells>
        <T style={styles.fill}>
          <R bold c="err">Error</R>
          <R c="err">: ENOENT no such file</R>
        </T>
      </View>
      <T c="warn">{"⚠ rate limit 82% used"}</T>
      <T>
        <R c="claude">{"✻ Pondering…"}</R> <R c="dim">(12s  ↓ 184 tokens)</R>
      </T>
      <T style={{ paddingRight: cellW }}>
        <R c="accent">{"`inline code`"}</R> <R c="accent">{"link accent"}</R> <R c="plan">{"⏸ plan mode"}</R> <R c="accept">{"⏵⏵ accept edits"}</R>
      </T>
    </>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 4, marginBottom: 12, borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  row: { flexDirection: "row" },
  fill: { flex: 1, minWidth: 0 },
});
