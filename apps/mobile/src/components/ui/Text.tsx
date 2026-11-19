// The app's Text and TextInput: React Native's, with the display settings applied (appearance.tsx):
// the UI scale and the conversation's or the drawer's own factor on the sizes, and the chosen font's
// face for the style's weight. Every screen draws text through these two (textOutsideUi.test.ts keeps
// it so); a style with no size or family reads as React Native's own.
import { use, type ComponentProps } from "react";
import { StyleSheet, Text as RNText, TextInput as RNTextInput, type TextProps } from "react-native";
import { NestedTextCtx, useAppearance, useTextScope } from "../../appearance.tsx";
import { resolveTextStyle } from "../../lib/appearance.logic.ts";

export function Text(props: TextProps) {
  const { env } = useAppearance();
  const scope = useTextScope();
  const nested = use(NestedTextCtx);
  const style = resolveTextStyle(StyleSheet.flatten(props.style) as Record<string, unknown> | undefined, { nested, scope }, env);
  const text = <RNText {...props} style={style} />;
  // Only a Text with other elements inside can have a Text inside it.
  return typeof props.children === "string" || typeof props.children === "number" ? text : <NestedTextCtx value>{text}</NestedTextCtx>;
}

export function TextInput(props: ComponentProps<typeof RNTextInput>) {
  const { env } = useAppearance();
  const style = resolveTextStyle(StyleSheet.flatten(props.style) as Record<string, unknown> | undefined, { nested: false, scope: "ui" }, env);
  return <RNTextInput {...props} style={style} />;
}
