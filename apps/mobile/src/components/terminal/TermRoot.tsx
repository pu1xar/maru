// Gives its children the terminal's environment (term.tsx TermEnv) for a font, a size and a color set:
// the tokens, the grid, and the cell width measured with the font drawn (the web's probe: ten cells
// of the font, drawn out of sight, whose width is ten cells). The columns are what the container's
// width holds. The terminal mode and the settings' previews both draw inside one.
import { useMemo, useState, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import { resolveTerminalTokens } from "../../../../web/src/lib/terminalTheme.logic.ts";
import { terminalCell, type TerminalFontId } from "../../../../web/src/lib/viewMode.logic.ts";
import { TERMINAL_MARGIN, columnsFor, terminalGrid } from "../../lib/terminalView.logic.ts";
import { Text } from "../ui/Text.tsx";
import { TermProvider, useBaseStyle, type TermEnv } from "./term.tsx";

export function TermRoot(props: {
  font: TerminalFontId;
  fontSize: number;
  colorset: string;
  /** The container's width (dp), measured by its owner; the columns are what it holds inside the profile's side margins. */
  width: number;
  children: ReactNode;
}) {
  const tokens = useMemo(() => resolveTerminalTokens(props.colorset), [props.colorset]);
  const grid = useMemo(() => terminalGrid(props.font, props.fontSize), [props.font, props.fontSize]);
  // The cell the iTerm formula gives (Bon fonts), else the glyph advance of a monospace font (about 0.6 em) until the probe measures it.
  const guess = terminalCell(props.font, props.fontSize).width || props.fontSize * 0.6;
  const gridKey = `${props.font}:${props.fontSize}`;
  const [measured, setMeasured] = useState<{ key: string; tenCells: number } | null>(null);
  const tenCells = measured?.key === gridKey ? measured.tenCells : null;
  const cellW = tenCells !== null ? tenCells / 10 : guess + grid.letterSpacing;
  const columns = columnsFor(props.width - 2 * TERMINAL_MARGIN.x, tenCells ?? 10 * cellW);
  const env = useMemo<TermEnv>(() => ({ tokens, grid, cellW, columns }), [tokens, grid, cellW, columns]);
  return (
    <TermProvider value={env}>
      <Probe onMeasure={(w) => setMeasured({ key: gridKey, tenCells: w })} />
      {props.children}
    </TermProvider>
  );
}

/** Ten cells of the terminal font, drawn out of sight. */
function Probe(props: { onMeasure: (tenCells: number) => void }) {
  const base = useBaseStyle();
  return (
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[base, styles.probe]}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        if (w > 0) props.onMeasure(w);
      }}
    >
      0000000000
    </Text>
  );
}

const styles = StyleSheet.create({
  probe: { position: "absolute", opacity: 0, left: 0, top: 0 },
});
