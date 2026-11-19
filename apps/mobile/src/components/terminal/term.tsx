// What every part of the terminal mode shares (DESIGN.md 6i): the color set's tokens (web
// terminalTheme.logic.ts, the `.term-*` colors), the font's grid (row height, glyph spacing) and the
// measured cell width, plus the text primitives that draw a run in the terminal font at exactly the
// grid's size (the UI scale does not reach it, appearance.logic.ts TERMINAL_FAMILY). A terminal row is
// one line of cells: prefixes are a whole number of cells wide, rules are one row with a 1px line.
import { createContext, use, useMemo, type ComponentProps, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { Text, TextInput } from "../ui/Text.tsx";
import type { TerminalTokens } from "../../../../web/src/lib/terminalTheme.logic.ts";
import { TERMINAL_FAMILY } from "../../lib/appearance.logic.ts";
import type { TerminalGrid } from "../../lib/terminalView.logic.ts";

/** A color role of the terminal: the web's `.term-<role>` classes. */
export type Role =
  | "fg"
  | "strong"
  | "dim"
  | "rule"
  | "subtle"
  | "ok"
  | "err"
  | "warn"
  | "accent"
  | "plan"
  | "accept"
  | "claude"
  | "shimmer"
  | "code"
  | "codeFaint";

export interface TermEnv {
  tokens: TerminalTokens;
  grid: TerminalGrid;
  /** One cell's width (dp), measured with the font drawn (the web's probe). */
  cellW: number;
  /** Terminal width in cells. */
  columns: number;
}

const TermCtx = createContext<TermEnv | null>(null);

export function TermProvider(props: { value: TermEnv; children: ReactNode }) {
  return <TermCtx value={props.value}>{props.children}</TermCtx>;
}

export function useTerm(): TermEnv {
  const v = use(TermCtx);
  if (!v) throw new Error("TermProvider is missing");
  return v;
}

export function roleColor(tokens: TerminalTokens, role: Role): string {
  switch (role) {
    case "fg":
      return tokens.fg;
    case "strong":
      return tokens.fgStrong;
    case "dim":
      return tokens.dim;
    case "rule":
      return tokens.rule;
    case "subtle":
      return tokens.subtle;
    case "ok":
      return tokens.ok;
    case "err":
      return tokens.err;
    case "warn":
      return tokens.warn;
    case "accent":
      return tokens.accent;
    case "plan":
      return tokens.plan;
    case "accept":
      return tokens.accept;
    case "claude":
      return tokens.claude;
    case "shimmer":
      return tokens.shimmer;
    case "code":
      return tokens.code;
    case "codeFaint":
      return tokens.codeFaint;
  }
}

/** The style of one terminal row's text: the font at the grid's size and row height. */
export function useBaseStyle(): TextStyle {
  const { grid, tokens } = useTerm();
  const role = use(RoleCtx);
  return useMemo(
    () => ({
      fontFamily: TERMINAL_FAMILY,
      fontSize: grid.fontSize,
      lineHeight: grid.lineHeight,
      letterSpacing: grid.letterSpacing,
      color: roleColor(tokens, role),
      // Ligatures and contextual forms off, as the web root's font-feature-settings.
      fontVariant: [],
    }),
    [grid, tokens, role],
  );
}

const RoleCtx = createContext<Role>("fg");

/** Text inside takes this role as its default color (the user line's text is the strong color, a queued message's the dim one). */
export function TextRole(props: { role: Role; children: ReactNode }) {
  return <RoleCtx value={props.role}>{props.children}</RoleCtx>;
}

export interface RunProps {
  /** Color role; the default is the terminal's text color. */
  c?: Role | undefined;
  bold?: boolean | undefined;
  italic?: boolean | undefined;
  underline?: boolean | undefined;
  strike?: boolean | undefined;
  children?: ReactNode;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number | undefined;
  selectable?: boolean | undefined;
  /** Makes a run tappable (a link). */
  onPress?: (() => void) | undefined;
}

const SelectableCtx = createContext(false);

/** Text inside can be selected and copied by a long press (the web's text selection); a row that has its own long press stays off it. */
export function Selectable(props: { on: boolean; children: ReactNode }) {
  return <SelectableCtx value={props.on}>{props.children}</SelectableCtx>;
}

/** A block of text in the terminal font (a row, or several wrapped ones). */
export function T(props: RunProps) {
  const { tokens } = useTerm();
  const base = useBaseStyle();
  const selectable = use(SelectableCtx);
  return (
    <Text
      numberOfLines={props.numberOfLines}
      selectable={props.selectable ?? selectable}
      style={[base, runStyle(tokens, props, true), props.style]}
    >
      {props.children}
    </Text>
  );
}

/** A styled run inside a T (nested text keeps the parent's size and row height). */
export function R(props: RunProps) {
  const { tokens } = useTerm();
  return (
    <Text onPress={props.onPress} style={[{ fontFamily: TERMINAL_FAMILY }, runStyle(tokens, props, false), props.style]}>
      {props.children}
    </Text>
  );
}

function runStyle(tokens: TerminalTokens, p: RunProps, own: boolean): TextStyle {
  const style: { -readonly [K in keyof TextStyle]: TextStyle[K] } = {};
  if (p.c) style.color = roleColor(tokens, p.c);
  if (p.bold) {
    style.fontWeight = "bold";
    // iTerm draws bold text of the default color in the profile's bold color; a run inside colored text keeps that color.
    if (!p.c && own) style.color = tokens.bold;
  }
  if (p.italic) style.fontStyle = "italic";
  const lines = [p.underline ? "underline" : null, p.strike ? "line-through" : null].filter(Boolean);
  if (lines.length > 0) style.textDecorationLine = lines.join(" ") as TextStyle["textDecorationLine"];
  return style;
}

/** The terminal's text input: the terminal font, the text color, the cursor color of the set. */
export function TermInput(props: ComponentProps<typeof TextInput>) {
  const { tokens } = useTerm();
  const base = useBaseStyle();
  return (
    <TextInput
      {...props}
      placeholderTextColor={tokens.dim}
      cursorColor={tokens.cursor}
      selectionColor={tokens.selectionBg}
      style={[base, styles.input, props.style]}
    />
  );
}

/** `n` cells wide, for a prefix such as "⏺ " or "  ⎿  ": the glyphs sit at the left of their cells. */
export function Cells(props: { n: number; children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { cellW } = useTerm();
  return <View style={[{ width: props.n * cellW }, props.style]}>{props.children}</View>;
}

/** A glyph prefix row: `n` cells for the mark (a role color), then the body that wraps under itself. */
export function Prefixed(props: { n: number; mark: string; role?: Role | undefined; bold?: boolean | undefined; children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.row, props.style]}>
      <Cells n={props.n}>
        <T c={props.role ?? "dim"} bold={props.bold}>{props.mark}</T>
      </Cells>
      <View style={styles.fill}>{props.children}</View>
    </View>
  );
}

/** A tappable text button in the terminal's own style: `[label]`, 44dp tall for a finger (the CLI's keys have no touch counterpart without one). */
export function TermButton(props: { label: string; onPress: () => void; disabled?: boolean; accessibilityLabel?: string; role?: "dim" | "accent" | "err" }) {
  const { grid } = useTerm();
  const pad = Math.max(0, (44 - grid.lineHeight) / 2);
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      style={{ paddingVertical: pad, paddingRight: 8, opacity: props.disabled ? 0.5 : 1 }}
    >
      <T c={props.role ?? "dim"} underline>{`[${props.label}]`}</T>
    </Pressable>
  );
}

/** One text row's height with a 1px line through its middle: the CLI's "─" rule (index.css .term-rule). */
export function Rule(props: { role?: Role }) {
  const { tokens, grid } = useTerm();
  return (
    <View style={{ height: grid.lineHeight, justifyContent: "center" }}>
      <View style={{ height: 1, backgroundColor: roleColor(tokens, props.role ?? "rule") }} />
    </View>
  );
}

/** An empty line. */
export function Blank() {
  const { grid } = useTerm();
  return <View style={{ height: grid.lineHeight }} />;
}

export const termStyles = StyleSheet.create({
  row: { flexDirection: "row" },
  fill: { flex: 1, minWidth: 0 },
});

const styles = StyleSheet.create({
  row: { flexDirection: "row" },
  fill: { flex: 1, minWidth: 0 },
  // A multiline field with no padding or border of its own; the row height is the font's.
  input: { padding: 0, margin: 0, textAlignVertical: "top" },
});
